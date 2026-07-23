const { BedrockRuntimeClient, ConverseCommand } = require('@aws-sdk/client-bedrock-runtime');
const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
const { S3Client, PutObjectCommand, HeadObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');

const bedrockClient = new BedrockRuntimeClient();
const secretsClient = new SecretsManagerClient();
const s3Client = new S3Client();

const STAGING_BUCKET = process.env.VIDEO_STAGING_BUCKET;
const AWS_ACCOUNT_ID = process.env.AWS_ACCOUNT_ID || '';
const MODEL_ID = process.env.SUMMARIZER_MODEL_ID || 'us.amazon.nova-pro-v1:0';

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
 * Reads the transcript that the state machine's Transcribe fallback just produced,
 * given the exact S3 URI it wrote (state field transcribeStatus.transcriptS3Uri,
 * from the poll step).
 *
 * Using the URI the state machine hands us — rather than re-fetching from Mimir —
 * avoids a race: PublishTranscript PUTs the transcript to Mimir immediately before
 * this handler runs, and Mimir may not have generated the pre-signed
 * timedTranscriptUrl yet. It also ties us to exactly this execution's output, so a
 * stale transcript from a previous run can never be picked up. Returns null when
 * Transcribe didn't run this execution (no URI provided) or the object is missing.
 */
async function readTranscriptFromS3Uri(s3Uri) {
  const match = (s3Uri || '').match(/^s3:\/\/([^/]+)\/(.+)$/);
  if (!match) return null;
  const [, bucket, key] = match;
  try {
    const resp = await s3Client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const data = JSON.parse(await resp.Body.transformToString());
    if (data.fullTranscript) return data.fullTranscript.trim();
    if (Array.isArray(data.sentences)) {
      return data.sentences.map((s) => s.text).join(' ').trim() || null;
    }
    return null;
  } catch (err) {
    if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) return null;
    console.warn(`Transcript read from ${s3Uri} failed (non-fatal): ${err.message}`);
    return null;
  }
}

/**
 * Fetches the spoken-word transcript for an item, if available, so the summary
 * can reflect what is said in addition to what is shown.
 *
 * Looks for Mimir's timedTranscriptUrl (a pre-signed URL) on the item details;
 * if absent, re-fetches the item from Mimir. The timed transcript is a JSON
 * object of word entries ({ content, startTime, endTime }) which we join into
 * plain text. Returns null when no transcript exists.
 */
async function getTranscriptText(itemDetails, apiKey) {
  let url = itemDetails.mimirDetails?.timedTranscriptUrl || itemDetails.timedTranscriptUrl;

  if (!url && itemDetails.id && apiKey) {
    try {
      const r = await fetch(`${MIMIR_BASE_URL}/api/v1/items/${itemDetails.id}`, {
        headers: { 'Accept': 'application/json', 'x-mimir-cognito-id-token': `Bearer ${apiKey}` },
      });
      if (r.ok) url = (await r.json()).timedTranscriptUrl;
    } catch (err) {
      console.warn(`Transcript URL lookup failed (non-fatal): ${err.message}`);
    }
  }

  if (!url) return null;

  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    const data = await r.json();
    // Mimir timed transcript format: { "0": { content, startTime, endTime }, ... }
    if (data && typeof data === 'object') {
      const words = Object.values(data);
      if (words.length && words[0]?.content !== undefined) {
        return words.map((w) => w.content).join(' ').trim();
      }
      // Fallbacks for other possible shapes
      return data.fullTranscript || data.transcript || null;
    }
    return null;
  } catch (err) {
    console.warn(`Transcript fetch failed (non-fatal): ${err.message}`);
    return null;
  }
}

/**
 * Determines if a video is already in our S3 account or needs to be staged.
 * 
 * If the item has an S3 URI in our account, use it directly.
 * Otherwise, download from Mimir proxy URL and stage to our bucket.
 * 
 * Returns { bucket, key } for the video location.
 */
// Bedrock Converse supported video container formats. Anything else defaults to
// mp4 (our staged proxy is always mp4).
const BEDROCK_VIDEO_FORMATS = new Set(['mkv', 'mov', 'mp4', 'webm', 'flv', 'mpeg', 'mpg', 'wmv', 'three_gp']);
function videoFormatFromKey(key) {
  const ext = (key.split('.').pop() || '').toLowerCase();
  return BEDROCK_VIDEO_FORMATS.has(ext) ? ext : 'mp4';
}

async function resolveVideoLocation(itemDetails) {
  // Prefer the customer's original object in S3. Mimir reports it via the ingest
  // source fields (surfaced by mimir-details-handler). When the custom action is
  // deployed in the customer's own account this is directly readable and we skip
  // the proxy download entirely; when running cross-account (our test setup) the
  // HeadObject fails and we fall back to staging the pre-signed proxy.
  const sourceBucket = itemDetails.ingestSourceS3Bucket || itemDetails.mimirDetails?.ingestSourceS3Bucket;
  const sourcePath = itemDetails.ingestSourceFullPath || itemDetails.mimirDetails?.ingestSourceFullPath;
  const s3Location = sourceBucket && sourcePath ? `s3://${sourceBucket}/${sourcePath}` : null;

  if (s3Location) {
    const parsed = s3Location.replace('s3://', '').split('/');
    const bucket = parsed[0];
    const key = parsed.slice(1).join('/');

    // Test direct read access (works when we're in the customer's account).
    try {
      await s3Client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      console.log(`Video accessible directly at s3://${bucket}/${key}`);
      return { bucket, key, source: 'direct-s3', format: videoFormatFromKey(key) };
    } catch (err) {
      console.log(`Cannot access s3://${bucket}/${key} directly (${err.name}), will stage from proxy`);
    }
  }

  // Fall back: download from Mimir proxy URL and stage to our S3 bucket
  const videoUrl = itemDetails.proxyUrl || itemDetails.highResUrl;
  if (!videoUrl) {
    throw new Error('No video URL available (no proxy or highRes URL, and no accessible S3 location)');
  }

  console.log('Downloading video from Mimir proxy URL...');
  const videoResponse = await fetch(videoUrl);
  if (!videoResponse.ok) {
    throw new Error(`Failed to download video: ${videoResponse.status} ${videoResponse.statusText}`);
  }
  
  const videoBuffer = Buffer.from(await videoResponse.arrayBuffer());
  const videoSizeMB = (videoBuffer.byteLength / (1024 * 1024)).toFixed(1);
  console.log(`Video downloaded: ${videoSizeMB} MB`);

  // Stage to our S3 bucket
  const key = `summarizer/${itemDetails.id}/${Date.now()}.mp4`;
  await s3Client.send(new PutObjectCommand({
    Bucket: STAGING_BUCKET,
    Key: key,
    Body: videoBuffer,
    ContentType: 'video/mp4'
  }));
  console.log(`Video staged to s3://${STAGING_BUCKET}/${key}`);

  return { bucket: STAGING_BUCKET, key, source: 'staged-from-proxy', format: 'mp4', videoSizeMB };
}

exports.handler = async (event) => {
  console.log('Summarizer handler received:', JSON.stringify(event, null, 2));
  
  try {
    const { itemDetails, mimirApiKey } = event;
    const contentType = itemDetails.itemType;
    
    if (contentType !== 'video') {
      return {
        id: itemDetails.id,
        title: itemDetails.title,
        itemType: contentType,
        summary: `Summarization for ${contentType} items is not yet supported.`,
        timestamp: new Date().toISOString()
      };
    }

    // Resolve video location (direct S3 or stage from Mimir)
    const videoLocation = await resolveVideoLocation(itemDetails);
    const s3Uri = `s3://${videoLocation.bucket}/${videoLocation.key}`;
    console.log(`Using video at: ${s3Uri} (source: ${videoLocation.source})`);

    // Fetch the spoken-word transcript (if any) so the summary reflects both
    // what is shown and what is said. Cap length to keep the prompt bounded.
    // The state machine ensures a transcript exists in Mimir before invoking this
    // handler (running AWS Transcribe and publishing it back when needed), so we
    // simply read whatever transcript is available. Falls back to visual-only.
    const apiKey = mimirApiKey || await getMimirApiKey();
    // Prefer the transcript this execution just generated — the state machine
    // hands us its exact S3 URI. Fall back to Mimir's stored transcript when
    // Transcribe didn't run (the item already had one).
    const freshTranscriptUri = itemDetails.transcribeStatus?.transcriptS3Uri;
    const transcript = (freshTranscriptUri && await readTranscriptFromS3Uri(freshTranscriptUri))
      || (await getTranscriptText(itemDetails, apiKey));

    const transcriptExcerpt = transcript ? transcript.slice(0, 12000) : null;
    console.log(transcriptExcerpt
      ? `Transcript available: ${transcript.length} chars (using ${transcriptExcerpt.length})`
      : 'No transcript available — visual-only summary');

    // Build the prompt. When a transcript is present, ask the model to combine
    // spoken content with the visuals; otherwise fall back to a visual summary.
    const prompt = `Provide a concise summary of this video content suitable for a media asset management system. Include:
1. A brief description of the main subject/topic (1-2 sentences)${transcriptExcerpt ? ', drawing on both what is said (transcript) and what is shown (video)' : ''}
2. Key points or statements made${transcriptExcerpt ? ' (from the transcript)' : ''}, and key visual elements/activities shown
3. Any text overlays, graphics, or lower-thirds visible
4. The general tone and style (news report, interview, B-roll, etc.)

Keep the summary under 200 words. Do not invent facts not supported by the video or transcript.`;

    // Assemble the Converse content: video first, then the transcript (if any),
    // then the instruction prompt.
    const content = [
      { video: { format: videoLocation.format || 'mp4', source: { s3Location: { uri: s3Uri } } } },
    ];
    if (transcriptExcerpt) {
      content.push({ text: `Transcript of the spoken audio:\n"""\n${transcriptExcerpt}\n"""` });
    }
    content.push({ text: prompt });

    const converseInput = {
      modelId: MODEL_ID,
      messages: [{ role: 'user', content }],
      inferenceConfig: {
        maxTokens: 1024,
        temperature: 0.3
      }
    };

    console.log(`Calling Bedrock Converse with model: ${MODEL_ID}`);
    const response = await bedrockClient.send(new ConverseCommand(converseInput));
    
    const summary = response.output?.message?.content?.[0]?.text || 'Summary generation failed';
    console.log('Summary generated successfully, length:', summary.length);

    return {
      id: itemDetails.id,
      title: itemDetails.title,
      itemType: contentType,
      summary: summary.trim(),
      modelUsed: MODEL_ID,
      videoSource: videoLocation.source,
      usedTranscript: !!transcriptExcerpt,
      timestamp: new Date().toISOString()
    };
    
  } catch (error) {
    console.error('Error in summarizer handler:', error);
    
    return {
      id: event.itemDetails?.id || 'unknown',
      title: event.itemDetails?.title || 'Unknown',
      itemType: event.itemDetails?.itemType || 'unknown',
      summary: `Error generating summary: ${error.message}`,
      error: true,
      errorMessage: error.message,
      timestamp: new Date().toISOString()
    };
  }
};
