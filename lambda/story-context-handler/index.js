const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
const { S3VectorsClient, GetVectorsCommand } = require('@aws-sdk/client-s3vectors');

const secretsClient = new SecretsManagerClient();
const s3VectorsClient = new S3VectorsClient();

const MIMIR_BASE_URL = process.env.MIMIR_API_BASE || 'https://us.mjoll.no';

// Module-level cache for secrets
const secretCache = {};

/**
 * Retrieves a secret value from Secrets Manager with caching.
 * @param {string} secretArn - The ARN of the secret to retrieve
 * @returns {Promise<string>} The secret string value
 */
async function getSecretValue(secretArn) {
  if (secretCache[secretArn]) return secretCache[secretArn];

  const response = await secretsClient.send(
    new GetSecretValueCommand({ SecretId: secretArn })
  );
  secretCache[secretArn] = response.SecretString;
  return secretCache[secretArn];
}

/**
 * Calls a Saga API endpoint and returns the parsed JSON response.
 * On non-2xx responses, throws an error containing the endpoint path and HTTP status code.
 * @param {string} baseUrl - The Saga API base URL
 * @param {string} path - The endpoint path (e.g. /stories/123/assets)
 * @param {string} apiKey - The Saga API key for x-api-key header
 * @returns {Promise<object>} Parsed JSON response
 */
async function callSagaApi(baseUrl, path, apiKey) {
  const url = `${baseUrl}${path}`;
  console.log(`Calling Saga API: ${path}`);

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'x-api-key': apiKey,
      'Accept': 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(
      `Saga API error: ${path} returned status ${response.status}`
    );
  }

  return response.json();
}

/**
 * Checks if a video asset has embeddings stored in the S3 Vector Index.
 * Uses GetVectors to look up the first segment key for the item.
 * @param {string} itemId - The Mimir item ID
 * @returns {Promise<boolean>} true if embeddings exist
 */
async function checkEmbeddings(itemId) {
  const vectorBucketName = process.env.VECTOR_BUCKET_NAME;
  const indexName = process.env.VECTOR_INDEX_NAME;

  try {
    const response = await s3VectorsClient.send(new GetVectorsCommand({
      vectorBucketName,
      indexName,
      keys: [`${itemId}/segment-0`],
    }));
    return response.vectors && response.vectors.length > 0;
  } catch (err) {
    console.warn(`Embedding check failed for item ${itemId}:`, err.message);
    return false;
  }
}

/**
 * Checks if a video asset has a timed transcript available via the Mimir API.
 * @param {string} itemId - The Mimir item ID
 * @param {string} mimirApiKey - The Mimir API key for authentication
 * @returns {Promise<{hasTranscript: boolean, timedTranscriptUrl?: string}>}
 */
async function checkTranscript(itemId, mimirApiKey) {
  try {
    const url = `${MIMIR_BASE_URL}/api/v1/items/${itemId}`;
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'x-mimir-cognito-id-token': `Bearer ${mimirApiKey}`,
      },
    });

    if (!response.ok) {
      console.warn(`Mimir API returned ${response.status} for item ${itemId}`);
      return { hasTranscript: false };
    }

    const item = await response.json();
    const timedTranscriptUrl = item.timedTranscriptUrl;
    const hasTranscript = typeof timedTranscriptUrl === 'string' && timedTranscriptUrl.length > 0;

    return { hasTranscript, timedTranscriptUrl: hasTranscript ? timedTranscriptUrl : undefined };
  } catch (err) {
    console.warn(`Transcript check failed for item ${itemId}:`, err.message);
    return { hasTranscript: false };
  }
}

/**
 * Enriches a list of assets with embedding and transcript availability flags.
 * Assets with neither embeddings nor transcripts get a warning message.
 * @param {Array} assets - The raw asset list from Saga API
 * @param {string} mimirApiKey - The Mimir API key
 * @returns {Promise<Array>} Enriched asset list with same length as input
 */
async function enrichAssets(assets, mimirApiKey) {
  const enriched = await Promise.all(
    assets.map(async (asset) => {
      // Saga uses 'externalId' for the Mimir item ID (when provider is 'mimir')
      const itemId = asset.externalId || asset.mimirItemId;
      if (!itemId) {
        console.warn(`Asset ${asset.id} has no externalId or mimirItemId — skipping enrichment`);
        return {
          id: asset.id,
          mimirItemId: null,
          title: asset.title,
          itemType: asset.itemType,
          hasEmbeddings: false,
          hasTranscript: false,
          warning: 'No Mimir item ID — cannot check embeddings or transcript',
        };
      }

      const [hasEmbeddings, transcriptResult] = await Promise.all([
        checkEmbeddings(itemId),
        checkTranscript(itemId, mimirApiKey),
      ]);

      const warning =
        !hasEmbeddings && !transcriptResult.hasTranscript
          ? 'Limited searchability: no embeddings or transcript available'
          : undefined;

      return {
        id: asset.id,
        mimirItemId: itemId,
        title: asset.title,
        itemType: asset.itemType,
        hasEmbeddings,
        hasTranscript: transcriptResult.hasTranscript,
        timedTranscriptUrl: transcriptResult.timedTranscriptUrl,
        warning,
      };
    })
  );

  return enriched;
}

exports.handler = async (event) => {
  console.log('Story context handler received:', JSON.stringify(event, null, 2));

  const { storyId, sagaApiKeySecretArn, sagaApiUrlSecretArn, mimirApiKey } = event;

  // Retrieve secrets (cached after first invocation)
  const sagaApiKey = await getSecretValue(sagaApiKeySecretArn);
  const sagaApiUrl = await getSecretValue(sagaApiUrlSecretArn);

  // Call all four Saga endpoints
  const storyPath = `/stories/${storyId}`;
  const assetsPath = `/stories/${storyId}/assets`;
  const instancesPath = `/stories/${storyId}/instances`;
  const notesPath = `/stories/${storyId}/notes`;

  const [storyResponse, assetsResponse, instancesResponse, notesResponse] = await Promise.all([
    callSagaApi(sagaApiUrl, storyPath, sagaApiKey),
    callSagaApi(sagaApiUrl, assetsPath, sagaApiKey),
    callSagaApi(sagaApiUrl, instancesPath, sagaApiKey),
    callSagaApi(sagaApiUrl, notesPath, sagaApiKey),
  ]);

  // Saga API wraps list responses in envelopes: { type, timestamp, assets/instances/notes, links }
  // Story response is flat (not wrapped).
  const story = storyResponse;
  const assets = assetsResponse.assets || assetsResponse || [];
  const instances = instancesResponse.instances || instancesResponse || [];
  const notes = notesResponse.notes || notesResponse || [];

  console.log(`Story "${story.mTitle}" fetched with ${assets.length} assets, ${instances.length} instances, ${notes.length} notes`);

  // Fetch story content from contentUrl if available
  if (story.contentUrl) {
    try {
      console.log('Fetching story content from contentUrl');
      const contentResponse = await fetch(story.contentUrl);
      console.log(`Story content response status: ${contentResponse.status}`);
      if (contentResponse.ok) {
        const contentText = await contentResponse.text();
        console.log(`Story content length: ${contentText.length} chars`);
        try {
          story.content = JSON.parse(contentText);
        } catch {
          story.content = contentText;
        }
      } else {
        console.warn(`Failed to fetch story content: ${contentResponse.status}`);
      }
    } catch (err) {
      console.warn('Error fetching story content:', err.message);
    }
  }

  // Fetch instance content (script/rundown) from contentUrl if available
  const enrichedInstances = await Promise.all(
    instances.map(async (instance) => {
      if (instance.contentUrl) {
        try {
          console.log(`Fetching instance content for: ${instance.id}`);
          const contentResponse = await fetch(instance.contentUrl);
          console.log(`Instance content response status: ${contentResponse.status}`);
          if (contentResponse.ok) {
            const contentText = await contentResponse.text();
            console.log(`Instance content length: ${contentText.length} chars`);
            // Try to parse as JSON, fall back to raw text
            try {
              instance.content = JSON.parse(contentText);
            } catch {
              instance.content = contentText;
            }
          } else {
            console.warn(`Failed to fetch instance content for ${instance.id}: ${contentResponse.status}`);
          }
        } catch (err) {
          console.warn(`Error fetching instance content for ${instance.id}:`, err.message);
        }
      }
      return instance;
    })
  );

  // Notes are returned by the list endpoint with a `description` field containing
  // the AI-generated research text (written there by story-research-handler).
  // Filter to only notes that have actual content so the agent isn't given empty shells.
  const enrichedNotes = notes
    .filter(note => note.description || note.title)
    .map(note => ({
      id: note.id,
      title: note.title,
      description: note.description || null,
      updatedAt: note.updatedAt,
    }));

  console.log(`Notes: ${notes.length} total, ${enrichedNotes.length} with content`);

  // Enrich assets with embedding and transcript availability
  const enrichedAssets = await enrichAssets(assets, mimirApiKey);

  return {
    story,
    assets: enrichedAssets,
    instances: enrichedInstances,
    notes: enrichedNotes,
  };
};

// Exported for testing
exports.getSecretValue = getSecretValue;
exports.callSagaApi = callSagaApi;
exports.checkEmbeddings = checkEmbeddings;
exports.checkTranscript = checkTranscript;
exports.enrichAssets = enrichAssets;
