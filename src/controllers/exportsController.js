const path = require('path');
const fs = require('fs').promises;

// Download exported files
function downloadExport(req, res) {
  try {
    const filename = req.params.filename;

    // Security: only allow .csv files and prevent path traversal
    if (!filename.endsWith('.csv') || filename.includes('..')) {
      return res.status(400).json({ error: 'Invalid filename' });
    }

    const filePath = path.join(process.cwd(), 'data', 'exports', filename);

    res.download(filePath, (err) => {
      if (err) {
        console.error('Download error:', err);
        if (!res.headersSent) {
          if (err.code === 'ENOENT') {
            res.status(404).json({ error: 'File not found' });
          } else {
            res.status(500).json({ error: 'Download failed' });
          }
        }
      }
    });

  } catch (error) {
    console.error('Export download error:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Server error' });
    }
  }
}

// List available export files
async function listExports(req, res) {
  try {
    const exportsDir = path.join(process.cwd(), 'data', 'exports');

    const files = await fs.readdir(exportsDir);
    const csvFiles = files
      .filter(file => file.endsWith('.csv'))
      .map(async (file) => {
        const filePath = path.join(exportsDir, file);
        const stats = await fs.stat(filePath);
        return {
          name: file,
          size: stats.size,
          created: stats.birthtime,
          modified: stats.mtime
        };
      });

    const fileList = await Promise.all(csvFiles);

    res.json({
      files: fileList.sort((a, b) => b.modified - a.modified)
    });

  } catch (error) {
    console.error('List exports error:', error);
    res.status(500).json({ error: 'Failed to list exports' });
  }
}

module.exports = {
  downloadExport,
  listExports
};