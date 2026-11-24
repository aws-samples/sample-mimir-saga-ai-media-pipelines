// Run with: node --test   (from lambda/saga-action-handler)
//
// Proves that the StartExecution input built for Saga story actions carries no
// Mimir API key. AWS SDK clients are replaced with in-process fakes: no
// network, no credentials, no `npm ci` needed.
const { describe, it, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const FAKE_MIMIR_KEY = 'FAKE-MIMIR-KEY-123';
const FAKE_ACTIONS_KEY = 'FAKE-SAGA-ACTIONS-KEY-456';
const startCalls = [];
const secretReads = [];

const fakes = {
  '@aws-sdk/client-sfn': {
    SFNClient: class { async send(cmd) { startCalls.push(cmd.input); return { executionArn: 'arn:fake:execution:1' }; } },
    StartExecutionCommand: class { constructor(input) { this.input = input; } },
  },
  '@aws-sdk/client-secrets-manager': {
    SecretsManagerClient: class {
      async send(cmd) {
        secretReads.push(cmd.input.SecretId);
        if (cmd.input.SecretId === 'arn:fake:secret:saga-actions') return { SecretString: JSON.stringify({ apiKey: FAKE_ACTIONS_KEY }) };
        return { SecretString: FAKE_MIMIR_KEY };
      }
    },
    GetSecretValueCommand: class { constructor(input) { this.input = input; } },
  },
};

let handler;
const originalLoad = Module._load;

before(() => {
  Module._load = function (request, ...rest) {
    return Object.prototype.hasOwnProperty.call(fakes, request) ? fakes[request] : originalLoad.call(this, request, ...rest);
  };
  process.env.SAGA_ACTIONS_API_KEY_SECRET_ARN = 'arn:fake:secret:saga-actions';
  process.env.MIMIR_API_KEY_SECRET_ARN = 'arn:fake:secret:mimir';
  process.env.SAGA_API_KEY_SECRET_ARN = 'arn:fake:secret:saga-key';
  process.env.SAGA_API_URL_SECRET_ARN = 'arn:fake:secret:saga-url';
  process.env.ROUGH_CUT_STATE_MACHINE_ARN = 'arn:fake:stateMachine:rough-cut';
  process.env.STORY_RESEARCH_STATE_MACHINE_ARN = 'arn:fake:stateMachine:story-research';
  ({ handler } = require('./index.js'));
});

after(() => { Module._load = originalLoad; });

beforeEach(() => { startCalls.length = 0; secretReads.length = 0; });

function sagaEvent(action) {
  return {
    resource: `/saga-actions/${action}`,
    headers: { 'x-api-key': FAKE_ACTIONS_KEY },
    body: JSON.stringify({ event: 'story', triggeredByUserId: 'u-1', story: { mId: 'story-1', mTitle: 'A story' } }),
  };
}

const BASE_KEYS = ['storyId', 'sagaApiKeySecretArn', 'sagaApiUrlSecretArn', 'story', 'triggeredByUserId', 'actionType'];

describe('saga-action-handler StartExecution input', () => {
  for (const [action, keys] of [['generate-package', [...BASE_KEYS, 'roughCutType']], ['story-research', BASE_KEYS]]) {
    it(`${action}: no mimirApiKey in the execution input`, async () => {
      const res = await handler(sagaEvent(action));
      assert.equal(res.statusCode, 200);
      assert.equal(JSON.parse(res.body).status, 'success');
      assert.equal(startCalls.length, 1);
      const raw = startCalls[0].input;
      assert.deepEqual(Object.keys(JSON.parse(raw)).sort(), [...keys].sort());
      assert.ok(!raw.includes(FAKE_MIMIR_KEY), 'Mimir API key must not be in execution input');
      assert.ok(!raw.includes(FAKE_ACTIONS_KEY), 'Saga actions key must not be in execution input');
      assert.ok(!secretReads.includes('arn:fake:secret:mimir'), 'the handler no longer reads the Mimir key');
    });
  }

  it('still rejects a wrong x-api-key (auth unchanged)', async () => {
    const ev = sagaEvent('generate-package');
    ev.headers['x-api-key'] = 'wrong';
    const res = await handler(ev);
    assert.equal(res.statusCode, 401);
    assert.equal(startCalls.length, 0);
  });
});
