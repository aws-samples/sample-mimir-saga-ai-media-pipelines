/**
 * reframe-custom-tile-handler
 *
 * Produces a 1080x1920 "tile" video using FFmpeg:
 *   - Top 60% (1080x1152): smart-cropped 9:16 panel centered on EI subject
 *   - Bottom 40% (1080x768): full-width 16:9 original, letterboxed with black bars
 *
 * Requires FFmpeg at /opt/bin/ffmpeg (Lambda layer) or FFMPEG_PATH env var.
 * Lambda config: 3008MB memory, 10min timeout, 2GB ephemeral storage.
 */

const { execFile } = require('child_process');
const { promisify } = require('util');
const { S3Client, GetObjectCommand, PutObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');
const fs = require('fs');
const { pipeline } = require('stream/promises');

const execFileAsync = promisify(execFile);
const s3 = new S3Client({});

const FFMPEG = process.env.FFMPEG_PATH || '/opt/bin/ffmpeg';
const OUTPUT_BUCKET = process.env.OUTPUT_BUCKET;

// Source dimensions (1920x1080 original)
const SRC_WIDTH  = 1920;
const SRC_HEIGHT = 1080;

// Output frame
const OUT_W = 1080;
const OUT_H = 1920;
// Bottom panel: exactly 16:9 at 1080 wide = 1080×608 (no letterboxing, correct AR)
const BOT_H = Math.round(OUT_W * 9 / 16);  // 608px (16:9 at 1080 wide)
const TOP_H = OUT_H - BOT_H;               // 1312px (top panel gets the rest)

// EI coordinate scaling (EI runs on 1280x720 CMAF, source is 1920x1080)
const EI_FRAME_WIDTH  = 1280;
const EI_FRAME_HEIGHT = 720;
const EI_SCALE        = 10000;
const SCALE_X = SRC_WIDTH  / EI_FRAME_WIDTH;   // 1.5
const SCALE_Y = SRC_HEIGHT / EI_FRAME_HEIGHT;  // 1.5

// 9:16 crop window width at source resolution
const CROP_W = 608;  // must be even

function eiToSourcePixel(normalizedX, normalizedY) {
  const cmafX = (normalizedX / EI_SCALE) * EI_FRAME_WIDTH;
  const cmafY = (normalizedY / EI_SCALE) * EI_FRAME_HEIGHT;
  return {
    px: Math.round(cmafX * SCALE_X),
    py: Math.round(cmafY * SCALE_Y),
  };
}

function parseS3Uri(uri) {
  const match = uri.match(/^s3:\/\/([^/]+)\/(.+)$/);
  if (!match) throw new Error(`Invalid S3 URI: ${uri}`);
  return { bucket: match[1], key: match[2] };
}

async function downloadFromS3(s3Uri, localPath) {
  const { bucket, key } = parseS3Uri(s3Uri);
  const resp = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  await pipeline(resp.Body, fs.createWriteStream(localPath));
}

async function uploadToS3(localPath, bucket, key) {
  const body = fs.createReadStream(localPath);
  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: body,
    ContentType: 'video/mp4',
  }));
}

function msToSec(ms) {
  return (ms / 1000).toFixed(3);
}

/**
 * Build FFmpeg filter_complex for the tile layout:
 *   Background: 9:16 smart crop scaled to full 1080×1920
 *   Bottom overlay: full 16:9 source scaled to 1080×608, placed at y=1312
 *   Result: top 68% shows tight 9:16 crop, bottom 32% shows full-width context
 */
function buildFilterComplex(cropX) {
  // Split the input into two identical streams to guarantee frame-perfect sync
  const splitFilter = `[0:v]split=2[v1][v2]`;
  // Base layer: crop 608×1080 (9:16) centered on subject → scale to full 1080×1920
  const baseFilter = `[v1]crop=${CROP_W}:${SRC_HEIGHT}:${cropX}:0,scale=${OUT_W}:${OUT_H}:flags=lanczos,setsar=1[base]`;
  // Bottom overlay: scale full 1920×1080 to 1080 wide (height auto), crop to BOT_H, square pixels
  const botFilter = `[v2]scale=${OUT_W}:-2:flags=lanczos,crop=${OUT_W}:${BOT_H}:0:(ih-${BOT_H})/2,setsar=1[bot]`;
  // Overlay bottom panel at y=TOP_H — both streams from same split so frame counts match exactly
  const overlayFilter = `[base][bot]overlay=0:${TOP_H}[out]`;
  return `${splitFilter};${baseFilter};${botFilter};${overlayFilter}`;
}

exports.handler = async (event) => {
  const { action, itemId, sceneIndex } = event;

  // Poll: check if output already exists in S3
  if (action === 'poll') {
    const { expectedOutputUri } = event;
    const { bucket, key } = parseS3Uri(expectedOutputUri);
    try {
      await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      return { status: 'COMPLETE', sceneIndex, outputUri: expectedOutputUri };
    } catch (e) {
      if (e.name === 'NotFound' || e.$metadata?.httpStatusCode === 404) {
        return { status: 'PROGRESSING', sceneIndex, outputUri: expectedOutputUri };
      }
      throw e;
    }
  }

  // action === 'start'
  const { startMs, endMs, representativeX, representativeY, sourceVideoUri, executionTimestamp } = event;

  const scenePad  = String(sceneIndex).padStart(3, '0');
  const outputKey = `${itemId}/reframe-custom/scenes/scene_${scenePad}.mp4`;
  const outputUri = `s3://${OUTPUT_BUCKET}/${outputKey}`;

  // Compute crop X (must be even)
  const { px } = eiToSourcePixel(representativeX, representativeY);
  const cropX = Math.max(0, Math.min(SRC_WIDTH - CROP_W, Math.round((px - CROP_W / 2) / 2) * 2));

  console.log(JSON.stringify({
    action: 'tile-start', itemId, sceneIndex,
    cropX, startMs, endMs, representativeX, representativeY,
  }));

  const inputPath  = `/tmp/${itemId}_s${scenePad}_src.mp4`;
  const outputPath = `/tmp/${itemId}_s${scenePad}_tile.mp4`;

  try {
    // Download source video
    await downloadFromS3(sourceVideoUri, inputPath);
    console.log(JSON.stringify({ action: 'tile-downloaded', itemId, sceneIndex, sizeBytes: fs.statSync(inputPath).size }));

    // Run FFmpeg
    const filterComplex = buildFilterComplex(cropX);
    const ffmpegArgs = [
      '-y',
      '-ss', msToSec(startMs),
      '-t',  msToSec(endMs - startMs),
      '-i',  inputPath,
      '-filter_complex', filterComplex,
      '-map', '[out]',
      '-map', '0:a',
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '18',
      '-maxrate', '8M', '-bufsize', '16M',
      '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2',
      '-movflags', '+faststart',
      outputPath,
    ];

    console.log(JSON.stringify({ action: 'tile-ffmpeg-start', itemId, sceneIndex, filter: filterComplex }));
    const { stderr } = await execFileAsync(FFMPEG, ffmpegArgs, { maxBuffer: 10 * 1024 * 1024 });
    if (stderr) console.log(JSON.stringify({ action: 'tile-ffmpeg-stderr', itemId, sceneIndex, stderr: stderr.slice(-500) }));

    // Upload output
    await uploadToS3(outputPath, OUTPUT_BUCKET, outputKey);
    console.log(JSON.stringify({ action: 'tile-complete', itemId, sceneIndex, outputUri }));

    return { status: 'COMPLETE', sceneIndex, outputUri, expectedOutputUri: outputUri };

  } finally {
    for (const f of [inputPath, outputPath]) {
      try { fs.unlinkSync(f); } catch (_) {}
    }
  }
};
