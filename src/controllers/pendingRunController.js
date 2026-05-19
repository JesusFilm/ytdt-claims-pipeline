const { getPendingRun, savePendingRun, clearPendingRun } = require('../lib/pendingRun');
const { notifyClaimsStaged } = require('../lib/slackNotifier');

async function getPending(req, res) {
  try {
    const run = await getPendingRun();
    res.json({ pendingRun: run || null });
  } catch (err) {
    console.error('Get pending run error:', err);
    res.status(500).json({ error: 'Failed to get pending run' });
  }
}

async function savePending(req, res) {
  try {
    const claims = {
      matter_entertainment: req.files?.claims_matter_entertainment?.[0]?.path || null,
      matter_2: req.files?.claims_matter_2?.[0]?.path || null,
    };
    if (!claims.matter_entertainment && !claims.matter_2) {
      return res.status(400).json({ error: 'At least one claims file is required' });
    }
    await savePendingRun(claims, req.user?.email || 'unknown');
    notifyClaimsStaged(claims, req.user?.email || 'unknown').catch(err => console.error('Slack notify failed:', err));

    res.json({ message: 'Claims saved, awaiting verdicts' });
  } catch (err) {
    console.error('Save pending run error:', err);
    res.status(500).json({ error: 'Failed to save pending run' });
  }
}

async function clearPending(req, res) {
  try {
    await clearPendingRun();
    res.json({ message: 'Pending run cleared' });
  } catch (err) {
    console.error('Clear pending run error:', err);
    res.status(500).json({ error: 'Failed to clear pending run' });
  }
}

module.exports = { getPending, savePending, clearPending };