const { getCurrentPipelineStatus } = require('../pipeline');

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