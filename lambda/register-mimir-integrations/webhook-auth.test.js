// Run: node --test (from this directory, after `npm ci` at the repo root,
// which provides @aws-sdk/client-secrets-manager). No network: Secrets
// Manager, Mimir (fetch) and the CloudFormation response (https) are mocked.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const https = require('https');
const { EventEmitter } = require('events');
const { SecretsManagerClient } = require('@aws-sdk/client-secrets-manager');

const MIMIR_KEY = 'FAKE-MIMIR-KEY-123';
const TOKEN = 'FAKE-WEBHOOK-TOKEN-' + 'x'.repeat(45);
const SECRETS = { 'arn:mimir': MIMIR_KEY, 'arn:token': TOKEN };
SecretsManagerClient.prototype.send = async (cmd) => ({ SecretString: SECRETS[cmd.input.SecretId] });

const MIMIR = 'https://mimir.example.test';
const API = 'https://abc123.execute-api.us-east-1.amazonaws.com/prod/';

let mimirWebhooks; // what GET /webhooks returns
let calls;         // every Mimir request: { method, path, body }
global.fetch = async (url, opts) => {
  const path = url.slice(MIMIR.length);
  const body = opts.body ? JSON.parse(opts.body) : null;
  calls.push({ method: opts.method, path, body });
  let data = {};
  if (opts.method === 'GET' && path.endsWith('/webhooks')) data = mimirWebhooks;
  else if (opts.method === 'GET') data = [];
  else if (opts.method === 'POST') data = { id: 'new-id' };
  return { status: 200, ok: true, text: async () => JSON.stringify(data) };
};

let cfnBodies;
https.request = (options, cb) => {
  const req = new EventEmitter();
  req.write = (b) => cfnBodies.push(b);
  req.end = () => cb({ statusCode: 200 });
  return req;
};

let logs;
beforeEach(() => {
  calls = [];
  cfnBodies = [];
  logs = [];
  for (const level of ['log', 'warn', 'error', 'info']) {
    console[level] = (...args) => logs.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a) || String(a))).join(' '));
  }
});

const mod = require('./index');

const event = (RequestType = 'Update') => ({
  RequestType,
  ResponseURL: 'https://cfn.example.test/response',
  StackId: 'stack', RequestId: 'req', LogicalResourceId: 'MimirIntegrationsRegistration',
  ResourceProperties: {
    MimirApiKeySecretArn: 'arn:mimir',
    WebhookTokenSecretArn: 'arn:token',
    MimirBaseUrl: MIMIR,
    ActionsApiUrl: 'https://def456.execute-api.us-east-1.amazonaws.com/prod/actions/',
    WebhookApiUrl: API,
  },
});

const tokenHeaders = (headers) => headers.filter((h) => h.headerField.toLowerCase() === mod.WEBHOOK_TOKEN_HEADER);
const webhookWrites = () => calls.filter((c) => c.path.includes('/webhooks') && (c.method === 'PUT' || c.method === 'POST'));

function assertNothingLeaked() {
  const all = logs.join('\n') + '\n' + cfnBodies.join('\n');
  assert.ok(!all.includes(TOKEN), 'webhook token must not appear in logs or the CloudFormation response');
  assert.ok(!all.includes(MIMIR_KEY), 'Mimir key must not appear in logs or the CloudFormation response');
}

test('create: the new embed webhook carries the token header', async () => {
  mimirWebhooks = [];
  await mod.handler(event('Create'), {});
  const posts = webhookWrites().filter((c) => c.method === 'POST');
  assert.strictEqual(posts.length, 1);
  assert.strictEqual(posts[0].body.url, `${API}webhook/item-embed`);
  assert.deepStrictEqual(tokenHeaders(posts[0].body.headers), [{ headerField: mod.WEBHOOK_TOKEN_HEADER, headerValue: TOKEN }]);
  assert.ok(posts[0].body.headers.some((h) => h.headerField === 'Content-Type'));
  assert.match(JSON.parse(cfnBodies[0]).Status, /SUCCESS/);
  assertNothingLeaked();
});

test('update: existing embed webhook (no header) is updated with exactly one token header', async () => {
  mimirWebhooks = [{
    id: 'embed-1', label: 'Embed Video Content', type: 'itemCreation', url: `${API}webhook/item-embed`,
    headers: [{ headerField: 'Content-Type', headerValue: 'application/json' }],
  }];
  await mod.handler(event('Update'), {});
  const puts = webhookWrites().filter((c) => c.path.endsWith('/webhooks/embed-1'));
  assert.strictEqual(puts.length >= 1, true);
  for (const p of puts) {
    assert.deepStrictEqual(tokenHeaders(p.body.headers), [{ headerField: mod.WEBHOOK_TOKEN_HEADER, headerValue: TOKEN }]);
  }
  assertNothingLeaked();
});

test('update: other webhooks on our API get the header; foreign webhooks are untouched', async () => {
  mimirWebhooks = [
    { id: 'chg-1', label: 'Item change (manual)', type: 'itemChange', url: `${API}webhook/item-change`,
      headers: [{ headerField: 'X-Mimir-Webhook-Token', headerValue: 'stale-old-value' }], condition: { criteria: 'always' } },
    { id: 'crt-1', label: 'Item create (manual)', type: 'itemCreation', url: `${API}webhook/item-create`, headers: [] },
    { id: 'ok-1', label: 'Already current', type: 'itemCreation', url: `${API}webhook/item-create`,
      headers: [{ headerField: mod.WEBHOOK_TOKEN_HEADER, headerValue: TOKEN }] },
    { id: 'foreign-1', label: 'Saga Feedback', type: 'transfer', url: 'https://other.execute-api.us-east-1.amazonaws.com/v1/mimir', headers: [] },
  ];
  await mod.handler(event('Update'), {});
  const putFor = (id) => webhookWrites().filter((c) => c.method === 'PUT' && c.path.endsWith(`/webhooks/${id}`));

  const chg = putFor('chg-1');
  assert.strictEqual(chg.length, 1);
  assert.deepStrictEqual(tokenHeaders(chg[0].body.headers), [{ headerField: mod.WEBHOOK_TOKEN_HEADER, headerValue: TOKEN }]);
  assert.strictEqual(chg[0].body.type, 'itemChange', 'the rest of the webhook is preserved');
  assert.deepStrictEqual(chg[0].body.condition, { criteria: 'always' });

  assert.strictEqual(putFor('crt-1').length, 1);
  assert.deepStrictEqual(tokenHeaders(putFor('crt-1')[0].body.headers), [{ headerField: mod.WEBHOOK_TOKEN_HEADER, headerValue: TOKEN }]);
  assert.strictEqual(putFor('ok-1').length, 0, 'a webhook already carrying the current token is not rewritten');
  assert.strictEqual(putFor('foreign-1').length, 0, 'webhooks on other hosts are never touched');
  assertNothingLeaked();
});

test('missing token secret: no webhook is written and the stack is not failed', async () => {
  mimirWebhooks = [];
  const ev = event('Update');
  delete SECRETS['arn:token'];
  try {
    await mod.handler(ev, {});
  } finally {
    SECRETS['arn:token'] = TOKEN;
  }
  assert.strictEqual(webhookWrites().length, 0);
  assert.match(JSON.parse(cfnBodies[0]).Reason, /Webhook token secret is empty/);
});

test('filtered embed webhooks (one per value) each carry the token header', async () => {
  mimirWebhooks = [];
  const ev = event('Create');
  ev.ResourceProperties.EmbeddingsFilter = JSON.stringify({ field: 'Station', values: ['WKEF', 'WBFF'] });
  await mod.handler(ev, {});
  const posts = webhookWrites().filter((c) => c.method === 'POST');
  assert.strictEqual(posts.length, 2);
  for (const p of posts) {
    assert.deepStrictEqual(tokenHeaders(p.body.headers), [{ headerField: mod.WEBHOOK_TOKEN_HEADER, headerValue: TOKEN }]);
  }
  assertNothingLeaked();
});

test('withWebhookToken replaces any existing token header, case-insensitively', () => {
  const out = mod.withWebhookToken([
    { headerField: 'Content-Type', headerValue: 'application/json' },
    { headerField: 'X-MIMIR-WEBHOOK-TOKEN', headerValue: 'old' },
  ], 'new');
  assert.deepStrictEqual(out, [
    { headerField: 'Content-Type', headerValue: 'application/json' },
    { headerField: mod.WEBHOOK_TOKEN_HEADER, headerValue: 'new' },
  ]);
  assert.deepStrictEqual(mod.withWebhookToken(undefined, 'v'), [{ headerField: mod.WEBHOOK_TOKEN_HEADER, headerValue: 'v' }]);
});
