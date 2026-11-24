// Run with: node --test   (from lambda/classify-category-handler)
//
// The Mimir key is no longer in the Reframe + Graphics execution input, so the
// handler must read it from Secrets Manager when it fetches a Mimir transcript.
// AWS SDK clients and fetch are replaced with in-process fakes.
const { describe, it, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const FAKE_KEY = 'FAKE-MIMIR-KEY-123';
const secretReads = [];
const fetchCalls = [];

const fakes = {
  '@aws-sdk/client-secrets-manager': {
    SecretsManagerClient: class { async send(cmd) { secretReads.push(cmd.input.SecretId); return { SecretString: FAKE_KEY }; } },
    GetSecretValueCommand: class { constructor(input) { this.input = input; } },
  },
  '@aws-sdk/client-bedrock-runtime': {
    BedrockRuntimeClient: class {
      async send() {
        return { output: { message: { content: [{ text: '{"category":"WEATHER","line1":"STORM","line2":"","line3":"","headline":"Storm","location":""}' }] } } };
      }
    },
    ConverseCommand: class { constructor(input) { this.input = input; } },
  },
  '@aws-sdk/client-s3': {
    S3Client: class { async send() { throw new Error('S3 not expected in this test'); } },
    GetObjectCommand: class { constructor(input) { this.input = input; } },
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
  ({ handler } = require('./index.js'));
});

after(() => { Module._load = originalLoad; global.fetch = originalFetch; });

beforeEach(() => {
  secretReads.length = 0;
  fetchCalls.length = 0;
  global.fetch = async (url, opts) => {
    fetchCalls.push({ url, opts });
    return { ok: true, status: 200, json: async () => ({ fullTranscript: 'a storm is coming' }) };
  };
});

describe('classify-category-handler Mimir key', () => {
  it('reads the key from Secrets Manager when it is not in the event', async () => {
    const res = await handler({
      itemId: 'item-1',
      title: 'Storm',
      mimirDetails: { timedTranscriptUrl: 'https://mimir.example.com/transcript/item-1' },
    });
    assert.equal(res.category, 'WEATHER');
    assert.deepEqual(secretReads, ['arn:fake:secret:mimir']);
    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0].opts.headers['x-mimir-cognito-id-token'], `Bearer ${FAKE_KEY}`);
  });

  it('does not read the secret when no Mimir transcript fetch is needed', async () => {
    await handler({ itemId: '', title: 'Storm', transcript: 'given transcript' });
    assert.equal(secretReads.length, 0);
    assert.equal(fetchCalls.length, 0);
  });
});
