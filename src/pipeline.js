const connectVPN = require('./steps/connect-vpn');
const disconnectVPN = require('./steps/disconnect-vpn');
const validateInputCSVs = require('./steps/validate-input-csvs');
const backupTables = require('./steps/backup-tables');
const processClaims = require('./steps/process-claims');
const enrichShorts = require('./steps/enrich-shorts');
const processVerdicts = require('./steps/process-verdicts');
const exportViews = require('./steps/export-views');
const enrichML = require('./steps/enrich-ml');
const uploadDrive = require('./steps/upload-drive');

const { getDatabase } = require('./database');
const { ObjectId } = require('mongodb');
const { intervalToDuration, formatDuration } = require('date-fns');


const PIPELINE_TIMEOUT_MINUTES = parseInt(process.env.PIPELINE_TIMEOUT_MINUTES) || 60;
function getPipelineSteps(files) {
  return [
    {
      name: 'connect_vpn', fn: connectVPN,
      title: 'Connect VPN',
      description: 'Establishes secure VPN connection to access remote database and services'
    },
    {
      name: 'validate_input_csvs', fn: validateInputCSVs,
      title: 'Validate Input CSVs',
      description: 'Validates uploaded CSV files for required columns and data integrity'
    },
    {
      name: 'backup_tables', fn: backupTables,
      title: 'Backup Tables',
      description: 'Creates backup copies of database tables before processing'
    },
    {
      name: 'process_claims_matter_entertainment',
      fn: (ctx) => processClaims(ctx, 'matter_entertainment'),
      condition: () => !!files.claims?.matter_entertainment,
      title: 'Process Claims (Matter Entertainment)',
      description: 'Imports and processes Matter Entertainment MCN claims'
    },
    {
      name: 'process_claims_matter_2',
      fn: (ctx) => processClaims(ctx, 'matter_2'),
      condition: () => !!files.claims?.matter_2,
      title: 'Process Claims (Matter 2)',
      description: 'Imports and processes Matter 2 MCN claims'
    },
    {
      name: 'enrich_shorts',
      fn: enrichShorts,
      title: 'Enrich Shorts',
      description: 'Detects YouTube Shorts via HEAD request and updates short flag on new claims'
    },
    {
      name: 'process_mcn_verdicts', fn: processVerdicts, condition: () => !!files.mcnVerdicts,
      title: 'Process MCN Verdicts',
      description: 'Imports MCN verdict decisions and updates claim records accordingly'
    },
    {
      name: 'process_jfm_verdicts', fn: processVerdicts, condition: () => !!files.jfmVerdicts,
      title: 'Process JFM Verdicts',
      description: 'Imports JFM verdict decisions and updates video ownership records'
    },
    {
      name: 'export_views', fn: exportViews,
      title: 'Export Views',
      description: 'Generates CSV exports of processed claims, owned videos, and unprocessed data'
    },
    {
      name: 'enrich_ml', fn: enrichML, 
      condition: () => process.env.ML_API_ENDPOINT && process.env.GOOGLE_DRIVE_NAME,
      title: 'Enrich ML',
      description: 'Sends unprocessed claims to ML service for verdict probability predictions'
    },
    {
      name: 'upload_drive', fn: uploadDrive,
      title: 'Upload Drive',
      description: 'Uploads generated exports and ML results to Google Drive for review'
    }
  ];
}

// Main pipeline runner
async function runPipeline(files, options = {}, existingRunId = null, triggeredBy = {}) {
  const context = {
    files,
    options,
    connections: {},
    outputs: {},
    status: 'starting',
    startTime: Date.now()
  };

  let runId = null;

  try {

    // Create initial run record
    const db = getDatabase();
    const collection = db.collection('pipeline_runs');

    const initialRun = {
      status: 'running',
      currentStep: 'starting',
      startedSteps: [],
      files: files,
      triggeredBy, // { source: 'ui' | 'slack', user: 'email or slack name' }
      startTime: new Date(),
      error: null,
      endTime: null
    };

    if (existingRunId) {
      runId = new ObjectId(existingRunId);
      context.runId = runId.toString();

      // Update existing run for retry
      await collection.updateOne(
        { _id: runId },
        { $set: initialRun }
      );

      console.log(`Pipeline retry started with existing ID: ${runId}`);

    } else {
      // Create new run record
      const result = await collection.insertOne(initialRun);
      runId = result.insertedId;
      context.runId = runId.toString();
      console.log(`Pipeline run started with ID: ${runId}`);
    }

    const steps = getPipelineSteps(files);
    for (const step of steps) {

      // Check if pipeline was stopped
      const currentRun = await collection.findOne({ _id: runId });
      if (currentRun.status === 'stopped') {
        console.log('Pipeline stopped by user');
        break;
      }

      // Skip if marked to skip
      if (step.skip) {
        console.log(`Skipping ${step.name} - ${options.testMode ? 'test mode' : 'skipped'}`);
        continue;
      }

      // Skip if condition not met
      if (step.condition && !step.condition()) {
        console.log(`Skipping ${step.name} - no input file`);

        // Update DB with skipped step
        await collection.updateOne(
          { _id: runId },
          {
            $set: { currentStep: step.name },
            $push: {
              startedSteps: {
                name: step.name,
                title: step.title,
                description: step.description,
                status: 'skipped',
                timestamp: new Date()
              }
            }
          }
        );
        continue;
      }

      console.log(`Running ${step.name}...`);

      // Update DB - step starting
      await collection.updateOne(
        { _id: runId },
        { $set: { currentStep: step.name } }
      );

      context.status = step.name;
      const stepStartTime = Date.now();

      try {

        // Run and extract step completion status
        const result = await step.fn(context);
        const status = Object.keys(result || {}).length ? result.status : 'completed'

        // Update DB - step completed
        const stepDuration = Date.now() - stepStartTime;
        await collection.updateOne(
          { _id: runId },
          {
            $push: {
              startedSteps: {
                name: step.name,
                title: step.title,
                description: step.description,
                status,
                timestamp: new Date(),
                duration: stepDuration,
                error: null
              }
            }
          }
        );

        console.log(`✓ ${step.name} ${status}`);
        await syncRunState(runId);

      } catch (stepError) {

        // Update DB - step failed to run
        await collection.updateOne(
          { _id: runId },
          {
            $set: {
              status: 'failed',
              error: stepError.message,
              endTime: new Date()
            },
            $push: {
              startedSteps: {
                name: step.name,
                title: step.title,
                description: step.description,
                status: 'error',
                timestamp: new Date(),
                error: stepError.message
              }
            }
          }
        );
        throw stepError;
      }
    }

    // All steps have started - not necessarily completed
    // TODO: Doesn't really matter now, but should really pick a status ≠ completed
    context.status = 'completed';
    const duration = Date.now() - context.startTime;

    // Update DB - pipeline completed
    await syncRunState(runId, { duration: duration, results: context.outputs });
    console.log(`Pipeline completed in ${Math.round(duration / 1000)}s`);

    return {
      success: true,
      duration,
      outputs: context.outputs,
      runId: runId.toString()
    };

  } catch (error) {
    console.error(`Pipeline failed at ${context.status}:`, error.message);

    // Update DB - pipeline failed
    if (runId) {
      const db = getDatabase();
      const collection = db.collection('pipeline_runs');
      await collection.updateOne(
        { _id: runId },
        {
          $set: {
            status: 'failed',
            error: error.message,
            endTime: new Date(),
            duration: Date.now() - context.startTime
          }
        }
      );
      await syncRunState(runId);
    }

    throw error;

  } finally {
    // Always disconnect VPN
    try {
      await disconnectVPN(context);
    } catch (err) {
      console.error('Failed to disconnect VPN:', err);
    }
  }
}

// Get current pipeline status from MongoDB
async function getCurrentPipelineStatus() {
  try {
    const db = getDatabase();
    const collection = db.collection('pipeline_runs');

    // Find the most recent running pipeline
    const currentRun = await collection
      .findOne(
        {}, // { status: 'running' },
        { sort: { startTime: -1 } }
      );

    if (!currentRun) {
      return {
        running: false,
        status: 'idle',
        currentStep: null,
        progress: 0,
        steps: []
      };
    }

    // Check and handle timeout (only for running pipelines)
    const isRunning = currentRun.status === 'running';
    if (isRunning && checkTimeout(currentRun)) {
      await syncRunState(currentRun._id);
      return { running: false, status: 'timeout', currentStep: null, progress: 0, steps: [] };
    }

    const allSteps = getPipelineSteps({}).map(s => s.name);
    const completedCount = currentRun.startedSteps?.filter(s => s.status === 'completed').length || 0;
    const progress = Math.round((completedCount / allSteps.length) * 100);

    const steps = allSteps.map(stepName => {
      const completed = currentRun.startedSteps?.find(s => s.name === stepName);

      const baseStep = {
        id: stepName,
        name: formatStepName(stepName),
        title: completed?.title || formatStepName(stepName),
        description: completed?.description || ''
      };

      if (completed) {
        return {
          ...baseStep,
          status: completed.status,
          timestamp: completed.timestamp,
          duration: completed.duration,
          error: completed.error
        };
      } else if (isRunning && currentRun.currentStep === stepName) {
        return {
          ...baseStep,
          status: 'running'
        };
      } else {
        return {
          ...baseStep,
          status: 'pending'
        };
      }
    });

    return {
      running: isRunning,
      status: currentRun.status,
      currentStep: currentRun.currentStep,
      progress,
      steps,
      startTime: currentRun.startTime,
      runId: currentRun._id.toString(),
      lastRun: isRunning ? undefined : {
        id: currentRun._id.toString(),
        startTime: currentRun.startTime,
        status: currentRun.status,
        duration: currentRun.duration,
        error: currentRun.error,
        results: currentRun.results
      }
    };

  } catch (error) {
    console.error('Error getting pipeline status:', error);
    return {
      running: false,
      status: 'error',
      error: error.message
    };
  }
}

// State manager - Centralizes all state checks and notifications.
async function syncRunState(runId, completionData = {}) {

  const db = getDatabase();
  const run = await db.collection('pipeline_runs').findOne({ _id: runId });

  if (!run) return;

  const updateFields = {};

  // Add optional completion data if provided
  if (completionData.results) {
    const existingResults = run.results || {};
    updateFields.results = { ...existingResults, ...completionData.results };
  }

  // Check for timeout
  if (run.status === 'running' && checkTimeout(run)) {
    updateFields.status = 'timeout';
    updateFields.error = `Pipeline timed out after ${PIPELINE_TIMEOUT_MINUTES} minutes`;
    updateFields.endTime = new Date();
    updateFields.duration = Date.now() - new Date(run.startTime).getTime();
    console.log(`Pipeline ${runId} timed out after ${PIPELINE_TIMEOUT_MINUTES} minutes`);

    // Update any running steps to timeout status
    if (run.startedSteps) {
      const updatedSteps = run.startedSteps.map(step => {
        if (step.status === 'running') {
          const stepElapsed = Date.now() - new Date(step.timestamp).getTime();
          const duration = intervalToDuration({ start: 0, end: stepElapsed });
          const formatted = formatDuration(duration, { format: ['minutes', 'seconds'] });

          return {
            ...step,
            status: 'timeout',
            duration: stepElapsed,
            error: `Step exceeded ${PIPELINE_TIMEOUT_MINUTES} minute timeout after ${formatted}`
          };
        }
        return step;
      });
      updateFields.startedSteps = updatedSteps;
    }

  }
  // Check if pipeline can be marked complete
  else {
    const hasRunningSteps = run?.startedSteps?.some(step => step.status === 'running');
    const allStepsCompleted = run?.startedSteps?.every(step => ['completed', 'skipped'].includes(step.status));

    // Count how many steps should have run (excluding skipped conditions)
    const allStepNames = getPipelineSteps(run.files || {}).map(s => s.name);
    const startedStepNames = (run.startedSteps || []).map(s => s.name);
    const allStepsStarted = allStepNames.every(name => startedStepNames.includes(name));

    if (!hasRunningSteps && allStepsStarted && allStepsCompleted && run.status !== 'completed') {
      updateFields.status = 'completed';
      updateFields.currentStep = 'completed';
      updateFields.endTime = new Date();
      updateFields.duration = completionData.duration || (Date.now() - new Date(run.startTime).getTime());
      updateFields.error = null;
      console.log('Pipeline marked as completed');

      // Update currentStep to the running step
    } else if (hasRunningSteps) {
      const runningStep = run.startedSteps.find(step => step.status === 'running');
      updateFields.currentStep = runningStep.name;
    }
  }

  // Update DB if we have any fields to set
  if (Object.keys(updateFields).length > 0) {
    await db.collection('pipeline_runs').updateOne(
      { _id: runId },
      { $set: updateFields }
    );
  }

  // Send Slack notification if run reached terminal state and not already notified
  if (process.env.SLACK_BOT_TOKEN && !run.slackNotified) {
    const finalStatus = updateFields.status || run.status;
    if (finalStatus === 'completed' || finalStatus === 'failed' || finalStatus === 'timeout' || finalStatus === 'stopped') {
      try {
        const { sendPipelineNotification } = require('./lib/slackNotifier');
        await sendPipelineNotification(
          runId.toString(),
          finalStatus,
          updateFields.error || run.error,
          updateFields.duration || run.duration,
          run.files,
          run.startTime,
          updateFields.results || run.results,
          run.triggeredBy,
          completionData.stepName || null
        );

        // Mark as notified to prevent duplicates
        await db.collection('pipeline_runs').updateOne(
          { _id: runId },
          { $set: { slackNotified: true } }
        );
      } catch (notifError) {
        console.error('Slack notification failed:', notifError.message);
      }
    }
  }
}

// Check if a running pipeline has exceeded the timeout limit
function checkTimeout(run) {
  const timeoutMs = PIPELINE_TIMEOUT_MINUTES * 60 * 1000;
  const elapsed = Date.now() - new Date(run.startTime).getTime();

  return elapsed > timeoutMs;
}

function formatStepName(stepName) {
  const step = getPipelineSteps({}).find(s => s.name === stepName);
  if (step && step.title) {
    return step.title;
  }
  return stepName
    .replace(/_/g, ' ')
    .replace(/\b\w/g, l => l.toUpperCase());
}

// Run a single step with reconstructed context
async function runSingleStep(runId, stepName, run) {
  const db = getDatabase();
  const mysql = require('mysql2/promise');
  const path = require('path');
  const { generateRunFolderName } = require('./lib/utils');

  const stepMap = {
    enrich_shorts: enrichShorts,
    export_views: exportViews,
    enrich_ml: enrichML,
    upload_drive: uploadDrive
  };

  const stepFn = stepMap[stepName];
  if (!stepFn) {
    throw new Error(`Unknown step: ${stepName}`);
  }

  // Reconstruct context
  const context = {
    files: run.files,
    options: {},
    connections: {},
    outputs: run.results || {},
    status: stepName,
    startTime: new Date(run.startTime).getTime(),
    runId: new ObjectId(runId).toString()
  };

  // Reconnect to MySQL (needed for steps that hit the DB)
  if (stepName === 'export_views' || stepName === 'enrich_shorts') {
    // Ensure VPN is connected first
    const connectVPN = require('./steps/connect-vpn');
    await connectVPN(context);

    context.connections.mysql = await mysql.createPool({
      host: process.env.MYSQL_HOST,
      user: process.env.MYSQL_USER,
      password: process.env.MYSQL_PASSWORD,
      database: process.env.MYSQL_DATABASE,
      waitForConnections: true,
      connectionLimit: 10,
    });
  }

  // Rebuild export paths for enrich_ml and upload_drive
  if (stepName === 'enrich_ml' || stepName === 'upload_drive') {
    const folderName = generateRunFolderName(run.startTime);
    const exportDir = path.join(process.cwd(), 'data', 'exports', folderName);

    // Verify files exist
    const fs = require('fs').promises;
    try {
      await fs.access(exportDir);
    } catch (error) {
      throw new Error(`Export directory not found: ${exportDir}. Cannot restart ${stepName}.`);
    }

    // Rebuild exports metadata if needed
    if (!context.outputs.exports && stepName === 'enrich_ml') {
      context.outputs.exports = {
        export_unprocessed_claims: {
          path: path.join(exportDir, 'unprocessed_claims.csv')
        }
      };
    }
  }

  const stepIndex = run.startedSteps.findIndex(s => s.name === stepName);
  const stepStartTime = Date.now();

  try {
    // Run step
    const result = await stepFn(context);
    const status = Object.keys(result || {}).length ? result.status : 'completed';
    const stepDuration = Date.now() - stepStartTime;

    // Update step status
    await db.collection('pipeline_runs').updateOne(
      { _id: new ObjectId(runId) },
      {
        $set: {
          [`startedSteps.${stepIndex}.status`]: status,
          [`startedSteps.${stepIndex}.duration`]: stepDuration,
          [`startedSteps.${stepIndex}.error`]: null,
          [`startedSteps.${stepIndex}.completed_at`]: new Date()
        }
      }
    );

    // Update results if step produced outputs
    if (result) {
      await db.collection('pipeline_runs').updateOne(
        { _id: new ObjectId(runId) },
        { $set: { [`results.${stepName}`]: result } }
      );
    }

    await syncRunState(new ObjectId(runId), { stepName });
    console.log(`✓ Step ${stepName} restarted successfully`);

  } catch (stepError) {
    // Update step with error
    await db.collection('pipeline_runs').updateOne(
      { _id: new ObjectId(runId) },
      {
        $set: {
          [`startedSteps.${stepIndex}.status`]: 'error',
          [`startedSteps.${stepIndex}.error`]: stepError.message,
          [`startedSteps.${stepIndex}.completed_at`]: new Date()
        }
      }
    );

    await syncRunState(new ObjectId(runId), { stepName });
    throw stepError;

  } finally {
    // Cleanup connections
    if (context.connections.mysql) {
      await context.connections.mysql.end();
      context.connections.mysql = null; // Prevent double-close
    }
    // Disconnect VPN if we connected it 
    if ((stepName === 'export_views' || stepName === 'enrich_shorts') && context.connections.vpnProcess) {
      const disconnectVPN = require('./steps/disconnect-vpn');
      await disconnectVPN(context);
    }
  }
}

module.exports = {
  runPipeline,
  getCurrentPipelineStatus,
  syncRunState,
  checkTimeout,
  runSingleStep
};