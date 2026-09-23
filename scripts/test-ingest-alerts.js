#!/usr/bin/env node

/*
Offline checks for how ingest failures are classified and worded.
No Mongo, no YouTube, no Slack.

  node scripts/test-ingest-alerts.js
*/

const assert = require('assert');

process.env.YT_REPORTING_LOGIN_HINT = 'media@jesusfilm.org';
const { isAuthError, describeFailure } = require('../src/jobs/claimsIngest');

// The failure that ran silently on 2026-09-20 to 09-23, as gaxios reports it.
// Re-authorizing fixed it, though the error reads like a policy block.
const refusedGrant = Object.assign(new Error('access_not_configured'), {
  config: { url: 'https://oauth2.googleapis.com/token' },
  response: {
    status: 400,
    config: { url: 'https://oauth2.googleapis.com/token' },
    data: {
      error: 'access_not_configured',
      error_description: 'Account Restricted',
      error_uri: 'https://access.workspace.google.com/ServiceNotAllowed?application=505551310581'
    }
  }
});
const expiredToken = Object.assign(new Error('invalid_grant'), {
  response: { status: 400, config: { url: 'https://oauth2.googleapis.com/token' }, data: { error: 'invalid_grant' } }
});
const unknownRefusal = Object.assign(new Error('some_new_thing'), {
  response: { status: 400, config: { url: 'https://oauth2.googleapis.com/token' }, data: { error: 'some_new_thing' } }
});
const mysqlDown = Object.assign(new Error('connect ETIMEDOUT 10.0.0.1:3306'), { code: 'ETIMEDOUT' });

const tests = [];
const test = (name, fn) => tests.push([name, fn]);


test('a refused grant counts as an auth failure', () => {
  // it did not before: reason unlisted, status 400, no ENOENT, regex no match
  assert.strictEqual(isAuthError(refusedGrant), true);
});

test('any refusal from the token endpoint counts, even an unfamiliar one', () => {
  assert.strictEqual(isAuthError(unknownRefusal), true);
  assert.strictEqual(isAuthError(expiredToken), true);
});

test('a 400 from somewhere else does not', () => {
  const elsewhere = Object.assign(new Error('Bad Request'), {
    response: { status: 400, config: { url: 'https://youtubereporting.googleapis.com/v1/jobs' }, data: {} }
  });
  assert.strictEqual(isAuthError(elsewhere), false);
  assert.strictEqual(isAuthError(mysqlDown), false);
});

test('a missing token file still counts', () => {
  process.env.YT_REPORTING_TOKEN_FILE = '/opt/ytdt-claims-pipeline/config/token.json';
  const missing = Object.assign(new Error('ENOENT'), { code: 'ENOENT', path: process.env.YT_REPORTING_TOKEN_FILE });
  assert.strictEqual(isAuthError(missing), true);
});

test('a refused grant says re-authorize first, policy block as the fallback', () => {
  // read as a Workspace block on 2026-09-21 and it was not: re-auth fixed it
  const { lead, body, short } = describeFailure(refusedGrant, { authRequired: true });
  assert.match(lead, /needs re-authorization/);
  assert.match(body, /Account Restricted/);
  assert.match(body, /ServiceNotAllowed/);          // the link is what makes it diagnosable
  assert.match(body, /Sign in again/);
  assert.match(body, /claims-reporting-api\.md#when-google-asks-for-sign-in-again/);
  assert.match(short, /Re-authorize from a laptop/);
  // the admin remedy is there, but behind the signal that separates the two
  const policy = body.slice(body.indexOf('If the consent flow'));
  assert.match(policy, /policy block/);
  assert.match(policy, /admin/);
  assert.match(body, /nothing\s+needs backfilling/);
});

test('an expired token does tell someone to sign in again, from a laptop', () => {
  const { lead, body } = describeFailure(expiredToken, { authRequired: true });
  assert.match(lead, /needs re-authorization/);
  assert.match(body, /signs in again as media@jesusfilm\.org/);
  assert.match(body, /laptop rather than the VM/);
  assert.match(body, /claims-reporting-api\.md#when-google-asks-for-sign-in-again/);
});

test('a failure nobody classified is still announced', () => {
  // the whole point: MySQL down, disk full, anything — it gets a message
  const { lead, body, short } = describeFailure(mysqlDown, { authRequired: false });
  assert.match(lead, /Daily claims ingest failed/);
  assert.match(body, /ETIMEDOUT/);
  assert.match(body, /journal/);
  assert.strictEqual(short, mysqlDown.message);
});


let failed = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (error) {
    failed++;
    console.error(`✗ ${name}\n  ${error.message}`);
  }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
