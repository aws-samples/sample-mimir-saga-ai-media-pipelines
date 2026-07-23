const { BedrockRuntimeClient, ConverseCommand } = require('@aws-sdk/client-bedrock-runtime');
const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
const { S3Client, PutObjectCommand, HeadObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');

const bedrockClient = new BedrockRuntimeClient();
const secretsClient = new SecretsManagerClient();
const s3Client = new S3Client();

const STAGING_BUCKET = process.env.VIDEO_STAGING_BUCKET;
const MODEL_ID = process.env.CHAPTERIZE_MODEL_ID || 'us.amazon.nova-pro-v1:0';
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
 * Reads the transcript this execution's Transcribe fallback just produced, given
 * the exact S3 URI the state machine wrote (state field
 * transcribeStatus.transcriptS3Uri). Using the URI the state machine hands us — 
 * rather than re-fetching from Mimir — avoids a race with Mimir's async transcript
 * processing and ties us to exactly this execution's output. Returns null when no
 * URI was provided or the object is missing.
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
 * Fetches the spoken-word transcript for an item from Mimir, if available. Looks
 * for Mimir's timedTranscriptUrl (a pre-signed URL) on the item details; if absent
 * re-fetches the item by id. The timed transcript is a JSON object of word entries
 * ({ content, startTime, endTime }) joined into plain text. Returns null when no
 * transcript exists.
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
    if (data && typeof data === 'object') {
      const words = Object.values(data);
      if (words.length && words[0]?.content !== undefined) {
        return words.map((w) => w.content).join(' ').trim();
      }
      return data.fullTranscript || data.transcript || null;
    }
    return null;
  } catch (err) {
    console.warn(`Transcript fetch failed (non-fatal): ${err.message}`);
    return null;
  }
}

// Bedrock Converse supported video container formats. Anything else defaults to
// mp4 (our staged proxy is always mp4).
const BEDROCK_VIDEO_FORMATS = new Set(['mkv', 'mov', 'mp4', 'webm', 'flv', 'mpeg', 'mpg', 'wmv', 'three_gp']);
function videoFormatFromKey(key) {
  const ext = (key.split('.').pop() || '').toLowerCase();
  return BEDROCK_VIDEO_FORMATS.has(ext) ? ext : 'mp4';
}

/**
 * Resolves video to an S3 location accessible by Bedrock.
 *
 * Prefers the customer's original object in S3 (Mimir ingest source fields). When
 * the custom action is deployed in the customer's own account this is directly
 * readable and we skip the proxy download; when running cross-account (our test
 * setup) the HeadObject fails and we fall back to staging the pre-signed proxy.
 */
async function resolveVideoLocation(itemDetails) {
  const sourceBucket = itemDetails.ingestSourceS3Bucket || itemDetails.mimirDetails?.ingestSourceS3Bucket;
  const sourcePath = itemDetails.ingestSourceFullPath || itemDetails.mimirDetails?.ingestSourceFullPath;
  const s3Location = sourceBucket && sourcePath ? `s3://${sourceBucket}/${sourcePath}` : null;

  if (s3Location) {
    const parsed = s3Location.replace('s3://', '').split('/');
    const bucket = parsed[0];
    const key = parsed.slice(1).join('/');

    try {
      await s3Client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      console.log(`Video accessible directly at s3://${bucket}/${key}`);
      return { bucket, key, source: 'direct-s3', format: videoFormatFromKey(key) };
    } catch (err) {
      console.log(`Cannot access s3://${bucket}/${key} (${err.name}), staging from proxy`);
    }
  }

  const videoUrl = itemDetails.proxyUrl || itemDetails.highResUrl;
  if (!videoUrl) {
    throw new Error('No video URL available');
  }

  console.log('Downloading video from Mimir proxy...');
  const videoResponse = await fetch(videoUrl);
  if (!videoResponse.ok) {
    throw new Error(`Failed to download video: ${videoResponse.status}`);
  }

  const videoBuffer = Buffer.from(await videoResponse.arrayBuffer());
  console.log(`Video downloaded: ${(videoBuffer.byteLength / (1024 * 1024)).toFixed(1)} MB`);

  const key = `chapterize/${itemDetails.id}/${Date.now()}.mp4`;
  await s3Client.send(new PutObjectCommand({
    Bucket: STAGING_BUCKET,
    Key: key,
    Body: videoBuffer,
    ContentType: 'video/mp4'
  }));
  console.log(`Video staged to s3://${STAGING_BUCKET}/${key}`);

  return { bucket: STAGING_BUCKET, key, source: 'staged-from-proxy', format: 'mp4' };
}

exports.handler = async (event) => {
  console.log('Chapterize handler received:', JSON.stringify(event, null, 2));

  try {
    const { itemDetails, mimirApiKey } = event;

    // Get video duration from Mimir metadata
    const videoDurationMs =
      itemDetails.mimirDetails?.technicalMetadata?.formData?.technical_media_duration ||
      itemDetails.mimirDetails?.mediaDuration ||
      0;
    console.log(`Video duration: ${videoDurationMs}ms (${(videoDurationMs / 1000).toFixed(1)}s)`);

    // Resolve video location
    const videoLocation = await resolveVideoLocation(itemDetails);
    const s3Uri = `s3://${videoLocation.bucket}/${videoLocation.key}`;
    console.log(`Using video at: ${s3Uri} (source: ${videoLocation.source})`);

    // Fetch the spoken-word transcript (if any) so chapter boundaries can follow
    // topic changes in the dialogue, not just visual cuts. Prefer the transcript
    // this execution just generated (state machine hands us its exact S3 URI);
    // fall back to Mimir's stored transcript when Transcribe didn't run.
    const apiKey = mimirApiKey || await getMimirApiKey();
    const freshTranscriptUri = itemDetails.transcribeStatus?.transcriptS3Uri;
    const transcript = (freshTranscriptUri && await readTranscriptFromS3Uri(freshTranscriptUri))
      || (await getTranscriptText(itemDetails, apiKey));
    const transcriptExcerpt = transcript ? transcript.slice(0, 12000) : null;
    console.log(transcriptExcerpt
      ? `Transcript available: ${transcript.length} chars (using ${transcriptExcerpt.length})`
      : 'No transcript available — visual-only chapterization');

    // Build prompt with duration context
    const durationContext = videoDurationMs > 0
      ? `This video is ${(videoDurationMs / 1000).toFixed(1)} seconds long. All timestamps must be within 0 to ${videoDurationMs} milliseconds.`
      : 'Estimate timestamps based on the visual content.';

    // Calculate expected chapter count based on duration
    const durationSec = videoDurationMs > 0 ? videoDurationMs / 1000 : 120;
    const expectedChapters = Math.max(3, Math.min(12, Math.round(durationSec / 20)));

    const prompt = `Analyze this video and identify the major scene changes and topic transitions to create chapters.

${durationContext}

For each chapter, provide:
1. Start time in milliseconds
2. End time in milliseconds
3. A descriptive title (5-10 words)

GUIDELINES:
- This video is ${Math.round(durationSec)} seconds long — aim for roughly ${expectedChapters} chapters (approximately one chapter per 15-30 seconds of content)
- Only create a new chapter when there is a clear change in subject, location, speaker, or activity${transcriptExcerpt ? '\n- Use the transcript to detect topic changes in the spoken content and align chapter boundaries and titles to what is being said' : ''}
- For interviews: one chapter per topic discussed, NOT per camera angle or gesture
- For B-roll sequences: group related shots of the same subject/location into one chapter
- Each chapter should be at least 5 seconds long
- Titles should describe the CONTENT/TOPIC, not camera movements
- Use unique, descriptive titles — avoid repeating the same title

Return ONLY valid JSON in this exact format:
{
  "chapters": [
    {"startMs": 0, "endMs": 30000, "title": "Opening Remarks"},
    {"startMs": 30000, "endMs": 90000, "title": "Main Discussion"}
  ]
}`;

    // Assemble the Converse content: video first, then the transcript (if any),
    // then the instruction prompt.
    const content = [
      { video: { format: videoLocation.format || 'mp4', source: { s3Location: { uri: s3Uri } } } },
    ];
    if (transcriptExcerpt) {
      content.push({ text: `Transcript of the spoken audio:\n"""\n${transcriptExcerpt}\n"""` });
    }
    content.push({ text: prompt });

    // Call Nova Pro via Converse API
    const converseInput = {
      modelId: MODEL_ID,
      messages: [{ role: 'user', content }],
      inferenceConfig: {
        maxTokens: 2048,
        temperature: 0.2
      }
    };

    console.log(`Calling Bedrock Converse with model: ${MODEL_ID}`);
    const response = await bedrockClient.send(new ConverseCommand(converseInput));
    const responseText = response.output?.message?.content?.[0]?.text || '';
    console.log('Response text:', responseText.substring(0, 500));

    // Parse chapters from JSON response
    let chapters = [];
    try {
      const jsonMatch = responseText.match(/\{[\s\S]*"chapters"[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        chapters = parsed.chapters || [];
        console.log(`Parsed ${chapters.length} chapters`);
      }
    } catch (parseError) {
      console.error('Failed to parse chapters:', parseError.message);
    }

    if (!chapters.length) {
      return {
        id: itemDetails.id,
        title: itemDetails.title,
        chapters: [],
        warning: 'No chapters could be extracted from the AI response',
        rawResponse: responseText.substring(0, 200),
        timestamp: new Date().toISOString()
      };
    }

    // Validate and clean chapters
    const rawCount = chapters.length;
    chapters = chapters.map((ch, i) => ({
      startMs: ch.startMs || 0,
      endMs: ch.endMs || videoDurationMs,
      title: ch.title || `Chapter ${i + 1}`
    }));

    if (videoDurationMs > 0) {
      chapters = chapters
        .filter(ch => ch.startMs < videoDurationMs)
        .map(ch => ({ ...ch, endMs: Math.min(ch.endMs, videoDurationMs) }))
        .filter(ch => (ch.endMs - ch.startMs) >= 500);
    }

    // Merge consecutive chapters with identical titles
    if (chapters.length > 1) {
      const merged = [chapters[0]];
      for (let i = 1; i < chapters.length; i++) {
        const prev = merged[merged.length - 1];
        const curr = chapters[i];
        
        if (prev.title === curr.title) {
          // Extend previous chapter to cover this one
          prev.endMs = curr.endMs;
        } else {
          merged.push(curr);
        }
      }
      chapters = merged;
    }

    console.log(`Generated ${chapters.length} chapters (from ${rawCount} raw, after merge)`);

    return {
      id: itemDetails.id,
      title: itemDetails.title,
      chapters,
      modelUsed: MODEL_ID,
      videoSource: videoLocation.source,
      timestamp: new Date().toISOString()
    };

  } catch (error) {
    console.error('Error in chapterize handler:', error);
    return {
      id: event.itemDetails?.id || 'unknown',
      title: event.itemDetails?.title || 'Unknown',
      chapters: [],
      error: true,
      errorMessage: error.message,
      timestamp: new Date().toISOString()
    };
  }
};
