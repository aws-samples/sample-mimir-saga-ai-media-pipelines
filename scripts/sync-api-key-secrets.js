#!/usr/bin/env node
/**
 * Copy the Mimir/Saga API keys from parameters.json into a stack's Secrets
 * Manager secrets.
 *
 *   node scripts/sync-api-key-secrets.js <stack-name>
 *
 * The CDK stacks create these secrets without a value, so the keys never appear
 * in a CloudFormation template or in cdk.out. deploy.sh runs this script after
 * each deploy (and, for an existing CoreStack, before it, so the Mimir
 * registration custom resource uses the current key).
 *
 * The secrets are found through the stack outputs below. A secret is written
 * only when parameters.json has a different value. When parameters.json has no
 * value and the secret is still empty, a placeholder is written so readers get
 * an auth error instead of ResourceNotFoundException. An existing value is never
 * cleared, so a key set directly in Secrets Manager survives a deploy.
 *
 * Secret values stay in memory: they are never logged, printed, or passed on a
 * command line. Output names the stack output and the action only.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const {
  SecretsManagerClient,
  GetSecretValueCommand,
  PutSecretValueCommand,
} = require('@aws-sdk/client-secrets-manager');

// Stack output key -> parameters.json key, and the value used when both are empty.
const SECRETS = [
  { output: 'MimirApiKeyArn', param: 'MimirApiKey', placeholder: 'placeholder-update-after-deployment' },
  { output: 'SagaApiKeyArn', param: 'SagaApiKey', placeholder: 'placeholder-update-after-deployment' },
  { output: 'SagaApiUrlArn', param: 'SagaApiUrl', placeholder: 'https://us.mjoll.no' },
];

function readParameters() {
  const file = path.join(__dirname, '..', 'parameters.json');
  if (!fs.existsSync(file)) return {};
  const values = {};
  for (const p of JSON.parse(fs.readFileSync(file, 'utf-8'))) {
    if (p.ParameterKey && p.ParameterValue) values[p.ParameterKey] = String(p.ParameterValue);
  }
  return values;
}

function stackOutputs(stackName, region) {
  const args = ['cloudformation', 'describe-stacks', '--stack-name', stackName,
    '--query', 'Stacks[0].Outputs', '--output', 'json'];
  if (region) args.push('--region', region);
  let out;
  try {
    out = execFileSync('aws', args, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    if (/does not exist/.test(String(err.stderr))) return null;
    throw new Error(`describe-stacks ${stackName} failed: ${String(err.stderr).trim()}`);
  }
  const map = {};
  for (const o of JSON.parse(out) || []) map[o.OutputKey] = o.OutputValue;
  return map;
}

async function currentValue(client, secretId) {
  try {
    const res = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
    return res.SecretString;
  } catch (err) {
    // An empty secret has no AWSCURRENT version yet.
    if (err.name === 'ResourceNotFoundException') return undefined;
    throw err;
  }
}

async function main() {
  const [stackName] = process.argv.slice(2);
  if (!stackName) {
    console.error('Usage: node scripts/sync-api-key-secrets.js <stack-name>');
    process.exit(2);
  }
  const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION;

  const outputs = stackOutputs(stackName, region);
  if (!outputs) throw new Error(`stack ${stackName} does not exist`);

  const params = readParameters();
  const client = new SecretsManagerClient(region ? { region } : {});

  for (const s of SECRETS) {
    const arn = outputs[s.output];
    if (!arn) {
      // Expected for SagaApiKeyArn/SagaApiUrlArn on a CoreStack deployed before
      // these outputs existed; the post-deploy run picks them up.
      console.log(`  ${s.output}: no such output on ${stackName}, skipped`);
      continue;
    }
    const current = await currentValue(client, arn);
    let desired = params[s.param];
    if (!desired) {
      if (current !== undefined) {
        console.log(`  ${s.output}: ${s.param} empty in parameters.json, kept existing value`);
        continue;
      }
      desired = s.placeholder;
      console.log(`  ${s.output}: ${s.param} empty in parameters.json, writing placeholder`);
    }
    if (desired === current) {
      console.log(`  ${s.output}: unchanged`);
      continue;
    }
    await client.send(new PutSecretValueCommand({ SecretId: arn, SecretString: desired }));
    console.log(`  ${s.output}: updated`);
  }
}

main().catch((err) => {
  // AWS SDK and CLI errors name the secret and the cause, never its value.
  console.error(`❌ API key sync failed: ${err.name || 'Error'}: ${err.message}`);
  process.exit(1);
});
