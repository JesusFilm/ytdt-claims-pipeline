// Enhanced status with pipeline step details
function getStatus(pipelineStatus) {
  return (req, res) => {
    try {
      const enhancedStatus = {
        ...pipelineStatus,
        steps: getPipelineSteps(pipelineStatus.status),
        progress: calculateProgress(pipelineStatus.status),
        uptime: process.uptime()
      };
      
      res.json(enhancedStatus);
    } catch (error) {
      console.error('Status error:', error);
      res.status(500).json({ error: 'Failed to get status' });
    }
  };
}

function getPipelineSteps(currentStatus) {
  const allSteps = [
    'connect_vpn',
    'backup_tables', 
    'process_claims',
    'process_mcn_verdicts',
    'process_jfm_verdicts',
    'export_views',
    'enrich_ml',
    'upload_drive'
  ];
  
  const currentIndex = allSteps.indexOf(currentStatus);
  
  return allSteps.map((step, index) => ({
    id: step,
    name: formatStepName(step),
    status: index < currentIndex ? 'completed' :
            index === currentIndex ? 'running' : 'pending',
    description: getStepDescription(step)
  }));
}

function formatStepName(step) {
  return step
    .replace(/_/g, ' ')
    .replace(/\b\w/g, l => l.toUpperCase());
}

function getStepDescription(step) {
  const descriptions = {
    'connect_vpn': 'Establishing secure connection',
    'backup_tables': 'Creating backup tables',
    'process_claims': 'Importing claims data',
    'process_mcn_verdicts': 'Applying MCN verdicts',
    'process_jfm_verdicts': 'Applying JFM verdicts', 
    'export_views': 'Generating export files',
    'enrich_ml': 'Adding ML predictions',
    'upload_drive': 'Uploading to Google Drive'
  };
  
  return descriptions[step] || 'Processing...';
}

function calculateProgress(currentStatus) {
  const allSteps = [
    'connect_vpn', 'backup_tables', 'process_claims',
    'process_mcn_verdicts', 'process_jfm_verdicts',
    'export_views', 'enrich_ml', 'upload_drive'
  ];
  
  const currentIndex = allSteps.indexOf(currentStatus);
  return currentIndex >= 0 ? Math.round(((currentIndex + 1) / allSteps.length) * 100) : 0;
}

// System health check
function getHealth(req, res) {
  res.json({ 
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: Math.round(process.uptime()),
    memory: {
      used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024)
    },
    version: process.env.npm_package_version || '1.0.0'
  });
}

module.exports = {
  getStatus,
  getHealth
};