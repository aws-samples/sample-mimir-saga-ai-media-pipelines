// Run with: node --test   (from lambda/mimir-handler)
//
// Proves that no StartExecution input built by mimir-handler carries the Mimir
// API key or the caller's userToken, and that the token is not logged. AWS SDK
// clients and the JWT verifier are replaced with in-process fakes, so the test
// needs no network, no credentials and no `npm ci`.
const { describe, it, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const FAKE_KEY = 'FAKE-MIMIR-KEY-123';
const startCalls = [];
let secretReads = 0;

const fakes = {
  '@aws-sdk/client-sfn': {
    SFNClient: class { async send(cmd) { startCalls.push(cmd.input); return { executionArn: `arn:fake:execution:${startCalls.length}` }; } },
    StartExecutionCommand: class { constructor(input) { this.input = input; } },
  },
  '@aws-sdk/client-secrets-manager': {
    SecretsManagerClient: class { async send() { secretReads += 1; return { SecretString: FAKE_KEY }; } },
    GetSecretValueCommand: class { constructor(input) { this.input = input; } },
  },
  'aws-jwt-verify': {
    JwtRsaVerifier: { create: () => ({ verify: async () => ({ email: 'producer@example.com', token_use: 'id' }) }) },
  },
};

const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const FAKE_TOKEN = [
  b64url({ alg: 'RS256' }),
  b64url({ iss: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_TESTPOOL', token_use: 'id' }),
  'FAKE-SIGNATURE-456',
].join('.');

let handler;
let redactEventForLog;
const originalLoad = Module._load;
const originalLog = console.log;
let logged = '';

before(() => {
  Module._load = function (request, ...rest) {
    return Object.prototype.hasOwnProperty.call(fakes, request) ? fakes[request] : originalLoad.call(this, request, ...rest);
  };
  process.env.SUMMARIZER_STATE_MACHINE_ARN = 'arn:fake:stateMachine:summarizer';
  process.env.CHAPTERIZE_STATE_MACHINE_ARN = 'arn:fake:stateMachine:chapterize';
  process.env.VERTICAL_REFRAME_STATE_MACHINE_ARN = 'arn:fake:stateMachine:reframe';
  process.env.REFRAME_WITH_GRAPHICS_STATE_MACHINE_ARN = 'arn:fake:stateMachine:reframe-graphics';
  process.env.REFRAME_CUSTOM_STATE_MACHINE_ARN = 'arn:fake:stateMachine:reframe-custom';
  process.env.MIMIR_API_KEY_SECRET_ARN = 'arn:fake:secret:mimir';
  ({ handler, redactEventForLog } = require('./index.js'));
});

after(() => {
  Module._load = originalLoad;
  console.log = originalLog;
});

beforeEach(() => {
  startCalls.length = 0;
  secretReads = 0;
  logged = '';
  console.log = (...args) => { logged += args.map(String).join(' ') + '\n'; };
});

function apiEvent(action, body) {
  return {
    resource: `/actions/${action}`,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${FAKE_TOKEN}` },
    body: JSON.stringify({ userToken: FAKE_TOKEN, userId: 'u-1', userEmail: 'producer@example.com', ...body }),
  };
}

const video = { id: 'item-1', itemType: 'video', title: 'Clip', originalFileName: 'clip.mp4' };

// Every StartExecution call site in mimir-handler, with the exact top-level
// input keys it must send (the old shape minus mimirApiKey and userToken).
const CASES = [
  { action: 'summarizer', keys: ['items', 'actionData', 'userId', 'userEmail', 'actionType'] },
  { action: 'chapterize', keys: ['items', 'actionData', 'userId', 'userEmail', 'actionType'] },
  { action: 'reframe-9-16', keys: ['items', 'actionData', 'userId', 'userEmail', 'actionType', 'aspectRatio'] },
  { action: 'reframe-with-graphics', keys: ['itemId', 'storyId', 'itemDetails', 'baseFilename', 'title', 'description', 'transcript', 'lottieTemplates', 'aspectRatios', 'outputPrefix', 'userMetadata', 'userId', 'userEmail'] },
  { action: 'reframe-custom', keys: ['itemId', 'storyId', 'itemDetails', 'baseFilename', 'title', 'description', 'transcript', 'lottieTemplates', 'aspectRatios', 'varianceThreshold', 'executionTimestamp', 'userId', 'userEmail'] },
];

describe('mimir-handler StartExecution input', () => {
  for (const { action, keys } of CASES) {
    it(`${action}: no mimirApiKey or userToken in the execution input`, async () => {
      const res = await handler(apiEvent(action, { items: [video], actionData: { title: 'T' } }));
      assert.equal(res.statusCode, 200);
      assert.equal(JSON.parse(res.body).status, 'success');
      assert.equal(startCalls.length, 1);
      const raw = startCalls[0].input;
      const input = JSON.parse(raw);
      assert.deepEqual(Object.keys(input).sort(), [...keys].sort());
      assert.ok(!raw.includes(FAKE_KEY), 'API key must not be in execution input');
      assert.ok(!raw.includes(FAKE_TOKEN), 'user token must not be in execution input');
      assert.equal(secretReads, 0, 'mimir-handler no longer needs to read the Mimir key');
      assert.ok(!logged.includes(FAKE_TOKEN), 'user token must not be logged');
    });
  }

  it('still rejects a request without a user token (auth unchanged)', async () => {
    const res = await handler({ resource: '/actions/summarizer', body: JSON.stringify({ items: [video] }) });
    assert.equal(res.statusCode, 401);
    assert.equal(startCalls.length, 0);
  });
});

describe('redactEventForLog', () => {
  it('redacts userToken in the body and credential headers', () => {
    const out = redactEventForLog({
      headers: { authorization: 'Bearer x', 'X-API-Key': 'k', Accept: 'a' },
      multiValueHeaders: { Authorization: ['Bearer x'] },
      body: JSON.stringify({ userToken: 't', userId: 'u' }),
    });
    assert.equal(out.headers.authorization, '***REDACTED***');
    assert.equal(out.headers['X-API-Key'], '***REDACTED***');
    assert.equal(out.headers.Accept, 'a');
    assert.equal(out.multiValueHeaders.Authorization, '***REDACTED***');
    assert.deepEqual(out.body, { userToken: '***REDACTED***', userId: 'u' });
  });

  it('omits a body that is not JSON', () => {
    assert.equal(redactEventForLog({ body: 'not json' }).body, '[unparseable body omitted]');
  });
});
