const fs = require('fs');

const { ownedVideoIds, identifyCsv } = require('../lib/verdictFiles');

/**
 * Which box each dropped CSV belongs in, so the console can stop asking.
 *
 * The console cannot answer this itself: MCN and JFM verdicts carry the same
 * seven columns, so only the share of video ids we own separates them, and that
 * comparison needs the newest owned_videos.csv, which lives on this machine.
 *
 * The files are read and thrown away. The console keeps them and sends them to
 * /api/run under the fields named here, which leaves that endpoint untouched.
 */
async function classifyUploads(req, res) {
  const uploads = req.files?.verdicts || [];
  if (!uploads.length) {
    return res.status(400).json({ error: 'No files to classify' });
  }

  const owned = ownedVideoIds();
  const results = [];

  for (const upload of uploads) {
    let result;
    try {
      const id = identifyCsv(upload.path, owned);
      result = { name: upload.originalname, ...id };
    } catch (error) {
      // A file we cannot read is one the person must place by hand, not a 500:
      // the other files in the same drop are still worth an answer.
      console.error(`Could not classify ${upload.originalname}:`, error.message);
      result = {
        name: upload.originalname,
        kind: 'unknown', side: null, field: null, rows: null, ratio: null,
        reason: 'the file could not be read as a CSV',
      };
    }
    results.push(result);
    fs.promises.unlink(upload.path).catch(() => {});
  }

  // Two files that land in the same box cannot both be right, and the pipeline
  // would silently import one of them. Hand both back unplaced instead.
  for (const field of ['mcn_verdicts', 'jfm_verdicts']) {
    const claimed = results.filter(r => r.field === field);
    if (claimed.length > 1) {
      for (const r of claimed) {
        r.field = null;
        r.side = 'unsure';
        r.reason = `${claimed.length} files look like ${field.replace('_verdicts', '').toUpperCase()} verdicts`;
      }
    }
  }

  res.json({ ownedVideosAvailable: !!(owned && owned.size), results });
}

module.exports = { classifyUploads };
