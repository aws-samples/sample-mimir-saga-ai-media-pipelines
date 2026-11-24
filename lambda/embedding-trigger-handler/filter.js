/**
 * Optional metadata filter for the embedding pipeline.
 *
 * Configured with the EmbeddingsFilterField / EmbeddingsFilterValues
 * (and optional EmbeddingsFilterFieldKey) deployment parameters, which CDK
 * passes to this Lambda as:
 *   EMBEDDINGS_FILTER_FIELD      Mimir metadata fieldId, e.g. 'Station'
 *   EMBEDDINGS_FILTER_VALUES     JSON array of accepted values
 *   EMBEDDINGS_FILTER_FIELD_KEY  optional explicit metadata.formData key
 *   MIMIR_API_BASE / MIMIR_API_KEY_SECRET_ARN  for the MDF lookup (only set
 *                                when no explicit key is configured)
 *
 * The Mimir webhook carries the same filter server-side and is the primary
 * gate: Mimir normally never calls us for other items. This check is the
 * defensive second layer (webhook edited by hand, executions started by
 * scripts/retrigger-embeddings.sh, etc.).
 *
 * Mimir does not key metadata.formData by fieldId. Default-MDF text/date
 * fields use `default_<fieldId>`, choice fields use the field's UUID
 * (Station -> 'edd3e918-…'). The value is resolved by trying, in order:
 * formData[fieldId], formData['default_' + fieldId], formData[<field UUID>],
 * where the UUID comes from the Mimir MDF definitions (GET /api/v1/mdfs/default,
 * then GET /api/v1/mdfs) and is cached per Lambda container.
 *
 * If the field cannot be resolved (unknown fieldId, lookup failed), the item is
 * let THROUGH with one log line: a config mistake must never silently stop all
 * embeddings.
 *
 * Matching is exact and case-sensitive on the stored value. Plain values,
 * arrays (multiplechoice, treechoice) and {value,label} objects are accepted;
 * for arrays the item matches when any element is one of the accepted values.
 */

function readFilterFromEnv(env = process.env) {
  const field = (env.EMBEDDINGS_FILTER_FIELD || '').trim();
  if (!field) return null;
  let values;
  try {
    values = JSON.parse(env.EMBEDDINGS_FILTER_VALUES || '[]');
  } catch {
    throw new Error('EMBEDDINGS_FILTER_VALUES must be a JSON array of strings');
  }
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error('EMBEDDINGS_FILTER_VALUES must be a non-empty JSON array when EMBEDDINGS_FILTER_FIELD is set');
  }
  const fieldKey = (env.EMBEDDINGS_FILTER_FIELD_KEY || '').trim() || null;
  return { field, fieldKey, values: values.map(String) };
}

function isPresent(v) {
  return v !== undefined && v !== null;
}

/** Flattens a formData value into comparable strings. */
function valueCandidates(raw) {
  const list = Array.isArray(raw) ? raw : [raw];
  const out = [];
  for (const v of list) {
    if (!isPresent(v)) continue;
    if (typeof v === 'object') {
      if (isPresent(v.value)) out.push(String(v.value));
    } else {
      out.push(String(v));
    }
  }
  return out;
}

/** True when the raw formData value (any shape) is one of the accepted values. */
function valueMatches(raw, values) {
  if (!isPresent(raw)) return false;
  return valueCandidates(raw).some((v) => values.includes(v));
}

/**
 * Kept for callers that already know the key. Matches formData[filter.field]
 * (or filter.fieldKey when set).
 */
function matchesFilter(formData, filter) {
  if (!filter) return true;
  const key = filter.fieldKey || filter.field;
  return valueMatches(formData ? formData[key] : undefined, filter.values);
}

// ---- MDF lookup: fieldId -> field UUID (cached per container) -------------

const fieldUuidCache = new Map();
let cachedApiKey = null;

async function getMimirApiKey(env = process.env) {
  if (cachedApiKey) return cachedApiKey;
  if (!env.MIMIR_API_KEY_SECRET_ARN) throw new Error('MIMIR_API_KEY_SECRET_ARN is not set');
  // Lazy require: the SDK is in the Lambda runtime; tests inject getApiKey instead.
  const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
  const res = await new SecretsManagerClient().send(
    new GetSecretValueCommand({ SecretId: env.MIMIR_API_KEY_SECRET_ARN }),
  );
  cachedApiKey = res.SecretString;
  return cachedApiKey;
}

function findFieldUuid(fields, fieldId) {
  const f = (fields || []).find((x) => x && x.fieldId === fieldId);
  return f && f.id ? f.id : null;
}

/**
 * Looks up the UUID of `fieldId` in the Mimir MDF definitions, the same
 * endpoints scripts/get-mimir-metadata-fields.js uses: the default MDF first,
 * then any MDF in the list response that carries its fields inline.
 * shortcut: MDFs listed without inline fields are not fetched one by one (a
 * tenant can have hundreds); use EmbeddingsFilterFieldKey for such fields.
 * Returns null when not found. Throws on HTTP errors.
 */
async function lookupFieldUuid(fieldId, { fetchFn = fetch, apiKey, baseUrl }) {
  const headers = { Accept: 'application/json', 'x-mimir-cognito-id-token': `Bearer ${apiKey}` };
  const getJson = async (path) => {
    const res = await fetchFn(`${baseUrl}${path}`, { method: 'GET', headers });
    if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`);
    return res.json();
  };

  const defaultMdf = await getJson('/api/v1/mdfs/default');
  const fromDefault = findFieldUuid(defaultMdf.fields, fieldId);
  if (fromDefault) return fromDefault;

  const list = await getJson('/api/v1/mdfs');
  for (const mdf of list?._embedded?.collection || []) {
    const uuid = findFieldUuid(mdf.fields, fieldId);
    if (uuid) return uuid;
  }
  return null;
}

async function resolveFieldUuid(fieldId, deps = {}) {
  if (fieldUuidCache.has(fieldId)) return fieldUuidCache.get(fieldId);
  const env = deps.env || process.env;
  const apiKey = await (deps.getApiKey || (() => getMimirApiKey(env)))();
  const baseUrl = env.MIMIR_API_BASE || 'https://us.mjoll.no';
  const uuid = await lookupFieldUuid(fieldId, { fetchFn: deps.fetchFn || fetch, apiKey, baseUrl });
  if (uuid) fieldUuidCache.set(fieldId, uuid); // only successes are cached
  return uuid;
}

function clearCache() {
  fieldUuidCache.clear();
  cachedApiKey = null;
}

/**
 * Picks the freshest formData available in the embedding state machine input:
 * the item fetched by GetMimirDetailsEmbed, else the webhook payload's copy.
 */
function pickFormData(event) {
  return event?.mimirDetails?.metadata?.formData || event?.metadata?.formData || {};
}

/**
 * Returns { resolved: true, raw } with the item's value (possibly undefined),
 * or { resolved: false, reason } when the field's formData key is unknown.
 */
async function resolveValue(formData, filter, deps) {
  if (filter.fieldKey) return { resolved: true, raw: formData[filter.fieldKey] };
  if (isPresent(formData[filter.field])) return { resolved: true, raw: formData[filter.field] };
  const defaultKey = `default_${filter.field}`;
  if (isPresent(formData[defaultKey])) return { resolved: true, raw: formData[defaultKey] };
  let uuid;
  try {
    uuid = await resolveFieldUuid(filter.field, deps);
  } catch (err) {
    return { resolved: false, reason: `lookup failed: ${err.message}` };
  }
  if (!uuid) return { resolved: false, reason: 'field not found in Mimir MDFs' };
  return { resolved: true, raw: formData[uuid] };
}

async function handleFilter(event, deps = {}) {
  const env = deps.env || process.env;
  const filter = readFilterFromEnv(env);
  if (!filter) return { match: true };
  const formData = pickFormData(event);
  const { resolved, raw, reason } = await resolveValue(formData, filter, { ...deps, env });
  if (!resolved) {
    console.log(`filter field unresolved, letting item through: field=${filter.field} item=${event?.itemId} (${reason}). Set EmbeddingsFilterFieldKey to the formData key.`);
    return { match: true };
  }
  const match = valueMatches(raw, filter.values);
  if (!match) {
    // Item id only: metadata values can carry tenant data.
    console.log(`skipped: filter mismatch item=${event?.itemId}`);
  }
  return { match };
}

module.exports = {
  readFilterFromEnv,
  matchesFilter,
  valueMatches,
  pickFormData,
  lookupFieldUuid,
  resolveFieldUuid,
  handleFilter,
  clearCache,
};
