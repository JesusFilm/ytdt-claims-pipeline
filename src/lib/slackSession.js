const { getDatabase } = require('../database');

const STEPS = [
  {
    key: 'claims_matter_entertainment',
    label: 'Claims — Matter Entertainment',
    description: 'Download from YouTube Studio → Matter Entertainment account → Reports → Claims → Export CSV (1.0 format)',
  },
  {
    key: 'claims_matter_2',
    label: 'Claims — Matter 2',
    description: 'Download from YouTube Studio → Matter 2 account → Reports → Claims → Export CSV (1.0 format)',
  },
  {
    key: 'mcn_verdicts',
    label: 'MCN Verdicts',
    description: 'Your MCN verdicts CSV (columns: video_id, verdict, media_component_id, language_id, wave, no_code)',
  },
  {
    key: 'jfm_verdicts',
    label: 'JFM Verdicts',
    description: 'Your JFM (owned) verdicts CSV (same column structure as MCN verdicts)',
  },
];

function collection() {
  return getDatabase().collection('slack_sessions');
}

let indexesReady = false;
async function ensureIndexes() {
  if (indexesReady) return;
  await collection().createIndex({ updatedAt: 1 }, { expireAfterSeconds: 86400 });
  indexesReady = true;
}


async function getSession(userId) {
  return collection().findOne({ userId });
}

async function createSession(userId) {
  await ensureIndexes();
  const session = {
    userId,
    stepIndex: 0,
    files: {},
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  await collection().replaceOne({ userId }, session, { upsert: true });
  return session;
}

async function updateSession(userId, patch) {
  await collection().updateOne(
    { userId },
    { $set: { ...patch, updatedAt: new Date() } }
  );
  return collection().findOne({ userId });
}

async function deleteSession(userId) {
  await collection().deleteOne({ userId });
}

function currentStep(session) {
  return STEPS[session.stepIndex] || null;
}

function stepCount() {
  return STEPS.length;
}

module.exports = { STEPS, getSession, createSession, updateSession, deleteSession, currentStep, stepCount };