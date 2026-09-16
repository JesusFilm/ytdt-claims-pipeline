const axios = require('axios');
const { ObjectId } = require('mongodb');
const { getDatabase } = require('../database');
const { syncRunState, runPipeline } = require('../pipeline');
const { createAuthedClient } = require('../lib/authtedClient');
const { isClaimsIngestRunning } = require('../jobs/claimsIngest');

// Steps that open the VPN and MySQL connection when restarted on their own
const DB_STEPS = ['enrich_shorts', 'export_views'];


const HISTORY_LIMIT_DEFAULT = 20;
const HISTORY_LIMIT_MAX = 100;

// A run that carried a step filter did only part of the pipeline — most often
// scoring the current unprocessed claims without importing anything. It looks
// identical to a full run otherwise, so say which it was.
function runMode(run) {
  const steps = run.options?.steps;
  if (!Array.isArray(steps) || !steps.length) return 'full';
  return steps.includes('process_claims_matter_2') ||
    steps.includes('process_claims_matter_entertainment')
    ? 'partial'
    : 'scoring';
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[mid - 1] + sorted[mid]) / 2)
    : sorted[mid];
}

// The daily ingest is not a pipeline run and has no steps, but it is the thing
// that now brings claims in, so history is incomplete without it.
function formatIngest(doc) {
  const started = doc.startedAt;
  const ended = doc.endedAt;
  return {
    id: doc._id.toString(),
    kind: 'ingest',
    startTime: started,
    endTime: ended || null,
    status: doc.status,
    trigger: doc.trigger || null,
    duration: started && ended ? new Date(ended) - new Date(started) : undefined,
    authRequired: !!doc.authRequired,
    reason: doc.reason || null,
    error: doc.error || null,
    reports: Object.fromEntries(
      Object.entries(doc.reports || {}).map(([source, report]) => [
        source,
        { reportId: report.reportId, startTime: report.startTime, createTime: report.createTime }
      ])
    ),
    results: doc.results || {}
  };
}

// Pipeline runs and daily claims ingests, newest first. `before` pages back
// through both at once; `kind` narrows to one.
async function getHistory(req, res) {
  try {
    const db = getDatabase();

    const limit = Math.min(
      parseInt(req.query.limit) || HISTORY_LIMIT_DEFAULT,
      HISTORY_LIMIT_MAX
    );
    const kind = req.query.kind || 'all';
    const before = req.query.before ? new Date(req.query.before) : null;
    const cursor = before && !isNaN(before.getTime()) ? before : null;

    const runs = kind === 'ingest' ? [] : await db.collection('pipeline_runs')
      .find(cursor ? { startTime: { $lt: cursor } } : {})
      .sort({ startTime: -1 })
      .limit(limit)
      .toArray();

    const ingests = kind === 'pipeline' ? [] : await db.collection('claims_report_ingestions')
      .find(cursor ? { startedAt: { $lt: cursor } } : {})
      .sort({ startedAt: -1 })
      .limit(limit)
      .toArray();

    const formattedRuns = runs.map(run => ({
      id: run._id.toString(),
      kind: 'pipeline',
      mode: runMode(run),
      startTime: run.startTime,
      status: run.status,
      duration: run.duration,
      files: run.files || {},
      results: run.results,
      startedSteps: run.startedSteps || [],
      error: run.error,
    }));
    const formattedIngests = ingests.map(formatIngest);

    // One cursor for two collections: page from the oldest item actually
    // returned, so nothing between the two lists is skipped.
    const times = [...formattedRuns, ...formattedIngests]
      .map(item => item.startTime)
      .filter(Boolean)
      .map(t => new Date(t).getTime());
    const nextBefore = times.length >= limit ? new Date(Math.min(...times)).toISOString() : null;

    // Medians per mode: a scoring-only run takes minutes and a full run tens of
    // minutes, so one median across both describes neither.
    const durationsFor = mode => formattedRuns
      .filter(r => r.status === 'completed' && r.duration && r.mode === mode)
      .map(r => r.duration);

    res.json({
      runs: formattedRuns,
      ingests: formattedIngests,
      nextBefore,
      stats: {
        total: formattedRuns.length,
        successful: formattedRuns.filter(r => r.status === 'completed').length,
        failed: formattedRuns.filter(r => r.status === 'failed').length,
        ingests: {
          total: formattedIngests.length,
          completed: formattedIngests.filter(i => i.status === 'completed').length,
          nothingNew: formattedIngests.filter(i => i.status === 'nothing_new').length,
          failed: formattedIngests.filter(i => i.status === 'failed').length
        },
        medianDuration: {
          full: median(durationsFor('full')),
          scoring: median(durationsFor('scoring')),
          partial: median(durationsFor('partial'))
        }
      }
    });

  } catch (error) {
    console.error('History fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch history' });
  }
}

// Retry a pipeline run
async function retryRun(req, res) {
  try {
    const db = getDatabase();
    const collection = db.collection('pipeline_runs');

    const runId = req.params.id;
    const originalRun = await collection.findOne({ _id: new ObjectId(runId) });

    if (!originalRun) {
      return res.status(404).json({ error: 'Run not found' });
    }

    if (originalRun.status !== 'failed' && originalRun.status !== 'timeout') {
      return res.status(400).json({
        error: 'Can only retry failed or timed out runs'
      });
    }

    if (await isClaimsIngestRunning()) {
      return res.status(409).json({ error: 'Daily claims ingest is running' });
    }

    // Reset the run state
    await collection.updateOne(
      { _id: new ObjectId(runId) },
      {
        $set: {
          status: 'running',
          currentStep: 'starting',
          startedSteps: [],
          error: null,
          endTime: null,
          startTime: new Date()
        }
      }
    );

    setImmediate(() => {
      // Preserve the original step filter, so retrying a scoring-only run does
      // not silently expand into a full pipeline.
      runPipeline(originalRun.files, originalRun.options || {}, runId)
        .catch(error => {
          console.error('Retry pipeline error:', error);
        });
    });

    res.json({
      message: 'Pipeline retry started',
      runId: runId
    });

  } catch (error) {
    console.error('Retry error:', error);
    res.status(500).json({ error: 'Retry failed' });
  }
}

// Stop a pipeline run
async function stopRun(req, res) {
  try {
    const { id } = req.params;
    const db = getDatabase();

    const run = await db.collection('pipeline_runs').findOne({
      _id: new ObjectId(id)
    });

    if (!run) {
      return res.status(404).json({ error: 'Run not found' });
    }

    if (run.status !== 'running') {
      return res.status(400).json({ error: `Cannot stop ${run.status} pipeline` });
    }

    // Stop ML enrichment if running
    const mlTaskId = run.results?.mlEnrichment?.task_id;
    const mlStep = run.startedSteps?.find(s => s.name === 'enrich_ml');
    const shouldStopML = mlTaskId && (!mlStep || mlStep.status === 'running');
    if (shouldStopML && process.env.ML_API_ENDPOINT) {
      try {
        console.log(`Stopping ML task ${mlTaskId}`);
        const mlClient = await createAuthedClient(process.env.ML_API_ENDPOINT, { timeout: 5000 });
        await mlClient.post(`/stop/${mlTaskId}`);
      } catch (mlError) {
        console.error('Failed to stop ML task:', mlError.message);
        // Continue with pipeline stop anyway
      }
    }

    // Update run status
    const stoppedAt = new Date()
    const stoppedStep = run.startedSteps?.find(s => s.status === 'running');
    const stoppedStepName = stoppedStep ? stoppedStep.title || stoppedStep.name : 'unknown step';
    const updateFields = {
      status: 'stopped',
      endTime: stoppedAt,
      duration: Date.now() - new Date(run.startTime).getTime(),
      error: `Pipeline stopped by user at ${stoppedAt.toLocaleTimeString()} while processing: ${stoppedStepName}`
    };

    const runningStepIndex = run.startedSteps?.findIndex(s => s.status === 'running');
    if (runningStepIndex !== -1) {
      updateFields[`startedSteps.${runningStepIndex}.status`] = 'stopped';
    }

    await db.collection('pipeline_runs').updateOne(
      { _id: new ObjectId(id) },
      { $set: updateFields }
    );


    await syncRunState(new ObjectId(id));

    res.json({
      success: true,
      message: 'Pipeline stopped',
      mlTaskStopped: !!mlTaskId
    });

  } catch (error) {
    console.error('Stop run error:', error);
    res.status(500).json({ error: 'Failed to stop pipeline' });
  }
}

// Restart a specific step
async function restartStep(req, res) {
  try {
    const { id: runId, stepName } = req.params;
    const RESTARTABLE_STEPS = ['enrich_shorts', 'export_views', 'enrich_ml', 'upload_drive'];

    // Validate step is restartable
    if (!RESTARTABLE_STEPS.includes(stepName)) {
      return res.status(400).json({
        error: `Step '${stepName}' cannot be restarted. Only ${RESTARTABLE_STEPS.join(', ')} can be restarted individually.`
      });
    }

    const db = getDatabase();
    const run = await db.collection('pipeline_runs').findOne({ _id: new ObjectId(runId) });

    if (!run) {
      return res.status(404).json({ error: 'Run not found' });
    }

    // Check if step exists in this run
    const stepIndex = run.startedSteps?.findIndex(s => s.name === stepName);
    if (stepIndex === -1) {
      return res.status(404).json({ error: `Step '${stepName}' not found in this run` });
    }

    const step = run.startedSteps[stepIndex];
    
    // Only allow restart if step is completed, failed, or error
    if (!['completed', 'failed', 'error', 'running', 'timeout'].includes(step.status)) {
      return res.status(400).json({
        error: `Cannot restart step with status '${step.status}'`
      });
    }

    if (DB_STEPS.includes(stepName) && await isClaimsIngestRunning()) {
      return res.status(409).json({ error: 'Daily claims ingest is running' });
    }

    // Import step runner
    const { runSingleStep } = require('../pipeline');

    // Mark step as running
    await db.collection('pipeline_runs').updateOne(
      { _id: new ObjectId(runId) },
      {
        $set: {
          [`startedSteps.${stepIndex}.status`]: 'running',
          [`startedSteps.${stepIndex}.restarted_at`]: new Date(),
          triggeredBy: { source: 'ui', user: req.user?.email || 'unknown' },
          slackNotified: false // unblock restart notifications
        }
      }
    );

    // Re-fetch so runSingleStep sees the running state
    const freshRun = await db.collection('pipeline_runs').findOne({ _id: new ObjectId(runId) })

    // Run step in background
    setImmediate(() => {
      runSingleStep(runId, stepName, freshRun)
        .catch(error => {
          console.error(`Step restart error (${stepName}):`, error);
        });
    });

    res.json({
      message: `Step '${stepName}' restart initiated`,
      runId: runId,
      stepName: stepName
    });

  } catch (error) {
    console.error('Restart step error:', error);
    res.status(500).json({ error: 'Failed to restart step' });
  }
}


module.exports = {
  getHistory,
  retryRun,
  stopRun,
  restartStep
};