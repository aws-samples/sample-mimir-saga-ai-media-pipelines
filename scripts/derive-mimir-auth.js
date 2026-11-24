#!/usr/bin/env node
/**
 * Deploy-time helper (called by deploy.sh): fills in MimirAllowedIssuer and
 * MimirAllowedAudience from Mimir's public, anonymous service document
 * (`<Mimir base URL>/api/v1`, field `clientConfig`) when parameters.json leaves
 * them blank. Explicit values in parameters.json always win.
 *
 * Prints CDK context arguments on stdout, one `key=value` per line, for
 * deploy.sh to pass as `-c key=value`. Messages go to stderr. On any failure
 * it prints nothing on stdout and exits 0, so the deploy continues with a
 * blank issuer and mimir-handler stays fail closed (every action rejected).
 *
 * Runs at deploy time, not in cdk synth: synth must stay offline and
 * deterministic (CI synth, cdk diff), and not in the Lambda: no runtime
 * dependency on Mimir for trust decisions.
 */
const fs = require('fs');

const COGNITO_ISSUER_RE = /^https:\/\/cognito-idp\.([a-z0-9-]+)\.amazonaws\.com\/([A-Za-z0-9_-]+)$/;
const CLIENT_ID_RE = /^[A-Za-z0-9]{1,128}$/;

function readParams(file) {
  if (!fs.existsSync(file)) return {};
  const list = JSON.parse(fs.readFileSync(file, 'utf8'));
  const out = {};
  for (const p of Array.isArray(list) ? list : []) {
    if (p && p.ParameterKey) out[p.ParameterKey] = String(p.ParameterValue ?? '').trim();
  }
  return out;
}

/** Same rule the stack uses: MIMIR_API_BASE, else https://<MimirInstance>.mjoll.no. */
function mimirBaseUrl(params, env) {
  const base = (env.MIMIR_API_BASE || `https://${params.MimirInstance || 'us'}.mjoll.no`).replace(/\/+$/, '');
  if (!/^https:\/\/[A-Za-z0-9.-]+(:\d+)?$/.test(base)) throw new Error(`Mimir base URL must be https://<host>, got ${JSON.stringify(base)}`);
  return base;
}

/** Fetches and validates `<base>/api/v1` clientConfig. Returns { issuer, audience }. */
async function discover(base, fetchImpl = fetch) {
  const res = await fetchImpl(`${base}/api/v1`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`GET ${base}/api/v1 returned HTTP ${res.status}`);
  const c = (await res.json())?.clientConfig || {};
  const issuer = c.cognitoEndpoint || (c.authRegion && c.userPoolId ? `https://cognito-idp.${c.authRegion}.amazonaws.com/${c.userPoolId}` : '');
  const m = COGNITO_ISSUER_RE.exec(issuer);
  if (!m) throw new Error(`${base}/api/v1 has no usable clientConfig.cognitoEndpoint`);
  if ((c.userPoolId && c.userPoolId !== m[2]) || (c.authRegion && c.authRegion !== m[1])) {
    throw new Error(`${base}/api/v1 clientConfig is inconsistent (cognitoEndpoint does not match userPoolId/authRegion)`);
  }
  const audience = CLIENT_ID_RE.test(c.appClientId || '') ? c.appClientId : '';
  return { issuer, audience };
}

/** Returns the CDK context to add: only keys left blank in parameters.json. */
async function deriveContext(params, env, fetchImpl = fetch) {
  const explicitIssuer = params.MimirAllowedIssuer || '';
  const explicitAudience = params.MimirAllowedAudience || '';
  if (explicitIssuer && explicitAudience) return {};
  const base = mimirBaseUrl(params, env);
  const found = await discover(base, fetchImpl);
  const ctx = {};
  if (!explicitIssuer) ctx.mimirAllowedIssuer = found.issuer;
  // The audience only makes sense for the discovered pool's own client.
  if (!explicitAudience && found.audience && (explicitIssuer || found.issuer) === found.issuer) {
    ctx.mimirAllowedAudience = found.audience;
  }
  return ctx;
}

async function main() {
  const file = process.argv[2] || 'parameters.json';
  try {
    const params = readParams(file);
    const ctx = await deriveContext(params, process.env);
    for (const [k, v] of Object.entries(ctx)) {
      console.error(`🔐 ${k} derived from Mimir's public config: ${v}`);
      console.log(`${k}=${v}`);
    }
    if (Object.keys(ctx).length === 0) console.error('🔐 MimirAllowedIssuer/MimirAllowedAudience taken from parameters.json');
  } catch (err) {
    console.error(`⚠  Could not derive MimirAllowedIssuer from Mimir's public config: ${err.message}`);
    console.error('⚠  Deploying with MimirAllowedIssuer blank: every Mimir custom action will be rejected (401) until you set it in parameters.json and redeploy.');
  }
}

module.exports = { readParams, mimirBaseUrl, discover, deriveContext };
if (require.main === module) main();
