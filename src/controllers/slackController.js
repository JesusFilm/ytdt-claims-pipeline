const { ObjectId } = require('mongodb');
const { formatTimestamp } = require('../lib/utils');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { getDatabase } = require('../database');
const { runPipeline, getCurrentPipelineStatus } = require('../pipeline');
const { STEPS, getSession, createSession, updateSession, deleteSession, currentStep, stepCount } = require('../lib/slackSession');
const { getPendingRun, clearPendingRun } = require('../lib/pendingRun');
const { classifyCsv, classifyVerdicts, ownedVideoIds, readVideoIds } = require('../lib/verdictFiles');
const { isClaimsIngestRunning, COLLECTION: INGEST_COLLECTION } = require('../jobs/claimsIngest');


const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;

// ─── Helpers ────────────────────────────────────────────────────────────────

async function slackPost(channel, blocks, text = '') {
  return axios.post(
    'https://slack.com/api/chat.postMessage',
    { channel, text, blocks },
    { headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}`, 'Content-Type': 'application/json' } }
  );
}

async function slackUpdate(channel, ts, blocks, text = '') {
  return axios.post(
    'https://slack.com/api/chat.update',
    { channel, ts, text, blocks },
    { headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}`, 'Content-Type': 'application/json' } }
  );
}

function promptBlock(session) {
  const step = currentStep(session);
  const stepNum = session.stepIndex + 1;
  const total = stepCount();
  const collected = Object.keys(session.files).length;
  const collectedLabels = STEPS
    .filter(s => session.files[s.key])
    .map(s => `  • ${s.label}`)
    .join('\n');

  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Step ${stepNum} of ${total}: ${step.label}*\n${step.description}\n\n*Upload the CSV file now*, or choose an option below.${collectedLabels ? `\n\n*Collected so far:*\n${collectedLabels}` : ''}`,
      },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Skip this file' },
          action_id: 'session_skip',
          value: 'skip',
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: '🚫 Cancel' },
          action_id: 'session_cancel',
          value: 'cancel',
          style: 'danger',
        },
      ],
    },
  ];
}

function confirmBlock(session) {
  const collected = STEPS.filter(s => session.files[s.key]).map(s => `  ✅ ${s.label}`);
  const skipped = STEPS.filter(s => !session.files[s.key]).map(s => `  ⏭ ${s.label} _(skipped)_`);
  const lines = [...collected, ...skipped].join('\n');

  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Ready to run the pipeline* 🚀\n\n${lines}\n\nPress *Run Pipeline* to start, or cancel.`,
      },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: '▶ Run Pipeline' },
          action_id: 'session_run',
          value: 'run',
          style: 'primary',
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: '🚫 Cancel' },
          action_id: 'session_cancel',
          value: 'cancel',
          style: 'danger',
        },
      ],
    },
  ];
}

async function downloadSlackFile(url, destPath) {
  const response = await axios.get(url, {
    headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` },
    responseType: 'stream',
    maxRedirects: 5,
  });

  const contentType = response.headers['content-type'] || '';
  if (contentType.includes('text/html')) {
    throw new Error('Slack returned HTML instead of file content — check bot permissions');
  }

  await new Promise((resolve, reject) => {
    const writer = fs.createWriteStream(destPath);
    response.data.pipe(writer);
    writer.on('finish', resolve);
    writer.on('error', reject);
  });
}

function stagedSources(pendingRun) {
  const sources = [];
  if (pendingRun.claims?.matter_entertainment) sources.push('Matter Entertainment');
  if (pendingRun.claims?.matter_2) sources.push('Matter 2');
  return sources;
}

// Which claims the run will use. Said out loud because the two cases look
// identical from Slack: uploaded files, or whatever the daily ingest has loaded.
// Whoever runs this when nobody is around should not have to guess.
async function claimsSourceLine(pendingRun) {
  if (pendingRun) {
    return `📋 *Claims:* staged by ${pendingRun.uploadedBy || 'the data team'} ` +
      `(${stagedSources(pendingRun).join(', ') || 'no sources listed'}), uploaded ${formatTimestamp(pendingRun.uploadedAt)}`;
  }
  let snapshot = null;
  try {
    const last = await getDatabase().collection(INGEST_COLLECTION)
      .findOne({ status: 'completed' }, { sort: { startedAt: -1 } });
    snapshot = Object.values(last?.reports || {}).map(r => r.startTime).sort().slice(-1)[0] || null;
  } catch (error) {
    console.error('slack: could not read the last ingest:', error.message);
  }
  return snapshot
    ? `📋 *Claims:* already collected daily — newest snapshot ${snapshot.slice(0, 10)}`
    : '📋 *Claims:* already collected daily';
}

// ─── Slash command: /run-verdicts ───────────────────────────────────────────

async function handleSlashCommand(req, res) {
  res.json({ response_type: 'ephemeral', text: 'Starting guided upload…' });

  const userId = req.body.user_id;
  const channel = req.body.channel_id;

  // Claims arrive on their own since the daily ingest, so staged claim files are
  // the exception now, not the precondition. Refusing without them stopped the
  // verdicts flow working at all.
  const pendingRun = await getPendingRun();
  const stagedText = await claimsSourceLine(pendingRun);

  const session = await createSession(userId);
  await updateSession(userId, { channel });

  await slackPost(channel, [], stagedText);
  const resp = await slackPost(channel, promptBlock(session), `Step 1 of ${stepCount()}`);
  await updateSession(userId, { channel, promptTs: resp.data.ts });
}

// ─── Events API: file_shared ─────────────────────────────────────────────────

async function handleEvent(req, res) {
  const body = req.body;

  // URL verification challenge (one-time setup)
  if (body.type === 'url_verification') {
    return res.json({ challenge: body.challenge });
  }

  res.sendStatus(200); // Ack immediately

  const event = body.event;
  if (!event) return; // not all Slack payload types include an event (e.g. app_rate_limited)
  if (event.bot_id) return; // ignore bot messages

  if (event.type === 'message' && event.files?.length) {
    handleFileMessage(event).catch(err => console.error('handleFileMessage error:', err));
  }
}

// Files dropped in the channel with no session running. Ben sends the verdicts
// anyway; making him remember a slash command first, then answer which box each
// file belongs in, was friction with no purpose — the files say what they are.
async function handleDroppedFiles(event) {
  const csvFiles = event.files.filter(f => f.name?.endsWith('.csv') || f.mimetype === 'text/csv');
  if (!csvFiles.length) return;

  const channel = event.channel;
  const userId = event.user;
  const uploadDir = path.join(process.cwd(), 'data', 'uploads');
  fs.mkdirSync(uploadDir, { recursive: true });

  const owned = ownedVideoIds();
  const files = {};
  const lines = [];
  const unsure = [];

  for (const file of csvFiles.slice(0, 4)) {
    const destPath = path.join(uploadDir, `slack_${userId}_${Date.now()}_${file.name.replace(/[^\w.-]/g, '_')}`);
    try {
      await downloadSlackFile(file.url_private_download, destPath);
    } catch (err) {
      console.error('Failed to download Slack file:', err.message);
      continue;
    }

    const header = fs.readFileSync(destPath, 'utf8').slice(0, 4096).split('\n')[0];
    const kind = classifyCsv(header);
    if (kind === 'claims') {
      lines.push(`• \`${file.name}\` — a *claims* file. Claims are collected daily now, so this is not needed; ` +
        'upload it in the console only if collection is down.');
      continue;
    }
    if (kind !== 'verdicts') {
      lines.push(`• \`${file.name}\` — not a verdicts file (its columns are neither claims nor verdicts).`);
      continue;
    }

    const videoIds = readVideoIds(destPath);
    const verdict = classifyVerdicts(videoIds, owned);
    const rows = videoIds.length.toLocaleString();
    if (verdict.kind === 'unsure') {
      unsure.push(file.name);
      lines.push(`• \`${file.name}\` — ${rows} verdicts, but whether these are MCN or JFM is unclear` +
        `${verdict.ratio === null ? ` (${verdict.reason})` : ` (${Math.round(verdict.ratio * 100)}% are our own videos)`}.`);
      continue;
    }
    const key = verdict.kind === 'jfm' ? 'jfm_verdicts' : 'mcn_verdicts';
    files[key] = destPath;
    lines.push(`• \`${file.name}\` — *${verdict.kind.toUpperCase()} verdicts*, ${rows} rows ` +
      `(${Math.round(verdict.ratio * 100)}% of these videos are ours).`);
  }

  if (!Object.keys(files).length) {
    lines.push('', 'Nothing to run. Send the verdicts CSV, or use `/run-verdicts` to be guided through it.');
    await slackPost(channel, [], lines.join('\n'));
    return;
  }

  const session = await createSession(userId);
  await updateSession(userId, { channel, files, stepIndex: stepCount() });
  const summary = [`*Verdicts received*`, ...lines, '', await claimsSourceLine(await getPendingRun())];
  if (unsure.length) summary.push(`_Not included: ${unsure.join(', ')} — use \`/run-verdicts\` to place ${unsure.length > 1 ? 'them' : 'it'}._`);

  const resp = await slackPost(channel, [
    { type: 'section', text: { type: 'mrkdwn', text: summary.join('\n') } },
    ...confirmBlock({ ...session, files }).slice(1),
  ], 'Verdicts received');
  await updateSession(userId, { channel, files, stepIndex: stepCount(), promptTs: resp.data.ts });
}

async function handleFileMessage(event) {
  const userId = event.user;
  const session = await getSession(userId);
  if (!session) return handleDroppedFiles(event);

  const file = event.files[0];
  const step = currentStep(session);
  if (!step) {
    // The session has all it needs and is waiting on Run or Cancel. Dropping
    // more files used to land here and return silently — nothing ran, nothing
    // was said, and the files looked ignored. Start again from what was sent.
    await deleteSession(userId);
    if (session.promptTs) {
      await slackUpdate(session.channel, session.promptTs, [], '_Replaced by newer files._');
    }
    return handleDroppedFiles(event);
  }

  // Validate it's a CSV
  if (!file.name?.endsWith('.csv') && file.mimetype !== 'text/csv') {
    await slackPost(session.channel, [], `⚠️ Please upload a CSV file for *${step.label}*.`);
    return;
  }

  // Download to local temp
  const uploadDir = path.join(process.cwd(), 'data', 'uploads');
  fs.mkdirSync(uploadDir, { recursive: true });
  const destPath = path.join(uploadDir, `slack_${userId}_${step.key}_${Date.now()}.csv`);

  try {
    await downloadSlackFile(file.url_private_download, destPath);
  } catch (err) {
    console.error('Failed to download Slack file:', err.message);
    await slackPost(session.channel, [], `❌ Failed to download file. Please try again.`);
    return;
  }

  // Advance session
  const newFiles = { ...session.files, [step.key]: destPath };
  const newStepIndex = session.stepIndex + 1;
  const updatedSession = await updateSession(userId, { files: newFiles, stepIndex: newStepIndex });

  // Clear buttons on previous prompt
  if (session.promptTs) {
    await slackUpdate(session.channel, session.promptTs, [], `_${step.label} — uploaded_`);
  }

  if (newStepIndex >= stepCount()) {
    const resp = await slackPost(session.channel, confirmBlock(updatedSession), 'Ready to run pipeline');
    await updateSession(userId, { promptTs: resp.data.ts });
  } else {
    const resp = await slackPost(session.channel, promptBlock(updatedSession), `Step ${newStepIndex + 1} of ${stepCount()}`);
    await updateSession(userId, { promptTs: resp.data.ts });
  }
}

// ─── Interactions (buttons) ───────────────────────────────────────────────────

async function handleInteraction(req, res) {
  if (!SLACK_SIGNING_SECRET) {
    return res.status(500).json({ error: 'Slack not configured' });
  }

  const payload = JSON.parse(req.body.payload);
  const action = payload.actions[0];
  const userId = payload.user.id;
  const channel = payload.channel.id;

  // Acknowledge immediately
  res.json({ response_type: 'ephemeral', text: 'Got it…' });

  // ── Legacy: rerun pipeline from notification ──
  if (action.action_id === 'rerun_pipeline') {
    const runId = action.value;
    try {
      const db = getDatabase();
      const run = await db.collection('pipeline_runs').findOne({ _id: new ObjectId(runId) });
      if (!run) return;
      if (await isClaimsIngestRunning()) {
        await slackPost(channel, [], '⚠️ The daily claims ingest is running. Try again once it completes.');
        return;
      }
      // Preserve the original step filter (see historyController.retryRun)
      runPipeline(run.files, run.options || {}, runId).catch(err => console.error('Pipeline rerun failed:', err));
    } catch (err) {
      console.error('Interaction error:', err);
    }
    return;
  }

  // ── Guided session actions ──
  const session = await getSession(userId);
  if (!session) return;

  if (action.action_id === 'session_skip') {

    if (session.promptTs) {
      await slackUpdate(session.channel, session.promptTs, [], `_${STEPS[session.stepIndex].label} — skipped_`);
    }

    const newStepIndex = session.stepIndex + 1;
    const updatedSession = await updateSession(userId, { stepIndex: newStepIndex });
    if (newStepIndex >= stepCount()) {
      if (Object.keys(updatedSession.files).length === 0) {
        await slackPost(channel, [], '⚠️ No files were provided. Please start again with `/run-verdicts`.');
        await deleteSession(userId);
      } else {
        await slackPost(channel, confirmBlock(updatedSession), 'Ready to run pipeline');
      }
    } else {
      const resp = await slackPost(channel, promptBlock(updatedSession), `Step ${newStepIndex + 1} of ${stepCount()}`);
      await updateSession(userId, { promptTs: resp.data.ts });
    }
    return;
  }

  if (action.action_id === 'session_cancel') {
    await deleteSession(userId);
    await slackPost(channel, [], '🚫 Pipeline upload cancelled. Run `/run-verdicts` to start again.');
    return;
  }

  if (action.action_id === 'session_run') {

    // Final check: at least one file provided
    if (Object.keys(session.files).length === 0) {
      await slackPost(channel, [], '⚠️ No files were collected. Run `/run-verdicts` to start again.');
      await deleteSession(userId);
      return;
    }

    // Check if pipeline is already running
    const current = await getCurrentPipelineStatus();
    if (current.running) {
      await slackPost(channel, [], '⚠️ A pipeline is already running. Try again once it completes.');
      return;
    }
    if (await isClaimsIngestRunning()) {
      await slackPost(channel, [], '⚠️ The daily claims ingest is running. Try again once it completes.');
      return;
    }

    // Staged claims if someone uploaded them; otherwise the ones the daily
    // ingest already merged into youtube_mcn_claims, which is the normal case.
    const pendingRun = await getPendingRun();
    if (!session.files.mcn_verdicts && !session.files.jfm_verdicts && !pendingRun) {
      await slackPost(channel, [], '_No verdicts uploaded and no claims staged — nothing to run._');
      return;
    }

    // Map session files → pipeline files shape
    const files = {
      claims: pendingRun ? pendingRun.claims : {},
      mcnVerdicts: session.files.mcn_verdicts || null,
      jfmVerdicts: session.files.jfm_verdicts || null,
    };

    // Name the claims again at the point of no return, not only at the start
    const started = `⏳ Pipeline started! You'll get a notification here when it's done.\n` +
      `${await claimsSourceLine(pendingRun)}`;
    if (session.promptTs) {
      await slackUpdate(session.channel, session.promptTs, [], started);
    } else {
      await slackPost(channel, [], started);
    }
    await deleteSession(userId);

    runPipeline(files, {}, null, { source: 'slack', user: payload.user.username || payload.user.id })
      .then(() => (pendingRun ? clearPendingRun() : null))
      .catch(err => console.error('Slack-triggered pipeline failed:', err));
    return;
  }
}

module.exports = { handleSlashCommand, handleEvent, handleInteraction, claimsSourceLine };