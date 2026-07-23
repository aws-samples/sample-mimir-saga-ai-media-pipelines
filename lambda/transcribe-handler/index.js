const { S3Client, ListObjectsV2Command, GetObjectCommand, PutObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');
const { TranscribeClient, StartTranscriptionJobCommand, GetTranscriptionJobCommand } = require('@aws-sdk/client-transcribe');
const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');

const s3Client = new S3Client();
const transcribeClient = new TranscribeClient();
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
 * Publishes a previously-generated transcript back to Mimir so it becomes the
 * item's official transcript (searchable, reusable for summaries/captions).
 *
 * Reads transcripts/{itemId}/transcript.json (produced by poll-transcribe),
 * flattens the word-level timing into Mimir's timedTranscript format (times in
 * milliseconds, one word per entry), and calls PUT /api/v1/items/{id}/transcript.
 */
async function handlePublishTranscript(event) {
  const { itemId, mimirApiKey, languageCode } = event;
  const bucket = process.env.VIDEO_STAGING_BUCKET;
  if (!itemId) throw new Error('itemId is required');

  const apiKey = mimirApiKey || await getMimirApiKey();
  const key = `transcripts/${itemId}/transcript.json`;

  const resp = await s3Client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const converted = JSON.parse(await resp.Body.transformToString());

  // Flatten sentences[].words[] (times in seconds) → timedTranscript (ms).
  const timedTranscript = [];
  for (const sentence of converted.sentences || []) {
    for (const w of sentence.words || []) {
      if (!w.word) continue;
      timedTranscript.push({
        content: w.word,
        startTime: Math.round((w.startTime || 0) * 1000),
        endTime: Math.round((w.endTime || 0) * 1000),
      });
    }
  }

  if (timedTranscript.length === 0) {
    console.log(`No words to publish for item ${itemId}`);
    return { itemId, published: false, reason: 'empty transcript' };
  }

  const putResp = await fetch(`${MIMIR_BASE_URL}/api/v1/items/${itemId}/transcript`, {
    method: 'PUT',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'x-mimir-cognito-id-token': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ languageCode: languageCode || 'en-US', timedTranscript }),
  });

  if (!putResp.ok) {
    const body = await putResp.text().catch(() => '');
    throw new Error(`Mimir transcript publish failed: ${putResp.status} ${body.slice(0, 200)}`);
  }

  console.log(`Published transcript to Mimir item ${itemId} (${timedTranscript.length} words)`);
  return { itemId, published: true, wordCount: timedTranscript.length };
}

/**
 * Parses an S3 URI into { bucket, key }. Returns null when the URI is malformed.
 */
function parseS3Uri(s3Uri) {
  const match = (s3Uri || '').match(/^s3:\/\/([^/]+)\/(.+)$/);
  if (!match) return null;
  return { bucket: match[1], key: match[2] };
}

/**
 * Tests whether this account can read an S3 object via HeadObject. Used to decide
 * whether we can point Transcribe directly at the customer's source object (the
 * common case when the custom action is deployed in the customer's own account)
 * or must first stage the proxy into our own bucket (cross-account testing).
 */
async function handleCheckAccess(event) {
  const { s3Uri } = event;
  const parsed = parseS3Uri(s3Uri);
  if (!parsed) {
    return { accessible: false, reason: 'invalid or empty s3Uri' };
  }
  try {
    await s3Client.send(new HeadObjectCommand({ Bucket: parsed.bucket, Key: parsed.key }));
    console.log(`S3 access confirmed: ${s3Uri}`);
    return { accessible: true, s3Uri };
  } catch (err) {
    console.log(`S3 access denied for ${s3Uri}: ${err.name} - ${err.message}`);
    return { accessible: false, reason: err.name };
  }
}

// Amazon Transcribe MediaFormat enum. Anything else falls back to mp4 (our proxy
// is always mp4, and most stored masters we transcribe are mp4 containers).
const TRANSCRIBE_MEDIA_FORMATS = new Set(['mp3', 'mp4', 'wav', 'flac', 'ogg', 'amr', 'webm', 'm4a']);
function mediaFormatFromUri(s3Uri) {
  const ext = (s3Uri.split('.').pop() || '').toLowerCase();
  return TRANSCRIBE_MEDIA_FORMATS.has(ext) ? ext : 'mp4';
}

/**
 * Converts Mimir's timed transcript (an array of word entries
 * { content, startTime, endTime } with times in MILLISECONDS) into the same
 * { fullTranscript, sentences[] } shape that convertTranscribeOutput produces
 * for AWS Transcribe output, so downstream consumers (the rough cut agent's
 * transcript_cache) can treat both sources identically.
 *
 * Sentences are reconstructed by grouping words until one ends with sentence
 * punctuation (. ? !). Times are converted to SECONDS to match the Transcribe
 * output format the agent expects.
 */
function convertMimirTimedTranscript(words) {
  const sentences = [];
  const fullParts = [];
  let current = [];
  const sentenceEnd = /[.?!]$/;

  for (const w of words || []) {
    const content = (w.content || '').trim();
    if (!content) continue;
    fullParts.push(content);
    current.push({
      word: content,
      startTime: (Number(w.startTime) || 0) / 1000,
      endTime: (Number(w.endTime) || 0) / 1000,
    });
    if (sentenceEnd.test(content)) {
      sentences.push({
        text: current.map((x) => x.word).join(' '),
        startTime: current[0].startTime,
        endTime: current[current.length - 1].endTime,
        words: current,
      });
      current = [];
    }
  }
  if (current.length > 0) {
    sentences.push({
      text: current.map((x) => x.word).join(' '),
      startTime: current[0].startTime,
      endTime: current[current.length - 1].endTime,
      words: current,
    });
  }

  return { fullTranscript: fullParts.join(' '), sentences };
}

/**
 * Reuses an item's EXISTING Mimir transcript instead of running AWS Transcribe.
 * Fetches the item to get a fresh timedTranscriptUrl, downloads the timed
 * transcript, normalizes it to the Transcribe output shape, and writes it to the
 * staging bucket at transcripts/{itemId}/transcript.json — the exact location and
 * format the rough cut agent already reads. This lets the pipeline skip Transcribe
 * for any clip Mimir has already transcribed.
 */
async function handleImportMimirTranscript(event) {
  const { itemId, mimirApiKey } = event;
  const bucket = process.env.VIDEO_STAGING_BUCKET;
  if (!bucket) throw new Error('VIDEO_STAGING_BUCKET environment variable is not set');
  if (!itemId) throw new Error('itemId is required');

  const apiKey = mimirApiKey || await getMimirApiKey();

  // Fetch the item to get a fresh (non-expired) pre-signed timedTranscriptUrl.
  const itemResp = await fetch(`${MIMIR_BASE_URL}/api/v1/items/${itemId}`, {
    headers: { 'Accept': 'application/json', 'x-mimir-cognito-id-token': `Bearer ${apiKey}` },
  });
  if (!itemResp.ok) {
    throw new Error(`Mimir item fetch failed: ${itemResp.status}`);
  }
  const item = await itemResp.json();
  const url = item.timedTranscriptUrl;
  if (!url) {
    return { imported: false, reason: 'no Mimir transcript available' };
  }

  const txResp = await fetch(url);
  if (!txResp.ok) {
    throw new Error(`Mimir transcript download failed: ${txResp.status}`);
  }
  const raw = await txResp.json();
  // Mimir returns either an array of word entries or an object keyed by index.
  const words = Array.isArray(raw) ? raw : Object.values(raw);
  const converted = convertMimirTimedTranscript(words);

  if (converted.sentences.length === 0) {
    return { imported: false, reason: 'empty Mimir transcript' };
  }

  const transcriptKey = `transcripts/${itemId}/transcript.json`;
  await s3Client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: transcriptKey,
    Body: JSON.stringify(converted),
    ContentType: 'application/json',
  }));

  console.log(`Imported Mimir transcript for ${itemId}: ${converted.sentences.length} sentences`);
  return { imported: true, transcriptS3Uri: `s3://${bucket}/${transcriptKey}`, sentenceCount: converted.sentences.length };
}

async function handleCheckTranscript(event) {
  const { itemId } = event;
  const bucket = process.env.VIDEO_STAGING_BUCKET;

  if (!bucket) {
    throw new Error('VIDEO_STAGING_BUCKET environment variable is not set');
  }
  if (!itemId) {
    throw new Error('itemId is required');
  }

  const key = `transcripts/${itemId}/transcript.json`;
  try {
    await s3Client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return { exists: true, transcriptS3Uri: `s3://${bucket}/${key}` };
  } catch (err) {
    if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) {
      return { exists: false };
    }
    throw err;
  }
}

async function handleCheckVideo(event) {
  const { itemId } = event;
  const bucket = process.env.VIDEO_STAGING_BUCKET;

  if (!bucket) {
    throw new Error('VIDEO_STAGING_BUCKET environment variable is not set');
  }
  if (!itemId) {
    throw new Error('itemId is required');
  }

  const prefix = `videos/${itemId}/`;
  const response = await s3Client.send(
    new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
      MaxKeys: 1,
    })
  );

  if (response.Contents && response.Contents.length > 0) {
    const key = response.Contents[0].Key;
    return { exists: true, s3Uri: `s3://${bucket}/${key}` };
  }

  return { exists: false };
}

async function handleStartTranscribe(event) {
  const { itemId, s3Uri } = event;
  const bucket = process.env.VIDEO_STAGING_BUCKET;

  if (!bucket) {
    throw new Error('VIDEO_STAGING_BUCKET environment variable is not set');
  }
  if (!itemId) {
    throw new Error('itemId is required');
  }
  if (!s3Uri) {
    throw new Error('s3Uri is required');
  }

  const jobName = `transcript-${itemId}-${Date.now()}`;

  await transcribeClient.send(
    new StartTranscriptionJobCommand({
      TranscriptionJobName: jobName,
      LanguageCode: 'en-US',
      MediaFormat: mediaFormatFromUri(s3Uri),
      Media: {
        MediaFileUri: s3Uri,
      },
      OutputBucketName: bucket,
      OutputKey: `transcripts/${itemId}/raw-output.json`,
    })
  );

  return { jobName, status: 'IN_PROGRESS' };
}

function convertTranscribeOutput(rawOutput) {
  const fullTranscript = rawOutput.results.transcripts[0].transcript;
  const items = rawOutput.results.items;
  const sentences = [];
  let currentWords = [];
  const sentenceEnders = new Set(['.', '?', '!']);

  for (const item of items) {
    if (item.type === 'pronunciation') {
      currentWords.push({
        word: item.alternatives[0].content,
        startTime: parseFloat(item.start_time),
        endTime: parseFloat(item.end_time),
      });
    } else if (item.type === 'punctuation') {
      const punct = item.alternatives[0].content;
      if (currentWords.length > 0) {
        currentWords[currentWords.length - 1].word += punct;
      }
      if (sentenceEnders.has(punct) && currentWords.length > 0) {
        sentences.push({
          text: currentWords.map((w) => w.word).join(' '),
          startTime: currentWords[0].startTime,
          endTime: currentWords[currentWords.length - 1].endTime,
          words: currentWords,
        });
        currentWords = [];
      }
    }
  }

  // Finalize remaining words as last sentence
  if (currentWords.length > 0) {
    sentences.push({
      text: currentWords.map((w) => w.word).join(' '),
      startTime: currentWords[0].startTime,
      endTime: currentWords[currentWords.length - 1].endTime,
      words: currentWords,
    });
  }

  return { fullTranscript, sentences };
}

async function handlePollTranscribe(event) {
  const { itemId, jobName } = event;
  const bucket = process.env.VIDEO_STAGING_BUCKET;

  if (!bucket) {
    throw new Error('VIDEO_STAGING_BUCKET environment variable is not set');
  }
  if (!itemId) {
    throw new Error('itemId is required');
  }
  if (!jobName) {
    throw new Error('jobName is required');
  }

  const jobResponse = await transcribeClient.send(
    new GetTranscriptionJobCommand({
      TranscriptionJobName: jobName,
    })
  );

  const status = jobResponse.TranscriptionJob.TranscriptionJobStatus;

  if (status === 'IN_PROGRESS') {
    return { status: 'IN_PROGRESS' };
  }

  if (status === 'FAILED') {
    const reason = jobResponse.TranscriptionJob.FailureReason || 'Unknown reason';
    return { status: 'FAILED', error: `Transcription job failed: ${reason}` };
  }

  if (status === 'COMPLETED') {
    const rawKey = `transcripts/${itemId}/raw-output.json`;
    const rawResponse = await s3Client.send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: rawKey,
      })
    );

    const rawBody = await rawResponse.Body.transformToString();
    const rawOutput = JSON.parse(rawBody);
    const converted = convertTranscribeOutput(rawOutput);

    const transcriptKey = `transcripts/${itemId}/transcript.json`;
    await s3Client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: transcriptKey,
        Body: JSON.stringify(converted),
        ContentType: 'application/json',
      })
    );

    return {
      status: 'COMPLETED',
      transcriptS3Uri: `s3://${bucket}/${transcriptKey}`,
    };
  }

  throw new Error(`Unexpected transcription job status: ${status}`);
}

exports.handler = async (event) => {
  const { action } = event;
  switch (action) {
    case 'check-transcript':
      return handleCheckTranscript(event);
    case 'check-video':
      return handleCheckVideo(event);
    case 'start-transcribe':
      return handleStartTranscribe(event);
    case 'poll-transcribe':
      return handlePollTranscribe(event);
    case 'publish-transcript':
      return handlePublishTranscript(event);
    case 'check-access':
      return handleCheckAccess(event);
    case 'import-mimir-transcript':
      return handleImportMimirTranscript(event);
    default:
      throw new Error(`Unknown action: ${action}`);
  }
};

exports.convertTranscribeOutput = convertTranscribeOutput;
exports.convertMimirTimedTranscript = convertMimirTimedTranscript;
exports.parseS3Uri = parseS3Uri;
exports.mediaFormatFromUri = mediaFormatFromUri;
