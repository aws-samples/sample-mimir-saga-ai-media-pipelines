// Run with: node --test   (from lambda/invoke-rough-cut-agent)
//
// The AgentCore payload no longer carries a mimirApiKey (the agent reads the
// key from Secrets Manager itself). AWS SDK clients are in-process fakes.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const invokes = [];
const fakes = {
  '@aws-sdk/client-bedrock-agentcore': {
    BedrockAgentCoreClient: class { async send(cmd) { invokes.push(cmd.input); return {}; } },
    InvokeAgentRuntimeCommand: class { constructor(input) { this.input = input; } },
  },
  '@aws-sdk/client-sfn': {
    SFNClient: class { async send() { return {}; } },
    SendTaskFailureCommand: class { constructor(input) { this.input = input; } },
  },
  '@aws-sdk/client-ssm': {
    SSMClient: class { async send() { return { Parameter: { Value: 'arn:fake:runtime/rough-cut' } }; } },
    GetParameterCommand: class { constructor(input) { this.input = input; } },
  },
};

let handler;
const originalLoad = Module._load;

before(() => {
  Module._load = function (request, ...rest) {
    return Object.prototype.hasOwnProperty.call(fakes, request) ? fakes[request] : originalLoad.call(this, request, ...rest);
  };
  ({ handler } = require('./index.js'));
});

after(() => { Module._load = originalLoad; });

describe('invoke-rough-cut-agent payload', () => {
  it('does not forward a mimirApiKey to the agent', async () => {
    // Even if an old execution still carries the key, it must not be forwarded.
    await handler({ TaskToken: 'tt', storyId: 's1', story: {}, mimirApiKey: 'FAKE-MIMIR-KEY-123', roughCutType: 'vo' });
    assert.equal(invokes.length, 1);
    const payload = JSON.parse(Buffer.from(invokes[0].payload).toString('utf-8'));
    assert.ok(!('mimirApiKey' in payload));
    assert.deepEqual(Object.keys(payload).sort(), ['assets', 'instances', 'notes', 'roughCutType', 'story', 'storyContext', 'storyId', 'task_token', 'triggeredByUserId']);
  });
});
