/**
 * reframe-custom-scene-analysis-handler
 *
 * Analyses a single scene to determine whether to apply CROP or TILE layout.
 *
 * Steps:
 *   1. Extract keyframe at scene midpoint using FFmpeg
 *   2. Send keyframe to Bedrock Nova Pro for scene description
 *   3. Compute XY variance from Elemental Inference coordinates
 *   4. Apply CROP/TILE decision logic
 *
 * Input:
 *   itemId             (string)
 *   sceneIndex         (number)
 *   startMs            (number) scene start in milliseconds
 *   endMs              (number) scene end in milliseconds
 *   sourceVideoUri     (string) s3://bucket/key
 *   stagingBucket      (string)
 *   executionTimestamp (number)
 *   xyCoordinates      ({ pts, x, y }[]) from Elemental Inference
 *   varianceThreshold  (number) default 5000
 *
 * Output:
 *   { sceneIndex, startMs, endMs, decision, novaDescription, xyVariance,
 *     representativeX, representativeY, fallbackReason }
 */

const { S3Client, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const { BedrockRuntimeClient, ConverseCommand } = require('@aws-sdk/client-bedrock-runtime');
const { spawnSync } = require('child_process');
const fs = require('fs');

const s3 = new S3Client();
const bedrockClient = new BedrockRuntimeClient({ region: process.env.AWS_REGION || 'us-east-1' });

const STAGING_BUCKET = process.env.STAGING_BUCKET;
const NOVA_MODEL_ID = process.env.NOVA_MODEL_ID || 'us.amazon.nova-pro-v1:0';
const DEFAULT_VARIANCE_THRESHOLD = parseInt(process.env.XY_VARIANCE_THRESHOLD || '5000', 10);
const FFMPEG_PATH = process.env.FFMPEG_PATH || '/usr/local/bin/ffmpeg';

// Keywords that indicate a TILE layout is preferable
const TILE_KEYWORDS = ['wide shot', 'wide-shot', 'establishing shot', 'establishing-shot',
  'multiple subjects', 'multiple people', 'crowd', 'wide angle', 'panoramic', 'aerial',
  'group shot', 'ensemble'];

// Keywords that indicate a CROP layout is preferable
const CROP_KEYWORDS = ['close-up', 'closeup', 'close up', 'interview', 'single subject',
  'single person', 'portrait', 'headshot', 'talking head', 'medium shot'];

/**
 * Compute mean-squared Euclidean distance variance of XY coordinates.
 */
function computeXYVariance(xyCoordinates) {
  if (!xyCoordinates || xyCoordinates.length === 0) return 0;
  const n = xyCoordinates.length;
  const meanX = xyCoordinates.reduce((s, p) => s + p.x, 0) / n;
  const meanY = xyCoordinates.reduce((s, p) => s + p.y, 0) / n;
  return xyCoordinates.reduce((s, p) => {
    const dx = p.x - meanX;
    const dy = p.y - meanY;
    return s + (dx * dx + dy * dy);
  }, 0) / n;
}

/**
 * Compute median value of a coordinate axis (robust to outliers).
 */
function medianCoord(coords, axis) {
  if (!coords || coords.length === 0) return 0;
  const sorted = [...coords].map(p => p[axis]).sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

exports.handler = async (event) => {
  const {
    itemId,
    sceneIndex,
    startMs,
    endMs,
    sourceVideoUri,
    executionTimestamp,
    xyCoordinates,
  } = event;
  const stagingBucket = event.stagingBucket || STAGING_BUCKET;
  const varianceThreshold = event.varianceThreshold || DEFAULT_VARIANCE_THRESHOLD;
  const ts = executionTimestamp || Date.now();

  console.log(JSON.stringify({
    action: 'scene-analysis-start',
    itemId,
    sceneIndex,
    startMs,
    endMs,
    timestamp: new Date().toISOString(),
  }));

  // Compute XY variance and representative centre point
  const xyVariance = computeXYVariance(xyCoordinates);
  const representativeX = Math.round(medianCoord(xyCoordinates, 'x'));
  const representativeY = Math.round(medianCoord(xyCoordinates, 'y'));

  const tmpDir = `/tmp/scene-${itemId}-${sceneIndex}-${ts}`;
  fs.mkdirSync(tmpDir, { recursive: true });
  const keyframePath = `${tmpDir}/keyframe.jpg`;

  let novaDescription = '';
  let fallbackReason = null;

  try {
    // Parse source S3 URI
    const srcMatch = sourceVideoUri.replace('s3://', '').split('/');
    const srcBucket = srcMatch[0];
    const srcKey = srcMatch.slice(1).join('/');

    // Download source video
    const srcPath = `${tmpDir}/source.mp4`;
    const s3Obj = await s3.send(new GetObjectCommand({ Bucket: srcBucket, Key: srcKey }));
    const chunks = [];
    for await (const chunk of s3Obj.Body) chunks.push(chunk);
    fs.writeFileSync(srcPath, Buffer.concat(chunks));

    // Extract keyframe at scene midpoint
    const midpointSec = ((startMs + endMs) / 2) / 1000;
    const ffmpegResult = spawnSync(FFMPEG_PATH, [
      '-ss', String(midpointSec),
      '-i', srcPath,
      '-frames:v', '1',
      '-q:v', '2',
      '-y',
      keyframePath,
    ], { stdio: 'pipe' });

    if (ffmpegResult.status !== 0) {
      throw new Error(`FFmpeg keyframe extraction failed: ${ffmpegResult.stderr?.toString().slice(-500)}`);
    }

    // Upload keyframe to staging bucket
    const keyframeKey = `reframe-custom/${itemId}/${ts}/keyframes/scene_${String(sceneIndex).padStart(3, '0')}.jpg`;
    await s3.send(new PutObjectCommand({
      Bucket: stagingBucket,
      Key: keyframeKey,
      Body: fs.readFileSync(keyframePath),
      ContentType: 'image/jpeg',
    }));

    // Send keyframe to Bedrock Nova for scene description
    const keyframeBuffer = fs.readFileSync(keyframePath);
    const novaResponse = await bedrockClient.send(new ConverseCommand({
      modelId: NOVA_MODEL_ID,
      messages: [{
        role: 'user',
        content: [
          {
            image: {
              format: 'jpeg',
              source: { bytes: keyframeBuffer },
            },
          },
          {
            text: `Describe this video frame in 10 words or fewer. Focus on:
- Shot type: "wide shot", "establishing shot", "close-up", "medium shot"
- Subject count: "single subject", "multiple subjects", "crowd"
- Context: "interview", "action", "landscape", "indoor", "outdoor"
Respond with only the description, no punctuation.`,
          },
        ],
      }],
      inferenceConfig: { maxTokens: 64, temperature: 0.1 },
    }));

    novaDescription = (novaResponse.output?.message?.content?.[0]?.text || '').toLowerCase().trim();
    console.log(JSON.stringify({ action: 'scene-nova-done', itemId, sceneIndex, description: novaDescription }));

  } catch (err) {
    fallbackReason = err.message;
    console.error(JSON.stringify({
      action: 'scene-analysis-partial-failure',
      itemId,
      sceneIndex,
      error: err.message,
      defaultingTo: 'CROP',
    }));
    // Default to CROP on any failure — do not throw
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }

  // Apply CROP/TILE decision logic
  // TILE is for genuinely wide/multi-subject scenes where context matters.
  // Require Nova to explicitly favor TILE, OR extremely high variance with no crop signals.
  // High variance alone (e.g. talking head moving) should NOT trigger TILE.
  const highVariance = xyVariance > varianceThreshold;
  const veryHighVariance = xyVariance > varianceThreshold * 5;  // 5x threshold = clearly dynamic
  const novaFavorsTile = TILE_KEYWORDS.some(kw => novaDescription.includes(kw));
  const novaFavorsCrop = CROP_KEYWORDS.some(kw => novaDescription.includes(kw));

  let decision;
  if (novaFavorsCrop) {
    // Nova explicitly says close-up/interview/single subject → always CROP
    decision = 'CROP';
  } else if (novaFavorsTile && highVariance) {
    // Nova says wide/multiple subjects AND subject is moving → TILE
    decision = 'TILE';
  } else if (veryHighVariance && !novaFavorsCrop) {
    // Extremely dynamic scene with no crop signal → TILE
    decision = 'TILE';
  } else {
    // Default: CROP (safer, looks better for most content)
    decision = 'CROP';
  }

  console.log(JSON.stringify({
    action: 'scene-analysis-done',
    itemId,
    sceneIndex,
    decision,
    xyVariance,
    varianceThreshold,
    highVariance,
    veryHighVariance,
    novaFavorsTile,
    novaFavorsCrop,
    novaDescription,
    representativeX,
    representativeY,
    timestamp: new Date().toISOString(),
  }));

  return {
    sceneIndex,
    startMs,
    endMs,
    sourceVideoUri,   // pass through for RCStartSceneEncode
    decision,
    novaDescription,
    xyVariance,
    representativeX,
    representativeY,
    fallbackReason,
  };
};
