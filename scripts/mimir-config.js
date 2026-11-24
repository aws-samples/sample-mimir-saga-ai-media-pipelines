// Shared Mimir settings for the read-only helper scripts.
// API key: MIMIR_API_KEY env var first, then parameters.json (the array of
// {ParameterKey, ParameterValue} used by deploy; the older flat
// { mimirApiKey } object is still accepted). The key is never printed.
const fs = require('fs');
const path = require('path');

const PARAMETERS_PATH = path.join(__dirname, '..', 'parameters.json');

function readParameter(name) {
  if (!fs.existsSync(PARAMETERS_PATH)) return undefined;
  const params = JSON.parse(fs.readFileSync(PARAMETERS_PATH, 'utf8'));
  if (Array.isArray(params)) {
    const entry = params.find((p) => p && p.ParameterKey === name);
    return entry && entry.ParameterValue ? entry.ParameterValue : undefined;
  }
  const legacyKey = name.charAt(0).toLowerCase() + name.slice(1);
  return params[name] || params[legacyKey] || undefined;
}

function getMimirApiKey() {
  const key = process.env.MIMIR_API_KEY || readParameter('MimirApiKey');
  if (!key) {
    throw new Error('Mimir API key not found: set MIMIR_API_KEY or MimirApiKey in parameters.json');
  }
  return key;
}

function getMimirInstance() {
  return process.env.MIMIR_INSTANCE || readParameter('MimirInstance') || 'us';
}

module.exports = { getMimirApiKey, getMimirInstance };
