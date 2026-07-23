const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');

const s3Client = new S3Client();
const secretsClient = new SecretsManagerClient();

const MIMIR_BASE_URL = process.env.MIMIR_API_BASE || 'https://us.mjoll.no';
let cachedMimirApiKey = null;

async function getMimirApiKey() {
  if (cachedMimirApiKey) return cachedMimirApiKey;
  const response = await secretsClient.send(
    new GetSecretValueCommand({ SecretId: process.env.MIMIR_API_KEY_SECRET_ARN })
  );
  cachedMimirApiKey = response.SecretString;
  return cachedMimirApiKey;
}

/**
 * Classify a video clip based on its transcript content.
 *
 * Heuristics:
 * - B-roll: very low word count relative to duration (< 1 word per 2 seconds)
 * - Interview: high word count, multiple speakers or Q&A patterns
 * - Camera: default / single speaker narration
 */
function classifyFromTranscript(transcript, durationSeconds) {
  const fullText = transcript.fullTranscript || '';
  const words = fullText.trim().split(/\s+/).filter(w => w.length > 0);
  const wordCount = words.length;
  const sentences = transcript.sentences || [];

  // Words per second ratio
  const wps = durationSeconds > 0 ? wordCount / durationSeconds : 0;

  console.log(`Classification input: ${wordCount} words, ${durationSeconds}s duration, ${wps.toFixed(2)} wps, ${sentences.length} sentences`);

  // B-roll: very little speech (regardless of duration)
  if (wordCount < 50) {
    console.log('Classified as: b_roll (low word count < 50)');
    return 'b_roll';
  }

  // B-roll: low words-per-second ratio on longer clips
  if (wps < 0.5 && durationSeconds > 5) {
    console.log('Classified as: b_roll (low wps ratio)');
    return 'b_roll';
  }

  // Interview: high word count with conversational patterns
  const hasQuestions = (fullText.match(/\?/g) || []).length >= 2;
  const hasMultipleSpeakers = detectMultipleSpeakers(sentences);

  if (wordCount > 200 && (hasQuestions || hasMultipleSpeakers)) {
    console.log(`Classified as: interview (high wordCount=${wordCount}, questions=${hasQuestions}, multiSpeaker=${hasMultipleSpeakers})`);
    return 'interview';
  }

  // Interview: sustained speech (wps > 1.5 with meaningful word count)
  if (wps > 1.5 && wordCount > 50) {
    console.log(`Classified as: interview (sustained speech wps=${wps.toFixed(2)}, words=${wordCount})`);
    return 'interview';
  }

  // Default: camera (raw footage — ambiguous content)
  console.log('Classified as: camera (default)');
  return 'camera';
}

/**
 * Detect if transcript has multiple speakers by looking for
 * significant gaps between sentences (speaker changes often have pauses)
 * and variation in sentence lengths.
 */
function detectMultipleSpeakers(sentences) {
  if (sentences.length < 4) return false;

  // Look for gaps > 2 seconds between sentences (speaker change indicator)
  let gapCount = 0;
  for (let i = 1; i < sentences.length; i++) {
    const gap = (sentences[i].startTime || 0) - (sentences[i - 1].endTime || 0);
    if (gap > 2.0) gapCount++;
  }

  // Multiple significant gaps suggest speaker changes
  return gapCount >= 3;
}

exports.handler = async (event) => {
  const { itemId, title } = event;
  const bucket = process.env.TRANSCRIPT_STAGING_BUCKET;

  if (!itemId) {
    throw new Error('itemId is required');
  }

  console.log(`Classifying clip: ${itemId} (${title || 'untitled'})`);

  // Check if the item's content type is "raw" — skip classification for other types
  // (e.g. wire feeds, packages, etc.)
  const apiKey = await getMimirApiKey();
  let itemData;
  try {
    const itemResp = await fetch(`${MIMIR_BASE_URL}/api/v1/items/${itemId}`, {
      headers: {
        'Accept': 'application/json',
        'x-mimir-cognito-id-token': `Bearer ${apiKey}`,
      },
    });
    itemData = await itemResp.json();
  } catch (err) {
    console.error(`Failed to fetch item details: ${err.message}`);
    return { itemId, clipType: 'unknown', title: title || '', skipped: true };
  }

  const contentTypeFieldId = 'b6cf1a25-f765-4284-bcac-1823b9c5ea0f';
  const contentType = itemData?.metadata?.formData?.[contentTypeFieldId] || '';
  if (contentType !== 'raw') {
    console.log(`Skipping classification — content type is "${contentType}", not "raw"`);
    return { itemId, clipType: 'skipped', title: title || '', contentType };
  }

  // Read the generated transcript from S3
  let transcript = { fullTranscript: '', sentences: [] };
  let durationSeconds = 0;

  try {
    const key = `transcripts/${itemId}/transcript.json`;
    const resp = await s3Client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const body = await resp.Body.transformToString();
    transcript = JSON.parse(body);

    // Get duration from sentences
    if (transcript.sentences && transcript.sentences.length > 0) {
      const lastSentence = transcript.sentences[transcript.sentences.length - 1];
      durationSeconds = lastSentence.endTime || 0;
    }
  } catch (err) {
    console.log(`No transcript found for ${itemId}, defaulting to camera: ${err.message}`);
    // No transcript = can't classify, default to camera
  }

  // Classify
  const clipType = classifyFromTranscript(transcript, durationSeconds);

  // Write classification to Mimir metadata
  const typeFieldId = '5f8419b0-8930-43f2-95c9-429f1dab2098';

  try {
    // Use the item data we already fetched to get current type values
    const currentTypes = itemData?.metadata?.formData?.[typeFieldId] || [];

    // Add our classification if not already present
    const newTypes = Array.isArray(currentTypes) ? [...currentTypes] : [];
    if (!newTypes.includes(clipType)) {
      newTypes.push(clipType);
    }

    // Write metadata — use the item's current formId to avoid overwriting
    const currentFormId = itemData?.metadata?.formId || 'default';
    const patchResp = await fetch(`${MIMIR_BASE_URL}/api/v1/itemMetadata/${itemId}`, {
      method: 'PATCH',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'x-mimir-cognito-id-token': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        metadataDelta: {
          formId: currentFormId,
          formData: {
            [typeFieldId]: newTypes,
          },
        },
      }),
    });

    if (!patchResp.ok) {
      const errText = await patchResp.text();
      console.error(`Failed to update metadata: ${patchResp.status} ${errText}`);
    } else {
      console.log(`Updated Mimir metadata: type=${JSON.stringify(newTypes)} for item ${itemId}`);
    }
  } catch (err) {
    console.error(`Failed to update Mimir metadata: ${err.message}`);
    // Non-fatal — don't fail the pipeline
  }

  return {
    itemId,
    clipType,
    title: title || '',
  };
};
