#!/usr/bin/env node

/*
Offline checks for the service alerts: no Mongo, no Slack, no network.

  node scripts/test-service-alerts.js
*/

const assert = require('assert');
const axios = require('axios');
const database = require('../src/database');

// A stand-in for the service_alerts collection, holding just enough of the
// driver's surface for raiseAlert/clearAlert.
const docs = new Map();
const collection = {
  findOne: async ({ _id }) => docs.get(_id) || null,
  updateOne: async ({ _id }, { $set }) => {
    docs.set(_id, { ...(docs.get(_id) || {}), _id, ...$set });
    return { acknowledged: true };
  },
};
database.getDatabase = () => ({ collection: () => collection });

// Patched before serviceAlerts is required, so its destructured getDatabase
// picks up the fake rather than the real one.
const { raiseAlert, clearAlert } = require('../src/lib/serviceAlerts');

let sent = [];
let slackReply = { data: { ok: true } };
axios.post = async (url, body) => {
  sent.push({ url, ...body });
  if (slackReply instanceof Error) throw slackReply;
  return slackReply;
};

process.env.SLACK_BOT_TOKEN = 'test-token';
delete process.env.SLACK_CHANNEL;

function reset() {
  docs.clear();
  sent = [];
  slackReply = { data: { ok: true } };
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);


test('the first failure posts, and repeats stay quiet', async () => {
  assert.strictEqual(await raiseAlert('k', 'down'), true);
  assert.strictEqual(await raiseAlert('k', 'down'), false);
  assert.strictEqual(await raiseAlert('k', 'down'), false);
  assert.strictEqual(sent.length, 1);
});

test('it posts to #ytdt-pipeline unless SLACK_CHANNEL says otherwise', async () => {
  await raiseAlert('k', 'down');
  assert.strictEqual(sent[0].channel, '#ytdt-pipeline');

  reset();
  process.env.SLACK_CHANNEL = '#elsewhere';
  await raiseAlert('k', 'down');
  assert.strictEqual(sent[0].channel, '#elsewhere');
  delete process.env.SLACK_CHANNEL;
});

test('a success re-arms the alert, so the next outage is heard', async () => {
  await raiseAlert('k', 'down');
  assert.strictEqual(await clearAlert('k'), true);
  assert.strictEqual(await raiseAlert('k', 'down again'), true);
  assert.strictEqual(sent.length, 2);
});

test('clearing an alert that is not firing does nothing', async () => {
  assert.strictEqual(await clearAlert('k'), false);
  await raiseAlert('k', 'down');
  await clearAlert('k');
  assert.strictEqual(await clearAlert('k'), false);
});

test('keys are independent: one outage does not mute another', async () => {
  await raiseAlert('drive-upload', 'drive down');
  await raiseAlert('console-login', 'login down');
  assert.strictEqual(sent.length, 2);
});

test('Slack ok:false counts as not sent, so the alert stays un-fired', async () => {
  // Slack answers HTTP 200 with ok:false for channel_not_found and friends;
  // recording that as delivered would silence the real outage for good.
  slackReply = { data: { ok: false, error: 'channel_not_found' } };
  assert.strictEqual(await raiseAlert('k', 'down'), false);
  assert.strictEqual(docs.get('k'), undefined);

  slackReply = { data: { ok: true } };
  assert.strictEqual(await raiseAlert('k', 'down'), true);
});

test('a Slack outage does not break the caller', async () => {
  slackReply = new Error('getaddrinfo ENOTFOUND slack.com');
  assert.strictEqual(await raiseAlert('k', 'down'), false);
});

test('with no bot token it logs instead of posting, and stays quiet after', async () => {
  delete process.env.SLACK_BOT_TOKEN;
  assert.strictEqual(await raiseAlert('k', 'down'), true);
  assert.strictEqual(sent.length, 0);
  assert.strictEqual(await raiseAlert('k', 'down'), false);
  process.env.SLACK_BOT_TOKEN = 'test-token';
});


// Which sign-in failures are worth waking someone for. The app is public, so
// strangers failing the domain check must not reach Slack.
const { isConfigFailure } = require('../src/controllers/authController');

test('config-class sign-in failures alert', async () => {
  for (const error of [
    { message: 'invalid_client' },
    { response: { data: { error: 'redirect_uri_mismatch' } } },
    { response: { data: { error_description: 'Bad Request: invalid_grant' } } },
    { message: 'Token used too late, 1758000000 > 1757999999' },
    { message: 'Wrong recipient, payload audience != requiredAudience' },
    { message: 'No pem found for envelope' },
  ]) {
    assert.strictEqual(isConfigFailure(error), true, JSON.stringify(error));
  }
});

test('everyday rejections do not alert', async () => {
  for (const error of [
    { message: 'Unauthorized domain: gmail.com' },
    { message: 'socket hang up' },
    { response: { data: { error: 'server_error' } } },
    {},
    null,
  ]) {
    assert.strictEqual(isConfigFailure(error), false, JSON.stringify(error));
  }
});


(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    reset();
    try {
      await fn();
      console.log(`✓ ${name}`);
    } catch (error) {
      failed++;
      console.error(`✗ ${name}\n  ${error.message}`);
    }
  }
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
