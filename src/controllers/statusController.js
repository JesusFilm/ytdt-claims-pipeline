
const { ObjectId } = require('mongodb');
const axios = require('axios');
const { execSync } = require('child_process')
const os = require('os');
const path = require('path');
const fs = require('fs');


const { createAuthedClient } = require('../lib/authtedClient.js');
const { generateRunFolderName, resolveRunExportDir } = require('../lib/utils');
const { raiseAlert, clearAlert } = require('../lib/serviceAlerts');

// One key for both Drive paths — the step and the ML webhook — so a single
// outage produces a single message rather than one per writer.
const DRIVE_ALERT = 'drive-upload';
const { getRunFolderId, uploadFile } = require('../lib/driveUpload');
const { getCurrentPipelineStatus, syncRunState } = require('../pipeline');
const { getDatabase } = require('../database');
const claimsIngest = require('../jobs/claimsIngest');
const mirror = require('../jobs/mirrorMysqlToBq');


const GIT_BRANCH = (() => { try { return execSync('git rev-parse --abbrev-ref HEAD').toString().trim() } catch { return 'unknown' } })()
const GIT_COMMIT = (() => { try { return execSync('git rev-parse --short HEAD').toString().trim() } catch { return 'unknown' } })()



// A scheduler holds its next run in a setTimeout, nowhere readable. Both use
// the same rule — a fixed HH:MM UTC — so recompute it from the same config
// rather than tracking state that could drift from what actually fires.
function describeSchedule(name, enabledVar, timeVar, defaultTime, msUntilUtc) {
  const enabled = ['true', '1'].includes(process.env[enabledVar]);
  const time = process.env[timeVar] || defaultTime;
  const valid = /^([01]\d|2[0-3]):[0-5]\d$/.test(time);
  return {
    name,
    enabled,
    time_utc: valid ? time : null,
    next_run: enabled && valid ? new Date(Date.now() + msUntilUtc(time)).toISOString() : null,
  };
}

// Free space where the pipeline writes its run folders. A full disk stops an
// ingest in a way nothing else on this page would show.
async function diskFree(target) {
  try {
    const stats = await fs.promises.statfs(target);
    return {
      free_gb: Math.round((stats.bsize * stats.bfree) / 1e9),
      total_gb: Math.round((stats.bsize * stats.blocks) / 1e9),
    };
  } catch {
    return null;
  }
}

// Enhanced status with pipeline step details from MongoDB
function getStatus(pipelineStatus) {
  return async (req, res) => {
    try {
      // Get real status from MongoDB instead of in-memory object
      const dbStatus = await getCurrentPipelineStatus();

      const enhancedStatus = {
        ...dbStatus,
        uptime: process.uptime()
      };

      res.json(enhancedStatus);
    } catch (error) {
      console.error('Status error:', error);
      res.status(500).json({ error: 'Failed to get status' });
    }
  };
}

// System health check - both this backend and ML service
function getHealth(req, res) {

  const healthCheck = async () => {
    const health = {
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: Math.round(process.uptime()),
      memory: {
        used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024)
      },
      version: process.env.npm_package_version || '1.0.0',
      branch: GIT_BRANCH,
      commit: GIT_COMMIT,
      // The VM's own uptime, not this process's. A reboot nobody announced
      // shows up here even when the service came back cleanly.
      host_uptime: Math.round(os.uptime()),
      disk: await diskFree(path.resolve(__dirname, '../..')),
      schedules: [
        describeSchedule('Claims ingest', 'CLAIMS_INGEST_ENABLED', 'CLAIMS_INGEST_TIME_UTC', '06:00', claimsIngest.msUntilUtc),
        describeSchedule('MySQL -> BigQuery mirror', 'CLAIMS_MIRROR_ENABLED', 'CLAIMS_MIRROR_TIME_UTC', '03:00', mirror.msUntilUtc),
      ],
    };

    // mongod runs on its own VM, so its uptime is the only restart signal we
    // have for that machine. A health check must not fail because of it.
    try {
      const db = await getDatabase();
      const serverStatus = await db.admin().command({ serverStatus: 1 });
      health.mongo_status = 'healthy';
      health.mongo_uptime = Math.round(serverStatus.uptime);
      health.mongo_version = serverStatus.version;
    } catch (error) {
      health.mongo_status = 'unhealthy';
      health.status = 'degraded';
    }

    if (!process.env.ML_API_ENDPOINT) {
      health.enrich_ml_status = 'disabled';
    } else {
      try {
        const mlClient = await createAuthedClient(process.env.ML_API_ENDPOINT, { timeout: 5000 });
        const mlResponse = await mlClient.get('/health');
        health.enrich_ml_status = 'healthy';
        health.enrich_ml_version = mlResponse.data.version;
        health.enrich_ml_branch = mlResponse.data.branch;
        health.enrich_ml_commit = mlResponse.data.commit;

      } catch (error) {
        health.enrich_ml_status = 'unhealthy';
        health.status = 'degraded';
      }
    }

    return health;
  };

  healthCheck()
    .then(health => res.json(health))
    .catch(error => {
      console.error('Health check failed:', error);
      res.status(500).json({ status: 'error', uptime: 0, memory: { used: 0, total: 0 } });
    });
}

// Save completion result from ML service 
// Update enrich_ml step status to completed (from "running")
async function handleMLWebhook(req, res) {
  try {

    const { task_id, status, error, csv_path, num_results, pipeline_run_id } = req.body;
    console.log(`ML webhook received: '${status}' for task ${task_id}, pipeline_run_id: ${pipeline_run_id}`);

    const db = getDatabase();

    // Find enrich_ml step to calculate duration
    const run = await db.collection('pipeline_runs').findOne({ _id: new ObjectId(pipeline_run_id) });
    const enrichStep = run?.startedSteps?.find(s => s.name === 'enrich_ml');
    const duration = enrichStep?.timestamp ? Date.now() - new Date(enrichStep.timestamp).getTime() : 0;
    // Two different names for the same run: folderName labels the Drive folder
    // ("Oct 13 2026 06:24:06 PM"), while the run's files live in the safe local
    // directory (20261013182406). Writing the scored CSV under the label failed
    // with ENOENT — the directory does not exist — so it never reached Drive.
    const folderName = generateRunFolderName(run.startTime);
    const exportDir = resolveRunExportDir(run.startTime);
    const fileName = `unprocessed_claims_${enrichStep.name}.csv`
    const fullCsvUrl = path.join(process.env.ML_API_ENDPOINT, csv_path);

    // Upload CSV to Drive if successful and Drive is configured
    let driveUpload = null;
    let uploadError_ = null;
    if (status === 'completed' && csv_path && process.env.GOOGLE_DRIVE_NAME) {
      try {

        // Download CSV file from ML service locally
        const mlClient = await createAuthedClient(process.env.ML_API_ENDPOINT);
        const response = await mlClient.get(csv_path, { responseType: 'stream' });

        const tempPath = path.join(exportDir, fileName);
        await fs.promises.mkdir(exportDir, { recursive: true });
        const writer = fs.createWriteStream(tempPath);
        response.data.pipe(writer);
        await new Promise((resolve, reject) => {
          writer.on('finish', resolve);
          writer.on('error', reject);
        });

        // Now upload to Drive
        const folderId = await getRunFolderId(pipeline_run_id, folderName, process.env.GOOGLE_DRIVE_NAME);
        driveUpload = await uploadFile(tempPath, folderId, num_results);
        console.log(`ML result uploaded to Drive: ${driveUpload.path}`);
        await clearAlert(DRIVE_ALERT);

      } catch (uploadError) {
        // Record it: a console.error here left the step green while the file
        // never reached Drive, which is how this went unnoticed.
        uploadError_ = uploadError.message;
        console.error('Drive upload failed:', uploadError.message);
        // Same alert key as the upload_drive step: one Drive outage, one message
        await raiseAlert(DRIVE_ALERT,
          `:file_folder: *Drive upload failed*\n${uploadError.message}\n` +
          `The scored claims CSV was produced but has not reached ` +
          `${process.env.GOOGLE_DRIVE_NAME || 'the shared drive'}, so Ben will not see it.`);
      }
    }

    // Set ML result and mark enrich_ml step as completed
    await db.collection('pipeline_runs').updateOne(
      { _id: new ObjectId(pipeline_run_id) },
      {
        $set: {
          'results.mlEnrichment': {
            task_id,
            status,
            error,
            path: fullCsvUrl,
            rows: num_results,
            name: fileName,
            driveUpload,
            driveUploadError: uploadError_,
            updated_at: new Date(),
          },
          'startedSteps.$[elem].status': 'completed',
          'startedSteps.$[elem].duration': duration
        }
      },
      { arrayFilters: [{ 'elem.name': 'enrich_ml' }] }
    );

    await syncRunState(new ObjectId(pipeline_run_id));
    res.json({ received: true, pipeline_run_id });

  } catch (error) {
    console.error('ML webhook error:', error);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
}


module.exports = {
  getStatus,
  getHealth,
  handleMLWebhook,
};