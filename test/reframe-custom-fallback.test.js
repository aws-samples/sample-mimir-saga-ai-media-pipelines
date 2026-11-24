// Run with: npx cdk synth --quiet && node --test test/reframe-custom-fallback.test.js
//
// Synth assertion: the ReframeCustom -> ReframeWithGraphics fallback
// (RCInvokeFallback) must start the child with every execution-input field the
// child reads through $$.Execution.Input, including each userMetadata.* field.
// A missing one fails the child with States.Runtime. Reads the synthesized
// template, so it needs no AWS credentials. Set CDK_OUT to use another
// cloud assembly directory.
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

function findState(states, name) {
  for (const [key, state] of Object.entries(states || {})) {
    if (key === name) return state;
    for (const nested of [state.Iterator, state.ItemProcessor, ...(state.Branches || [])]) {
      const found = nested && findState(nested.States, name);
      if (found) return found;
    }
  }
  return undefined;
}

let machines;

before(() => {
  assert.ok(fs.existsSync(TEMPLATE), `${TEMPLATE} not found: run \`npx cdk synth --quiet\` first`);
  const template = JSON.parse(fs.readFileSync(TEMPLATE, 'utf-8'));
  machines = Object.entries(template.Resources)
    .filter(([, r]) => r.Type === 'AWS::StepFunctions::StateMachine')
    .map(([id, r]) => {
      const text = renderDefinition(r.Properties.DefinitionString);
      return { id, text, definition: JSON.parse(text) };
    });
});

describe('RCInvokeFallback input (synth)', () => {
  it('supplies every $$.Execution.Input field ReframeWithGraphics reads', () => {
    const child = machines.find((m) => findState(m.definition.States, 'StartOverlayJob') && findState(m.definition.States, 'ClassifyCategory'));
    const parent = machines.find((m) => findState(m.definition.States, 'RCInvokeFallback'));
    assert.ok(child, 'ReframeWithGraphics state machine not found');
    assert.ok(parent, 'ReframeCustom state machine not found');

    const input = findState(parent.definition.States, 'RCInvokeFallback').Parameters.Input;
    const provided = (key) => key in input || `${key}.$` in input;

    const reads = [...child.text.matchAll(/\$\$\.Execution\.Input\.([A-Za-z0-9_]+)(?:\.([A-Za-z0-9_]+))?/g)];
    assert.ok(reads.length > 0);
    for (const [, top, sub] of reads) {
      assert.ok(provided(top), `fallback input is missing ${top}`);
      if (sub && top === 'userMetadata') {
        assert.equal(typeof input.userMetadata, 'object', 'userMetadata must be a literal object');
        assert.ok(sub in input.userMetadata, `fallback userMetadata is missing ${sub}`);
      }
    }
  });

  it('passes "no overrides" metadata with captions off', () => {
    const parent = machines.find((m) => findState(m.definition.States, 'RCInvokeFallback'));
    const { userMetadata } = findState(parent.definition.States, 'RCInvokeFallback').Parameters.Input;
    assert.deepEqual(userMetadata, { burnCaptions: false });
  });
});
