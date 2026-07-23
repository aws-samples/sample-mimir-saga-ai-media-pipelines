/**
 * reframe-custom-stitch-handler
 *
 * Stitches per-scene outputs into a single final video using FFmpeg concat demuxer.
 * This is a lossless stitch — no re-encoding, just container-level concatenation.
 * All inputs must have the same codec, resolution, and frame rate (guaranteed by our pipeline).
 *
 * Actions:
 *   start — download clips, concat, upload result (synchronous)
 *   poll  — check if output exists in S3
 */

const { execFile } = require('child_process');
const { promisify } = require('util');
const { S3Client, GetObjectCommand, PutObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');
const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');

const execFileAsync = promisify(execFile);
const s3 = new S3Client({});

const FFMPEG = process.env.FFMPEG_PATH || '/opt/bin/ffmpeg';
const OUTPUT_BUCKET = process.env.OUTPUT_BUCKET;

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
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: 'video/mp4' }));
}

exports.handler = async (event) => {
  const { action, itemId } = event;

  if (action === 'poll') {
    const { expectedOutputUri } = event;
    const { bucket, key } = parseS3Uri(expectedOutputUri);
    try {
      await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      return { status: 'COMPLETE', outputUri: expectedOutputUri };
    } catch (e) {
      if (e.name === 'NotFound' || e.$metadata?.httpStatusCode === 404) {
        return { status: 'PROGRESSING', outputUri: expectedOutputUri };
      }
      throw e;
    }
  }

  // action === 'start'
  const { sceneOutputUris, baseFilename } = event;
  const outputKey = `${itemId}/reframe-custom/final/${baseFilename}_9-16.mp4`;
  const outputUri = `s3://${OUTPUT_BUCKET}/${outputKey}`;

  console.log(JSON.stringify({ action: 'stitch-start', itemId, sceneCount: sceneOutputUris?.length }));

  const tmpDir = `/tmp/stitch-${itemId}`;
  fs.mkdirSync(tmpDir, { recursive: true });
  const concatListPath = path.join(tmpDir, 'concat.txt');
  const outputPath = path.join(tmpDir, 'output.mp4');

  try {
    // Download all scene clips
    const localPaths = [];
    for (let i = 0; i < sceneOutputUris.length; i++) {
      const localPath = path.join(tmpDir, `scene_${String(i).padStart(3, '0')}.mp4`);
      await downloadFromS3(sceneOutputUris[i], localPath);
      localPaths.push(localPath);
    }
    console.log(JSON.stringify({ action: 'stitch-downloaded', itemId, count: localPaths.length }));

    // Write FFmpeg concat list
    const concatContent = localPaths.map(p => `file '${p}'`).join('\n');
    fs.writeFileSync(concatListPath, concatContent);

    // Concat with re-encode to ensure consistent output
    // (lossless concat requires identical codec params; re-encode is safer across CROP+TILE mix)
    const ffmpegArgs = [
      '-y',
      '-f', 'concat',
      '-safe', '0',
      '-i', concatListPath,
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '18',
      '-maxrate', '8M', '-bufsize', '16M',
      '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2',
      '-movflags', '+faststart',
      outputPath,
    ];

    console.log(JSON.stringify({ action: 'stitch-ffmpeg-start', itemId }));
    await execFileAsync(FFMPEG, ffmpegArgs, { maxBuffer: 10 * 1024 * 1024 });

    await uploadToS3(outputPath, OUTPUT_BUCKET, outputKey);
    console.log(JSON.stringify({ action: 'stitch-complete', itemId, outputUri }));

    return { status: 'COMPLETE', outputUri, expectedOutputUri: outputUri, jobId: 'ffmpeg-stitch' };

  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
};
