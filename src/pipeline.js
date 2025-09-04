const connectVPN = require('./steps/connect-vpn');
const disconnectVPN = require('./steps/disconnect-vpn');
const backupTables = require('./steps/backup-tables');
const processClaims = require('./steps/process-claims');
const processVerdicts = require('./steps/process-verdicts');
const exportViews = require('./steps/export-views');
const enrichML = require('./steps/enrich-ml');
const uploadDrive = require('./steps/upload-drive');


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
    { name: 'enrich_ml', fn: enrichML },
    { name: 'upload_drive', fn: uploadDrive }
  ];

  try {
    for (const step of steps) {
      // Skip if marked to skip
      if (step.skip) {
        console.log(`Skipping ${step.name} - ${options.testMode ? 'test mode' : 'skipped'}`);
        continue;
      }

      // Skip if condition not met
      if (step.condition && !step.condition()) {
        console.log(`Skipping ${step.name} - no input file`);
        continue;
      }

      console.log(`Running ${step.name}...`);
      context.status = step.name;
      
      await step.fn(context);
      
      console.log(`✓ ${step.name} completed`);
    }

    context.status = 'completed';
    const duration = Date.now() - context.startTime;
    
    console.log(`Pipeline completed in ${Math.round(duration/1000)}s`);
    
    return {
      success: true,
      duration,
      outputs: context.outputs
    };

  } catch (error) {
    console.error(`Pipeline failed at ${context.status}:`, error.message);
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

module.exports = { runPipeline };