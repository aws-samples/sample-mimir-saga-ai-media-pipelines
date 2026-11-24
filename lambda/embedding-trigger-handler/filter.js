/**
 * Optional metadata filter for the embedding pipeline.
 *
 * Configured with the EmbeddingsFilterField / EmbeddingsFilterValues
 * deployment parameters, which CDK passes to this Lambda as:
 *   EMBEDDINGS_FILTER_FIELD   Mimir metadata field id (a key of metadata.formData)
 *   EMBEDDINGS_FILTER_VALUES  JSON array of accepted values
 *
 * The Mimir webhook carries the same filter server-side, so Mimir normally
 * never calls us for other items. This check is the defensive second layer
 * (webhook edited by hand, executions started by scripts/retrigger-embeddings.sh,
 * etc.).
 *
 * Matching is exact and case-sensitive on the string form of the value. For
 * array-valued fields (multi-select, tree choice) the item matches when any
 * element equals one of the accepted values.
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
  return { field, values: values.map(String) };
}

function matchesFilter(formData, filter) {
  if (!filter) return true;
  const raw = formData ? formData[filter.field] : undefined;
  if (raw === undefined || raw === null) return false;
  const candidates = Array.isArray(raw) ? raw : [raw];
  return candidates.some((v) => v !== null && v !== undefined && filter.values.includes(String(v)));
}

/**
 * Picks the freshest formData available in the embedding state machine input:
 * the item fetched by GetMimirDetailsEmbed, else the webhook payload's copy.
 */
function pickFormData(event) {
  return event?.mimirDetails?.metadata?.formData || event?.metadata?.formData || {};
}

function handleFilter(event, env = process.env) {
  const filter = readFilterFromEnv(env);
  const match = matchesFilter(pickFormData(event), filter);
  if (!match) {
    // Item id only: metadata values can carry tenant data.
    console.log(`skipped: filter mismatch item=${event?.itemId}`);
  }
  return { match };
}

module.exports = { readFilterFromEnv, matchesFilter, pickFormData, handleFilter };
