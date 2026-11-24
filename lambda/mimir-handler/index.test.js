// Run with: npm ci && node --test   (from lambda/mimir-handler)
//
// - No StartExecution input built by mimir-handler carries the Mimir API key
//   or the caller's userToken, and the token is not logged.
// - A missing or malformed body gets a 400 before any token work.
// - The issuer pin fails closed: no MIMIR_ALLOWED_ISSUER, no access. The
//   audience pin, signature and token_use checks hold.
// Step Functions and Secrets Manager are in-process fakes, so nothing touches
// AWS. The input and body tests also fake the JWT verifier. The issuer tests
// use the real aws-jwt-verify with a throwaway RSA key whose JWKS is seeded
// with cacheJwks(), so they need no network either.
const { describe, it, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const crypto = require('node:crypto');

const FAKE_KEY = 'FAKE-MIMIR-KEY-123';
const startCalls = [];
let secretReads = 0;
let tokenChecks = 0;
// true: aws-jwt-verify is replaced by a fake that accepts any token.
let fakeVerifier = true;

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
    JwtRsaVerifier: { create: () => ({ verify: async () => { tokenChecks += 1; return { email: 'producer@example.com', token_use: 'id' }; } }) },
  },
};

const originalLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'aws-jwt-verify' && !fakeVerifier) return originalLoad.call(this, request, ...rest);
  return Object.prototype.hasOwnProperty.call(fakes, request) ? fakes[request] : originalLoad.call(this, request, ...rest);
};

process.env.SUMMARIZER_STATE_MACHINE_ARN = 'arn:fake:stateMachine:summarizer';
process.env.CHAPTERIZE_STATE_MACHINE_ARN = 'arn:fake:stateMachine:chapterize';
process.env.VERTICAL_REFRAME_STATE_MACHINE_ARN = 'arn:fake:stateMachine:reframe';
process.env.REFRAME_WITH_GRAPHICS_STATE_MACHINE_ARN = 'arn:fake:stateMachine:reframe-graphics';
process.env.REFRAME_CUSTOM_STATE_MACHINE_ARN = 'arn:fake:stateMachine:reframe-custom';
process.env.MIMIR_API_KEY_SECRET_ARN = 'arn:fake:secret:mimir';

const TEST_ISSUER = 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_TESTPOOL';
const MIMIR_ISSUER = 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_MimirPool1';
const ATTACKER_ISSUER = 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_Attacker99';
const CLIENT_ID = 'mimirappclient000000000001';

/** Loads a fresh copy of the handler with the given env (env is read at load). */
function load({ issuer = '', audience = '', real = false } = {}) {
  process.env.MIMIR_ALLOWED_ISSUER = issuer;
  process.env.MIMIR_ALLOWED_AUDIENCE = audience;
  fakeVerifier = !real;
  delete require.cache[require.resolve('./index.js')];
  const mod = require('./index.js');
  if (real && issuer) mod._getVerifier(issuer).cacheJwks({ keys: [jwk] });
  return mod;
}

const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const FAKE_TOKEN = [
  b64url({ alg: 'RS256' }),
  b64url({ iss: TEST_ISSUER, token_use: 'id' }),
  'FAKE-SIGNATURE-456',
].join('.');

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-kid', alg: 'RS256', use: 'sig' };
function sign(claims) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64url({ alg: 'RS256', kid: 'test-kid', typ: 'JWT' });
  const body = b64url({ sub: 'user-1', token_use: 'id', aud: CLIENT_ID, iat: now, exp: now + 3600, ...claims });
  const sig = crypto.sign('RSA-SHA256', Buffer.from(`${head}.${body}`), privateKey).toString('base64url');
  return `${head}.${body}.${sig}`;
}

const originalConsole = { log: console.log, warn: console.warn, error: console.error, info: console.info };
let logs = [];
const logged = () => logs.join('\n');

after(() => {
  Module._load = originalLoad;
  Object.assign(console, originalConsole);
});

beforeEach(() => {
  startCalls.length = 0;
  secretReads = 0;
  tokenChecks = 0;
  logs = [];
  for (const l of ['log', 'warn', 'error', 'info']) console[l] = (...a) => logs.push(a.map(String).join(' '));
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
  let handler;
  before(() => { ({ handler } = load({ issuer: TEST_ISSUER })); });

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
      assert.ok(!logged().includes(FAKE_TOKEN), 'user token must not be logged');
    });
  }

  it('still rejects a request without a user token (auth unchanged)', async () => {
    const res = await handler({ resource: '/actions/summarizer', body: JSON.stringify({ items: [video] }) });
    assert.equal(res.statusCode, 401);
    assert.equal(startCalls.length, 0);
  });
});

describe('redactEventForLog', () => {
  let redactEventForLog;
  before(() => { ({ redactEventForLog } = load({ issuer: TEST_ISSUER })); });

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

describe('mimir-handler malformed body', () => {
  let handler;
  before(() => { ({ handler } = load({ issuer: TEST_ISSUER })); });

  // A body marker that must never reach the logs or the response.
  const MARKER = 'BODY-MARKER-789';
  const BAD = [
    { name: 'null body', body: null, reason: 'Request body is required' },
    { name: 'missing body', body: undefined, reason: 'Request body is required' },
    { name: 'empty body', body: '', reason: 'Request body is required' },
    { name: 'whitespace body', body: '   ', reason: 'Request body is required' },
    { name: 'invalid JSON', body: `{"userToken":"${MARKER}"`, reason: 'Request body must be valid JSON' },
    { name: 'JSON null', body: 'null', reason: 'Request body must be a JSON object' },
    { name: 'JSON array', body: `["${MARKER}"]`, reason: 'Request body must be a JSON object' },
    { name: 'missing items', body: JSON.stringify({ userToken: MARKER }), reason: 'items must be an array' },
    { name: 'items is an object', body: JSON.stringify({ userToken: MARKER, items: { id: 'x' } }), reason: 'items must be an array' },
    { name: 'items is null', body: JSON.stringify({ userToken: MARKER, items: null }), reason: 'items must be an array' },
  ];

  for (const { name, body, reason } of BAD) {
    it(`${name}: 400 before any token or Mimir work, body not logged`, async () => {
      const res = await handler({ resource: '/actions/summarizer', headers: {}, body });
      assert.equal(res.statusCode, 400);
      assert.equal(res.headers['Content-Type'], 'application/json');
      assert.deepEqual(JSON.parse(res.body), { message: reason, status: 'error' });
      assert.equal(tokenChecks, 0, 'token must not be checked');
      assert.equal(startCalls.length, 0, 'no execution may start');
      assert.equal(secretReads, 0);
      assert.ok(!logged().includes(MARKER), 'body must not be logged');
      assert.ok(!res.body.includes(MARKER), 'body must not be echoed');
    });
  }

  it('an empty items array is still accepted and authenticated', async () => {
    const res = await handler(apiEvent('summarizer', { items: [] }));
    assert.equal(res.statusCode, 200);
    assert.equal(tokenChecks, 1);
  });

  it('a malformed body is a 400 even with no issuer configured', async () => {
    const mod = load({ issuer: '' });
    const res = await mod.handler({ resource: '/actions/summarizer', headers: {}, body: '' });
    assert.equal(res.statusCode, 400);
    assert.equal(tokenChecks, 0);
  });
});

const actionEvent = (userToken) => ({
  resource: '/actions/summarizer',
  body: JSON.stringify({ items: [{ id: 'i1', itemType: 'video' }], userToken, userEmail: 'u@example.com' }),
});

describe('mimir-handler issuer pin (real verifier)', () => {
  it('no issuer configured: a valid Mimir token is rejected (fail closed)', async () => {
    const mod = load({ issuer: '', real: true });
    await assert.rejects(mod.validateMimirUserToken(sign({ iss: MIMIR_ISSUER })), /MIMIR_ALLOWED_ISSUER is not configured/);
  });

  it('no issuer configured: handler returns 401 and starts no execution', async () => {
    const mod = load({ issuer: '', real: true });
    const res = await mod.handler(actionEvent(sign({ iss: MIMIR_ISSUER })));
    assert.equal(res.statusCode, 401);
    assert.equal(startCalls.length, 0);
  });

  it('wrong issuer (attacker-owned Cognito pool) is rejected before any JWKS fetch', async () => {
    const mod = load({ issuer: MIMIR_ISSUER, real: true });
    await assert.rejects(mod.validateMimirUserToken(sign({ iss: ATTACKER_ISSUER })), /Token issuer not allowed/);
    const res = await mod.handler(actionEvent(sign({ iss: ATTACKER_ISSUER })));
    assert.equal(res.statusCode, 401);
    assert.equal(startCalls.length, 0);
  });

  it('right issuer, valid signature: accepted and the execution starts', async () => {
    const mod = load({ issuer: MIMIR_ISSUER, real: true });
    const claims = await mod.validateMimirUserToken(sign({ iss: MIMIR_ISSUER }));
    assert.equal(claims.iss, MIMIR_ISSUER);
    const res = await mod.handler(actionEvent(sign({ iss: MIMIR_ISSUER })));
    assert.equal(res.statusCode, 200);
    assert.equal(startCalls.length, 1);
  });

  it('right issuer but forged signature is rejected', async () => {
    const mod = load({ issuer: MIMIR_ISSUER, real: true });
    const [h, b] = sign({ iss: MIMIR_ISSUER }).split('.');
    const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    const forged = `${h}.${b}.${crypto.sign('RSA-SHA256', Buffer.from(`${h}.${b}`), other).toString('base64url')}`;
    await assert.rejects(mod.validateMimirUserToken(forged));
  });

  it('right issuer, access token (token_use != id) is rejected', async () => {
    const mod = load({ issuer: MIMIR_ISSUER, real: true });
    await assert.rejects(mod.validateMimirUserToken(sign({ iss: MIMIR_ISSUER, token_use: 'access' })));
  });

  it('audience pinned: matching client ID accepted, other client ID rejected', async () => {
    const mod = load({ issuer: MIMIR_ISSUER, audience: `other-client, ${CLIENT_ID}`, real: true });
    await mod.validateMimirUserToken(sign({ iss: MIMIR_ISSUER }));
    await assert.rejects(mod.validateMimirUserToken(sign({ iss: MIMIR_ISSUER, aud: 'not-mimir' })));
  });

  it('the request log never contains the signed user token', async () => {
    const mod = load({ issuer: MIMIR_ISSUER, real: true });
    const token = sign({ iss: MIMIR_ISSUER });
    await mod.handler(actionEvent(token));
    assert.ok(!logged().includes(token));
    assert.ok(!logged().includes(token.split('.')[2]));
  });
});
