const path = require('path');
const fs = require('fs').promises;
const { ObjectId } = require('mongodb');
const { getDatabase } = require('../database');
const { resolveRunExportDir } = require('../lib/utils');


// Download uploaded files
async function downloadUpload(req, res) {
  try {
    const filename = req.params.filename;

    // Security: prevent path traversal
    if (filename.includes('..') || filename.includes('/')) {
      return res.status(400).json({ error: 'Invalid filename' });
    }

    const filePath = path.join(process.cwd(), 'data', 'uploads', filename);

    res.download(filePath, (err) => {
      if (err) {
        console.error('Upload download error:', err);
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
    console.error('Upload download error:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Server error' });
    }
  }
}

// Download exported files
async function downloadExport(req, res) {
  try {

    const runId = req.params.runId;
    const filename = req.params.filename;

    // Security: only allow .csv files and prevent path traversal
    if (!filename.endsWith('.csv') || filename.includes('..')) {
      return res.status(400).json({ error: 'Invalid filename' });
    }

    // Get run from database
    const db = getDatabase();
    const run = await db.collection('pipeline_runs').findOne({ _id: new ObjectId(runId) });
    if (!run) { return res.status(404).json({ error: 'Run not found' }); }    

    // Build file path (legacy-named run folders still resolve)
    const filePath = path.join(resolveRunExportDir(run.startTime), filename);

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

    const runId = req.params.runId;

    // Get run from database
    const db = getDatabase();
    const run = await db.collection('pipeline_runs').findOne({ _id: new ObjectId(runId) });
    if (!run) { return res.status(404).json({ error: 'Run not found' }); }

    // Build folder from run startTime (legacy-named run folders still resolve)
    const exportsDir = resolveRunExportDir(run.startTime);

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
  downloadUpload,
  downloadExport,
  listExports
};