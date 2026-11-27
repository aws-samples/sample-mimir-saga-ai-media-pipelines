// Run with: npx cdk synth --quiet && node --test test/rough-cut-resilience.test.js
//
// Synth assertions for the msai-rough-cut-timeline state machine (Generate VO /
// VOSOT / AI VO / Package):
// - Map Items are always arrays: a JSONata filter with one match returns an
//   object, and Map then fails with States.QueryEvaluationError.
// - Each per-asset task catches into a skip state, so one asset's error does
//   not fail the Map and drop transcripts/embeddings for every asset.
// - HandleFailure reports the failing state and error, not a fixed string.
// Reads the synthesized template, so it needs no AWS credentials. Set CDK_OUT
// to use another cloud assembly directory.
const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const CDK_OUT = process.env.CDK_OUT || path.join(__dirname, '..', 'cdk.out');
const TEMPLATE = path.join(CDK_OUT, 'MSAI-CoreStack.template.json');

// DefinitionString is a plain string or an Fn::Join whose tokens all sit
// inside JSON string values, so a placeholder keeps the JSON valid.
function renderDefinition(def) {
  if (typeof def === 'string') return def;
  return def['Fn::Join'][1].map((p) => (typeof p === 'string' ? p : 'TOKEN')).join('');
}

let states;

before(() => {
  assert.ok(fs.existsSync(TEMPLATE), `${TEMPLATE} not found: run \`npx cdk synth --quiet\` first`);
  const template = JSON.parse(fs.readFileSync(TEMPLATE, 'utf-8'));
  const machine = Object.values(template.Resources)
    .filter((r) => r.Type === 'AWS::StepFunctions::StateMachine')
    .map((r) => JSON.parse(renderDefinition(r.Properties.DefinitionString)))
    .find((d) => d.States && d.States.InvokeRoughCutAgent);
  assert.ok(machine, 'rough-cut state machine not found');
  states = machine.States;
});

describe('rough-cut state machine resilience (synth)', () => {
  const maps = ['TranscribeAssets', 'ClassifyAssets', 'EnsureEmbeddings'];

  it('wraps every Map Items filter in an array constructor', () => {
    for (const name of maps) {
      assert.match(states[name].Items, /^\{% \[.*\] %\}$/, `${name}.Items is not array-wrapped`);
    }
  });

  it('catches every per-asset Task into the Map\'s skip state', () => {
    const skip = { TranscribeAssets: 'SkipFailedAsset', ClassifyAssets: 'ClassifySkipped', EnsureEmbeddings: 'EmbedFailed' };
    for (const name of maps) {
      const inner = states[name].ItemProcessor.States;
      assert.ok(inner[skip[name]], `${name} has no ${skip[name]} state`);
      const tasks = Object.entries(inner).filter(([, s]) => s.Type === 'Task');
      assert.ok(tasks.length > 0);
      for (const [taskName, task] of tasks) {
        const c = (task.Catch || []).find((x) => x.ErrorEquals.includes('States.ALL'));
        assert.ok(c, `${name}.${taskName} has no States.ALL Catch`);
        assert.equal(c.Next, skip[name], `${name}.${taskName} Catch goes to ${c.Next}`);
        assert.ok(c.Assign && c.Assign.assetError, `${name}.${taskName} Catch does not record the error`);
      }
      // The first task runs before $mimirItemId is assigned, so its Catch sets it.
      const first = inner[states[name].ItemProcessor.StartAt];
      assert.ok(first.Catch[0].Assign.mimirItemId, `${name} first-task Catch does not set mimirItemId`);
    }
  });

  it('continues to the next step when a Map still fails', () => {
    const next = (s) => s.Catch.find((x) => x.ErrorEquals.includes('States.ALL')).Next;
    assert.equal(next(states.TranscribeAssets), 'ClassifyAssets');
    assert.equal(next(states.ClassifyAssets), 'NeedEmbeddings');
    assert.equal(next(states.EnsureEmbeddings), 'InvokeRoughCutAgent');
  });

  it('passes transcribe results to the invoke Lambda instead of merging in JSONata', () => {
    const payload = states.InvokeRoughCutAgent.Arguments.Payload;
    assert.equal(payload.storyContext, '{% $storyContext %}');
    assert.match(payload.transcribeResults, /\$transcribeResults/);
  });

  it('carries the failing state and error into HandleFailure', () => {
    for (const name of ['GatherStoryContext', 'InvokeRoughCutAgent']) {
      const c = states[name].Catch.find((x) => x.Next === 'HandleFailure');
      assert.ok(c, `${name} does not catch into HandleFailure`);
      assert.match(c.Assign.errorMessage, new RegExp(`'${name}: '`));
      assert.match(c.Assign.errorMessage, /\$states\.errorOutput\.Error/);
    }
    assert.equal(states.HandleFailure.Error, 'RoughCutPipelineError');
    assert.match(states.HandleFailure.Cause, /\$errorMessage/);
  });
});
