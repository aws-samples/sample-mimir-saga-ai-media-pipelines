// Run: node --test scripts/derive-mimir-auth.test.js (from the repo root). No network: fetch is mocked,
// and the CLI test preloads a fake fetch with --require.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { deriveContext, mimirBaseUrl } = require('./derive-mimir-auth');

const POOL = 'us-east-1_TestPool1';
const ISSUER = `https://cognito-idp.us-east-1.amazonaws.com/${POOL}`;
const CLIENT = 'testappclient0001';
const DOC = { clientConfig: { authRegion: 'us-east-1', userPoolId: POOL, appClientId: CLIENT, cognitoEndpoint: ISSUER } };

const mockFetch = (body, status = 200) => {
  const calls = [];
  const f = async (url) => { calls.push(url); return { ok: status < 300, status, json: async () => body }; };
  f.calls = calls;
  return f;
};

test('blank issuer and audience: both derived from https://<instance>.mjoll.no/api/v1', async () => {
  const f = mockFetch(DOC);
  const ctx = await deriveContext({ MimirInstance: 'us' }, {}, f);
  assert.deepStrictEqual(ctx, { mimirAllowedIssuer: ISSUER, mimirAllowedAudience: CLIENT });
  assert.deepStrictEqual(f.calls, ['https://us.mjoll.no/api/v1']);
});

test('MIMIR_API_BASE overrides the instance host', async () => {
  const f = mockFetch(DOC);
  await deriveContext({ MimirInstance: 'us' }, { MIMIR_API_BASE: 'https://mimir.example.test/' }, f);
  assert.deepStrictEqual(f.calls, ['https://mimir.example.test/api/v1']);
  assert.throws(() => mimirBaseUrl({}, { MIMIR_API_BASE: 'http://insecure.test' }), /https/);
});

test('explicit values win: no fetch when both are set', async () => {
  const f = mockFetch(DOC);
  const ctx = await deriveContext({ MimirAllowedIssuer: 'https://cognito-idp.eu-west-1.amazonaws.com/eu-west-1_X', MimirAllowedAudience: 'abc' }, {}, f);
  assert.deepStrictEqual(ctx, {});
  assert.strictEqual(f.calls.length, 0);
});

test('explicit issuer for another pool: discovered audience is not applied', async () => {
  const ctx = await deriveContext({ MimirAllowedIssuer: 'https://cognito-idp.eu-west-1.amazonaws.com/eu-west-1_Other' }, {}, mockFetch(DOC));
  assert.deepStrictEqual(ctx, {});
});

test('explicit issuer equal to the discovered one: audience is filled in', async () => {
  const ctx = await deriveContext({ MimirAllowedIssuer: ISSUER }, {}, mockFetch(DOC));
  assert.deepStrictEqual(ctx, { mimirAllowedAudience: CLIENT });
});

test('failures throw: HTTP error, missing clientConfig, non-Cognito issuer, inconsistent pool', async () => {
  await assert.rejects(deriveContext({}, {}, mockFetch({}, 503)), /HTTP 503/);
  await assert.rejects(deriveContext({}, {}, mockFetch({})), /no usable/);
  await assert.rejects(deriveContext({}, {}, mockFetch({ clientConfig: { cognitoEndpoint: 'https://evil.example.com/pool' } })), /no usable/);
  await assert.rejects(deriveContext({}, {}, mockFetch({ clientConfig: { ...DOC.clientConfig, userPoolId: 'us-east-1_Different' } })), /inconsistent/);
});

// CLI, the way deploy.sh calls it.
function runCli(mode, params) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'derive-'));
  const pfile = path.join(dir, 'parameters.json');
  fs.writeFileSync(pfile, JSON.stringify(params));
  const preload = path.join(dir, 'mock.js');
  fs.writeFileSync(preload, `globalThis.fetch = async () => (${JSON.stringify(mode)} === 'fail'
    ? (() => { throw new Error('getaddrinfo ENOTFOUND'); })()
    : { ok: true, status: 200, json: async () => (${JSON.stringify(DOC)}) });`);
  const out = execFileSync(process.execPath, ['--require', preload, path.join(__dirname, 'derive-mimir-auth.js'), pfile],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, MIMIR_API_BASE: '' } });
  fs.rmSync(dir, { recursive: true, force: true });
  return out;
}

test('CLI success: prints one key=value per derived context value', () => {
  const out = runCli('ok', [{ ParameterKey: 'MimirInstance', ParameterValue: 'us' }, { ParameterKey: 'MimirAllowedIssuer', ParameterValue: '' }]);
  assert.strictEqual(out, `mimirAllowedIssuer=${ISSUER}\nmimirAllowedAudience=${CLIENT}\n`);
});

test('CLI failure: prints nothing on stdout and exits 0 (deploy continues fail closed)', () => {
  assert.strictEqual(runCli('fail', [{ ParameterKey: 'MimirInstance', ParameterValue: 'us' }]), '');
});

test('CLI with explicit values: prints nothing', () => {
  const out = runCli('ok', [
    { ParameterKey: 'MimirAllowedIssuer', ParameterValue: ISSUER },
    { ParameterKey: 'MimirAllowedAudience', ParameterValue: CLIENT },
  ]);
  assert.strictEqual(out, '');
});
