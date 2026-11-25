// Run with: npx cdk synth --quiet && node --test test/webhook-deployment.test.js
//
// Synth assertions for the Mimir webhook API (ItemChangeWebhookApi):
// - The Deployment logical id is not the one CloudFormation created while the
//   API still had unauthenticated OPTIONS mocks; that snapshot still serves
//   them, so the stage must move to a new Deployment.
// - The prod Stage points at that new Deployment.
// - The API has no OPTIONS methods.
// Reads the synthesized template, so it needs no AWS credentials. Set CDK_OUT
// to use another cloud assembly directory.
const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const CDK_OUT = process.env.CDK_OUT || path.join(__dirname, '..', 'cdk.out');
const TEMPLATE = path.join(CDK_OUT, 'MSAI-CoreStack.template.json');
const STALE_DEPLOYMENT = 'ItemChangeWebhookApiDeployment2473219D937aaeee2ff6f2f7d686f43b25afc1de';

let resources;
let apiId;

before(() => {
  assert.ok(fs.existsSync(TEMPLATE), `${TEMPLATE} not found: run \`npx cdk synth --quiet\` first`);
  resources = JSON.parse(fs.readFileSync(TEMPLATE, 'utf-8')).Resources;
  apiId = Object.keys(resources).find(
    (k) => resources[k].Type === 'AWS::ApiGateway::RestApi' && k.startsWith('ItemChangeWebhookApi'),
  );
  assert.ok(apiId, 'webhook RestApi not found');
});

const ofApi = (type) => Object.entries(resources).filter(
  ([, r]) => r.Type === type && r.Properties.RestApiId && r.Properties.RestApiId.Ref === apiId,
);

describe('webhook API deployment (synth)', () => {
  it('uses a new Deployment, not the stale OPTIONS-mock snapshot', () => {
    const deployments = ofApi('AWS::ApiGateway::Deployment');
    assert.equal(deployments.length, 1);
    assert.notEqual(deployments[0][0], STALE_DEPLOYMENT);
  });

  it('points the stage at that Deployment', () => {
    const [[deploymentId]] = ofApi('AWS::ApiGateway::Deployment');
    const stages = ofApi('AWS::ApiGateway::Stage');
    assert.equal(stages.length, 1);
    assert.deepEqual(stages[0][1].Properties.DeploymentId, { Ref: deploymentId });
  });

  it('has no OPTIONS methods', () => {
    const options = ofApi('AWS::ApiGateway::Method').filter(([, r]) => r.Properties.HttpMethod === 'OPTIONS');
    assert.deepEqual(options.map(([k]) => k), []);
  });
});
