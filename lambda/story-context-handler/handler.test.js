// Run with: node --test   (from lambda/story-context-handler)
//
// The rough-cut execution input no longer carries the Mimir key, so the
// handler must read it from Secrets Manager for the Mimir transcript checks.
// AWS SDK clients and fetch are replaced with in-process fakes (no network).
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const SECRETS = {
  'arn:fake:secret:mimir': 'FAKE-MIMIR-KEY-123',
  'arn:fake:secret:mimir-input': 'FAKE-MIMIR-KEY-INPUT-789',
  'arn:fake:secret:saga-key': 'FAKE-SAGA-KEY-456',
  'arn:fake:secret:saga-url': 'https://saga.example.com/v1',
};
const secretReads = [];
const fetchCalls = [];

const fakes = {
  '@aws-sdk/client-secrets-manager': {
    SecretsManagerClient: class { async send(cmd) { secretReads.push(cmd.input.SecretId); return { SecretString: SECRETS[cmd.input.SecretId] }; } },
    GetSecretValueCommand: class { constructor(input) { this.input = input; } },
  },
  '@aws-sdk/client-s3vectors': {
    S3VectorsClient: class { async send() { return { vectors: [] }; } },
    GetVectorsCommand: class { constructor(input) { this.input = input; } },
  },
};

let handler;
const originalLoad = Module._load;
const originalFetch = global.fetch;

before(() => {
  Module._load = function (request, ...rest) {
    return Object.prototype.hasOwnProperty.call(fakes, request) ? fakes[request] : originalLoad.call(this, request, ...rest);
  };
  process.env.MIMIR_API_KEY_SECRET_ARN = 'arn:fake:secret:mimir';
  global.fetch = async (url, opts) => {
    fetchCalls.push({ url, opts });
    if (url.endsWith('/assets')) return { ok: true, status: 200, json: async () => ({ assets: [{ id: 'a1', externalId: 'item-1', itemType: 'video' }] }) };
    if (url.endsWith('/instances')) return { ok: true, status: 200, json: async () => ({ instances: [] }) };
    if (url.endsWith('/notes')) return { ok: true, status: 200, json: async () => ({ notes: [] }) };
    if (url.includes('/api/v1/items/')) return { ok: true, status: 200, json: async () => ({ timedTranscriptUrl: 'https://mimir.example.com/t/item-1' }) };
    return { ok: true, status: 200, json: async () => ({ mTitle: 'A story' }) };
  };
  ({ handler } = require('./index.js'));
});

after(() => { Module._load = originalLoad; global.fetch = originalFetch; });

describe('story-context-handler Mimir key', () => {
  beforeEach(() => { secretReads.length = 0; fetchCalls.length = 0; });

  it('reads the key from the secret ARN in the task input first', async () => {
    const out = await handler({
      storyId: 'story-1',
      sagaApiKeySecretArn: 'arn:fake:secret:saga-key',
      sagaApiUrlSecretArn: 'arn:fake:secret:saga-url',
      mimirApiKeySecretArn: 'arn:fake:secret:mimir-input',
    });
    assert.ok(secretReads.includes('arn:fake:secret:mimir-input'));
    assert.ok(!secretReads.includes('arn:fake:secret:mimir'), 'env ARN is not used when the input has one');
    const mimirCall = fetchCalls.find((c) => c.url.includes('/api/v1/items/item-1'));
    assert.equal(mimirCall.opts.headers['x-mimir-cognito-id-token'], 'Bearer FAKE-MIMIR-KEY-INPUT-789');
    assert.ok(!JSON.stringify(out).includes('FAKE-MIMIR-KEY-INPUT-789'), 'key is not returned into the state output');
  });

  it('falls back to MIMIR_API_KEY_SECRET_ARN when the input has no ARN', async () => {
    const out = await handler({
      storyId: 'story-1',
      sagaApiKeySecretArn: 'arn:fake:secret:saga-key',
      sagaApiUrlSecretArn: 'arn:fake:secret:saga-url',
    });
    assert.ok(secretReads.includes('arn:fake:secret:mimir'));
    const mimirCall = fetchCalls.find((c) => c.url.includes('/api/v1/items/item-1'));
    assert.ok(mimirCall, 'Mimir transcript check was made');
    assert.equal(mimirCall.opts.headers['x-mimir-cognito-id-token'], 'Bearer FAKE-MIMIR-KEY-123');
    assert.equal(out.assets[0].hasTranscript, true);
    assert.ok(!JSON.stringify(out).includes('FAKE-MIMIR-KEY-123'), 'key is not returned into the state output');
  });
});
