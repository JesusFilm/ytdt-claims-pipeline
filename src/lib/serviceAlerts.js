const axios = require('axios');
const { getDatabase } = require('../database');

/**
 * Alert once per outage, not once per occurrence.
 *
 * A broken integration fails on every run, and a message each time teaches
 * people to ignore the channel — which is worse than not alerting at all. So
 * state lives in Mongo (surviving restarts and shared across processes): the
 * first failure posts, repeats stay quiet, and a success re-arms the alert so
 * the next outage is heard.
 */

const COLLECTION = 'service_alerts';

async function post(text) {
  if (!process.env.SLACK_BOT_TOKEN) {
    console.log(`alert (Slack disabled): ${text}`);
    return false;
  }
  const channel = process.env.SLACK_CHANNEL || '#ytdt-pipeline';
  const { data } = await axios.post(
    'https://slack.com/api/chat.postMessage',
    { channel, text },
    { headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`, 'Content-Type': 'application/json' } }
  );
  // Slack answers 200 with ok:false for channel_not_found and friends, so the
  // HTTP status alone would report success on an alert nobody received.
  if (!data.ok) throw new Error(`Slack rejected the alert: ${data.error}`);
  return true;
}

// Returns true when a message was actually sent.
async function raiseAlert(key, text) {
  try {
    const collection = getDatabase().collection(COLLECTION);
    const existing = await collection.findOne({ _id: key });
    if (existing?.firing) return false;

    await post(text);
    await collection.updateOne(
      { _id: key },
      { $set: { firing: true, since: new Date(), text } },
      { upsert: true }
    );
    return true;
  } catch (error) {
    // An alert that cannot be delivered must not break the thing it reports on
    console.error(`alert "${key}" failed to send: ${error.message}`);
    return false;
  }
}

// Call on success: the next failure should be heard, not swallowed as a repeat.
async function clearAlert(key) {
  try {
    const collection = getDatabase().collection(COLLECTION);
    const existing = await collection.findOne({ _id: key });
    if (!existing?.firing) return false;

    await collection.updateOne({ _id: key }, { $set: { firing: false, resolvedAt: new Date() } });
    return true;
  } catch (error) {
    console.error(`alert "${key}" failed to clear: ${error.message}`);
    return false;
  }
}

module.exports = { raiseAlert, clearAlert, COLLECTION };
