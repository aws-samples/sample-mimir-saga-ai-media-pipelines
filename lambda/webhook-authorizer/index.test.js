// Run: node --test (from this directory, after `npm ci` at the repo root,
// which provides @aws-sdk/client-secrets-manager).
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const { SecretsManagerClient } = require('@aws-sdk/client-secrets-manager');

const SECRET = 'S'.repeat(40) + 'fake-webhook-token-for-tests-0001';
let secretValue = SECRET;
let secretError = null;
SecretsManagerClient.prototype.send = async () => {
  if (secretError) throw secretError;
  return { SecretString: secretValue };
};

process.env.WEBHOOK_TOKEN_SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:test';
const authorizer = require('./index');

const METHOD_ARN = 'arn:aws:execute-api:us-east-1:123456789012:abc123/prod/POST/webhook/item-embed';
const event = (headers) => ({ type: 'REQUEST', methodArn: METHOD_ARN, headers });

let logs;
beforeEach(() => {
  secretValue = SECRET;
  secretError = null;
  authorizer._resetCache();
  logs = [];
  for (const level of ['log', 'warn', 'error', 'info']) {
    console[level] = (...args) => logs.push(args.join(' '));
  }
});

const effect = (r) => r.policyDocument.Statement[0].Effect;

test('correct header -> Allow on every method of the stage', async () => {
  const r = await authorizer.handler(event({ 'x-mimir-webhook-token': SECRET }));
  assert.strictEqual(effect(r), 'Allow');
  assert.strictEqual(r.policyDocument.Statement[0].Resource, 'arn:aws:execute-api:us-east-1:123456789012:abc123/prod/*/*');
});

test('header name is case-insensitive', async () => {
  const r = await authorizer.handler(event({ 'X-Mimir-Webhook-Token': SECRET }));
  assert.strictEqual(effect(r), 'Allow');
});

test('missing header -> Deny', async () => {
  assert.strictEqual(effect(await authorizer.handler(event({ 'Content-Type': 'application/json' }))), 'Deny');
  assert.strictEqual(effect(await authorizer.handler(event(undefined))), 'Deny');
});

test('wrong header, same length -> Deny', async () => {
  const wrong = SECRET.slice(0, -1) + (SECRET.endsWith('1') ? '2' : '1');
  assert.strictEqual(wrong.length, SECRET.length);
  assert.strictEqual(effect(await authorizer.handler(event({ 'x-mimir-webhook-token': wrong }))), 'Deny');
});

test('different length (prefix, longer, empty) -> Deny', async () => {
  for (const v of [SECRET.slice(0, 10), SECRET + 'x', '']) {
    assert.strictEqual(effect(await authorizer.handler(event({ 'x-mimir-webhook-token': v }))), 'Deny', `value of length ${v.length}`);
  }
});

test('empty or short secret never authorizes, even when the header matches it', async () => {
  for (const v of ['', 'short']) {
    secretValue = v;
    authorizer._resetCache();
    assert.strictEqual(effect(await authorizer.handler(event({ 'x-mimir-webhook-token': v }))), 'Deny');
  }
});

test('secret read failure -> Deny (fail closed)', async () => {
  secretError = Object.assign(new Error('boom'), { name: 'AccessDeniedException' });
  assert.strictEqual(effect(await authorizer.handler(event({ 'x-mimir-webhook-token': SECRET }))), 'Deny');
});

test('neither the header value nor the secret is logged', async () => {
  await authorizer.handler(event({ 'x-mimir-webhook-token': SECRET }));
  await authorizer.handler(event({ 'x-mimir-webhook-token': 'wrong-value-that-is-not-the-secret' }));
  await authorizer.handler(event({}));
  const all = logs.join('\n');
  assert.ok(!all.includes(SECRET));
  assert.ok(!all.includes('wrong-value-that-is-not-the-secret'));
});
