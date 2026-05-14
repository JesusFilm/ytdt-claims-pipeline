const { ObjectId } = require('mongodb');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { getDatabase } = require('../database');
const { runPipeline, getCurrentPipelineStatus } = require('../pipeline');
const {
  STEPS, getSession, createSession, updateSession, deleteSession,
  currentStep, stepCount,
} = require('../lib/slackSession');

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
    .map(s => `  ✅ ${s.label}`)
    .join('\n');

  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Step ${stepNum} of ${total}: ${step.label}*\n${step.description}\n\n👆 *Upload the CSV file now*, or choose an option below.${collectedLabels ? `\n\n*Collected so far:*\n${collectedLabels}` : ''}`,
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
  });
  await new Promise((resolve, reject) => {
    const writer = fs.createWriteStream(destPath);
    response.data.pipe(writer);
    writer.on('finish', resolve);
    writer.on('error', reject);
  });
}

// ─── Slash command: /run-pipeline ───────────────────────────────────────────

async function handleSlashCommand(req, res) {
  // Acknowledge immediately (Slack requires <3s response)
  res.json({ response_type: 'ephemeral', text: 'Starting guided upload…' });

  const userId = req.body.user_id;
  const channel = req.body.channel_id;

  const session = await createSession(userId);
  await updateSession(userId, { channel });

  await slackPost(channel, promptBlock(session), `Step 1 of ${stepCount()}`);
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

async function handleFileMessage(event) {
  const userId = event.user;
  const session = await getSession(userId);
  if (!session) return; // No active session for this user — ignore

  const file = event.files[0];
  const step = currentStep(session);
  if (!step) return;

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

  if (newStepIndex >= stepCount()) {
    await slackPost(session.channel, confirmBlock(updatedSession), 'Ready to run pipeline');
  } else {
    await slackPost(session.channel, promptBlock(updatedSession), `Step ${newStepIndex + 1} of ${stepCount()}`);
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
      runPipeline(run.files, {}, runId).catch(err => console.error('Pipeline rerun failed:', err));
    } catch (err) {
      console.error('Interaction error:', err);
    }
    return;
  }

  // ── Guided session actions ──
  const session = await getSession(userId);
  if (!session) return;

  if (action.action_id === 'session_skip') {
    const newStepIndex = session.stepIndex + 1;
    const updatedSession = await updateSession(userId, { stepIndex: newStepIndex });

    if (newStepIndex >= stepCount()) {
      if (Object.keys(updatedSession.files).length === 0) {
        await slackPost(channel, [], '⚠️ No files were provided. Please start again with `/run-pipeline`.');
        await deleteSession(userId);
      } else {
        await slackPost(channel, confirmBlock(updatedSession), 'Ready to run pipeline');
      }
    } else {
      await slackPost(channel, promptBlock(updatedSession), `Step ${newStepIndex + 1} of ${stepCount()}`);
    }
    return;
  }

  if (action.action_id === 'session_cancel') {
    await deleteSession(userId);
    await slackPost(channel, [], '🚫 Pipeline upload cancelled. Run `/run-pipeline` to start again.');
    return;
  }

  if (action.action_id === 'session_run') {

    // Final check: at least one file provided
    if (Object.keys(session.files).length === 0) {
      await slackPost(channel, [], '⚠️ No files were collected. Run `/run-pipeline` to start again.');
      await deleteSession(userId);
      return;
    }

    // Check if pipeline is already running
    const current = await getCurrentPipelineStatus();
    if (current.running) {
      await slackPost(channel, [], '⚠️ A pipeline is already running. Try again once it completes.');
      return;
    }

    // Map session files → pipeline files shape
    const files = {
      claims: {
        matter_entertainment: session.files.claims_matter_entertainment || null,
        matter_2: session.files.claims_matter_2 || null,
      },
      mcnVerdicts: session.files.mcn_verdicts || null,
      jfmVerdicts: session.files.jfm_verdicts || null,
    };

    await deleteSession(userId);
    await slackPost(channel, [], '⏳ Pipeline started! You\'ll get a notification here when it\'s done.');

    runPipeline(files).catch(err => console.error('Slack-triggered pipeline failed:', err));
    return;
  }
}

module.exports = { handleSlashCommand, handleEvent, handleInteraction };