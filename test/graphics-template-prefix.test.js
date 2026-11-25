// Run with: node --test test/graphics-template-prefix.test.js
//
// GraphicsTemplatePrefix names the Lottie template keys. The stack must reject
// a value that is not a single safe S3 key segment before it builds anything,
// and must keep today's 'graphics-overlay' keys by default. The bad-value
// cases construct InfrastructureStack in-process (ts-node), so they need no
// cdk.out, no AWS credentials and no ffmpeg layer: validation runs first.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

require('ts-node').register({ transpileOnly: true, compilerOptions: { module: 'commonjs' } });
const cdk = require('aws-cdk-lib');
const { resolveGraphicsTemplatePrefix } = require('../lib/graphics-template-prefix');
const { InfrastructureStack } = require('../lib/infrastructure-stack');

describe('resolveGraphicsTemplatePrefix', () => {
  it('defaults to graphics-overlay when unset or blank', () => {
    for (const raw of [undefined, null, '', '   ']) {
      assert.equal(resolveGraphicsTemplatePrefix(raw), 'graphics-overlay');
    }
  });

  it('accepts safe names', () => {
    for (const ok of ['graphics-overlay', 'sinclair-demo', 'WPDE_v2.1', 'a']) {
      assert.equal(resolveGraphicsTemplatePrefix(ok), ok);
    }
    assert.equal(resolveGraphicsTemplatePrefix('  sinclair-demo '), 'sinclair-demo');
  });

  it('rejects slashes, "..", spaces and other unsafe characters', () => {
    for (const bad of ['../evil', 'a/b', '/abs', 'a..b', '.hidden', '-dash', 'breaking news',
      'x:y', 'a\\b', 'é', 'x'.repeat(101)]) {
      assert.throws(() => resolveGraphicsTemplatePrefix(bad), /GraphicsTemplatePrefix/, bad);
    }
  });
});

describe('InfrastructureStack synth', () => {
  for (const bad of ['../sinclair-demo', 'templates/sinclair-demo']) {
    it(`rejects GraphicsTemplatePrefix ${JSON.stringify(bad)}`, () => {
      const app = new cdk.App({ context: { graphicsTemplatePrefix: bad } });
      assert.throws(
        () => new InfrastructureStack(app, 'PrefixTestStack', {
          productName: 'Mimir Saga AI', acronym: 'MSAI',
          env: { account: '123456789012', region: 'us-east-1' },
        }),
        /GraphicsTemplatePrefix .* is not a valid template name/);
    });
  }
});

// Needs `npx cdk synth --quiet` first (skipped otherwise). Set CDK_OUT to use
// another cloud assembly, e.g. one synthesized with -c graphicsTemplatePrefix=…
describe('synthesized CoreStack', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const template = path.join(process.env.CDK_OUT || path.join(__dirname, '..', 'cdk.out'), 'MSAI-CoreStack.template.json');
  const expected = process.env.EXPECT_GRAPHICS_TEMPLATE_PREFIX || 'graphics-overlay';
  const skip = fs.existsSync(template) ? false : `${template} not found: run \`npx cdk synth --quiet\` first`;

  it(`mimir-handler gets LOTTIE_TEMPLATE_PREFIX=${expected}`, { skip }, () => {
    const resources = Object.values(JSON.parse(fs.readFileSync(template, 'utf-8')).Resources);
    const fn = resources.find((r) => r.Type === 'AWS::Lambda::Function'
      && r.Properties.FunctionName === 'msai-mimir-handler');
    assert.ok(fn, 'msai-mimir-handler not found');
    assert.equal(fn.Properties.Environment.Variables.LOTTIE_TEMPLATE_PREFIX, expected);
  });

  it(`RCRenderOverlay reads templates/${expected}-1080x1920-9x16.json`, { skip }, () => {
    const raw = fs.readFileSync(template, 'utf-8');
    assert.ok(raw.includes(`\\"templateKey\\":\\"templates/${expected}-1080x1920-9x16.json\\"`),
      'RCRenderOverlay templateKey not built from the prefix');
  });
});
