const connectVPN = require('./steps/connect-vpn');
const disconnectVPN = require('./steps/disconnect-vpn');
const backupTables = require('./steps/backup-tables');
const processClaims = require('./steps/process-claims');
const processVerdicts = require('./steps/process-verdicts');
const exportViews = require('./steps/export-views');
const enrichML = require('./steps/enrich-ml');
const uploadDrive = require('./steps/upload-drive');
const { getDatabase } = require('./database');


// Main pipeline runner
async function runPipeline(files, options = {}) {
  const context = {
    files,
    options,
    connections: {},
    outputs: {},
    status: 'starting',
    startTime: Date.now()
  };

  const steps = [
    { name: 'connect_vpn', fn: connectVPN },
    { name: 'backup_tables', fn: backupTables },
    { name: 'process_claims', fn: processClaims, condition: () => !!files.claims },
    { name: 'process_mcn_verdicts', fn: processVerdicts, condition: () => !!files.mcnVerdicts },
    { name: 'process_jfm_verdicts', fn: processVerdicts, condition: () => !!files.jfmVerdicts },
    { name: 'export_views', fn: exportViews },
    { name: 'enrich_ml', fn: enrichML, condition: () => context.outputs.exports?.export_unprocessed_claims },
    { name: 'upload_drive', fn: uploadDrive }
  ];

  let runId = null;

  try {
    // Create initial run record
    const db = getDatabase();
    const collection = db.collection('pipeline_runs');

    const initialRun = {
      timestamp: new Date(),
      status: 'running',
      currentStep: 'starting',
      startedSteps: [],
      files: files,
      startTime: new Date()
    };

    const result = await collection.insertOne(initialRun);
    runId = result.insertedId;
    context.runId = runId.toString();
    console.log(`Pipeline run started with ID: ${runId}`);

    for (const step of steps) {

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
            $push: { startedSteps: { name: step.name, status: 'skipped', timestamp: new Date() } }
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
                status,
                timestamp: new Date(),
                duration: stepDuration,
                error: null
              }
            }
          }
        );

        console.log(`✓ ${step.name} ${status}`);

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

    context.status = 'completed';
    const duration = Date.now() - context.startTime;

    // Update DB - pipeline completed
    await checkAndUpdateCompletion(runId, {
      duration: duration,
      results: context.outputs
    });

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
        { status: 'running' },
        { sort: { timestamp: -1 } }
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

    const allSteps = [
      'connect_vpn', 'backup_tables', 'process_claims',
      'process_mcn_verdicts', 'process_jfm_verdicts',
      'export_views', 'enrich_ml', 'upload_drive'
    ];

    const completedCount = currentRun.startedSteps?.filter(s => s.status === 'completed').length || 0;
    const progress = Math.round((completedCount / allSteps.length) * 100);

    const steps = allSteps.map(stepName => {
      const completed = currentRun.startedSteps?.find(s => s.name === stepName);

      if (completed) {
        return {
          id: stepName,
          name: formatStepName(stepName),
          status: completed.status,
          timestamp: completed.timestamp,
          duration: completed.duration,
          error: completed.error
        };
      } else if (currentRun.currentStep === stepName) {
        return {
          id: stepName,
          name: formatStepName(stepName),
          status: 'running'
        };
      } else {
        return {
          id: stepName,
          name: formatStepName(stepName),
          status: 'pending'
        };
      }
    });

    return {
      running: true,
      status: currentRun.currentStep || 'running',
      currentStep: currentRun.currentStep,
      progress,
      steps,
      startTime: currentRun.startTime,
      runId: currentRun._id.toString()
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

// Update pipeline run status to 'completed' iff all steps completed 
async function checkAndUpdateCompletion(runId, completionData = {}) {
  const db = getDatabase();

  const run = await db.collection('pipeline_runs').findOne({ _id: runId });
  const hasRunningSteps = run?.startedSteps?.some(step => step.status === 'running');

  if (!hasRunningSteps && run.status === 'running') {
    const updateFields = {
      status: 'completed',
      currentStep: 'completed',
      endTime: new Date()
    };

    // Add optional completion data if provided
    if (completionData.duration) updateFields.duration = completionData.duration;
    if (completionData.results) updateFields.results = completionData.results;

    await db.collection('pipeline_runs').updateOne(
      { _id: runId },
      { $set: updateFields }
    );
    console.log('Pipeline marked as completed');
  }
}

function formatStepName(step) {
  return step
    .replace(/_/g, ' ')
    .replace(/\b\w/g, l => l.toUpperCase());
}

module.exports = { 
  runPipeline, 
  getCurrentPipelineStatus,
  checkAndUpdateCompletion
};