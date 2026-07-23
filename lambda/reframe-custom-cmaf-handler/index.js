/**
 * reframe-custom-cmaf-handler
 *
 * Multi-action handler:
 *   convert          — Convert source video to CMAF format for EI streaming
 *   start-rekognition — Start Rekognition segment detection job
 *   poll-rekognition  — Poll Rekognition job status
 *   prepare-scenes    — Extract scene list from Rekognition results
 */

const { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectsCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const { RekognitionClient, StartSegmentDetectionCommand, GetSegmentDetectionCommand } = require('@aws-sdk/client-rekognition');
const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const s3 = new S3Client();
const rekognition = new RekognitionClient();
const STAGING_BUCKET = process.env.STAGING_BUCKET;
const FFMPEG_PATH = process.env.FFMPEG_PATH || '/usr/local/bin/ffmpeg';

/**
 * Clean up all partial CMAF objects under a given S3 prefix.
 */
async function cleanupCmafSegments(bucket, prefix) {
  try {
    const listed = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix }));
    if (listed.Contents && listed.Contents.length > 0) {
      await s3.send(new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: { Objects: listed.Contents.map(o => ({ Key: o.Key })) },
      }));
      console.log(JSON.stringify({ action: 'cmaf-cleanup', bucket, prefix, deleted: listed.Contents.length }));
    }
  } catch (err) {
    console.error(JSON.stringify({ action: 'cmaf-cleanup-error', bucket, prefix, error: err.message }));
  }
}

/**
 * Upload a local file to S3 and return the S3 key.
 */
async function uploadToS3(localPath, bucket, key, contentType) {
  const body = fs.readFileSync(localPath);
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }));
  return key;
}

exports.handler = async (event) => {
  const action = event.action || 'convert';

  if (action === 'start-rekognition') {
    return startRekognition(event);
  }
  if (action === 'poll-rekognition') {
    return pollRekognition(event);
  }
  if (action === 'prepare-scenes') {
    return prepareScenes(event);
  }
  // Default: convert
  return convertToCmaf(event);
};

async function startRekognition({ itemId, sourceVideoUri, executionTimestamp }) {
  // sourceVideoUri may be a pre-signed HTTPS URL (from Mimir proxy) or an s3:// URI.
  // Rekognition requires a proper S3 bucket/key — stage the video first if needed.
  let bucket, key;

  if (sourceVideoUri.startsWith('s3://')) {
    const parts = sourceVideoUri.replace('s3://', '').split('/');
    bucket = parts[0];
    key = parts.slice(1).join('/');
  } else {
    // Pre-signed URL — download and stage to our bucket
    const ts = executionTimestamp || Date.now();
    key = `reframe-custom/${itemId}/${ts}/source.mp4`;
    bucket = STAGING_BUCKET;

    console.log(JSON.stringify({ action: 'rekognition-stage-video', itemId, key }));
    const resp = await fetch(sourceVideoUri);
    if (!resp.ok) throw new Error(`Failed to download source video: ${resp.status}`);
    const buf = Buffer.from(await resp.arrayBuffer());
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: buf, ContentType: 'video/mp4' }));
    console.log(JSON.stringify({ action: 'rekognition-stage-done', itemId, bucket, key, sizeBytes: buf.length }));
  }

  console.log(JSON.stringify({ action: 'rekognition-start', itemId, bucket, key }));
  const resp = await rekognition.send(new StartSegmentDetectionCommand({
    Video: { S3Object: { Bucket: bucket, Name: key } },
    SegmentTypes: ['SHOT'],
  }));
  return { jobId: resp.JobId, status: 'IN_PROGRESS', stagedVideoUri: `s3://${bucket}/${key}` };
}

async function pollRekognition({ jobId }) {
  const resp = await rekognition.send(new GetSegmentDetectionCommand({ JobId: jobId }));
  return {
    jobId,
    status: resp.JobStatus,  // IN_PROGRESS | SUCCEEDED | FAILED
    segments: resp.JobStatus === 'SUCCEEDED' ? resp.Segments : [],
  };
}

function prepareScenes({ rekognitionSegments, sourceVideoUri }) {
  if (!rekognitionSegments || rekognitionSegments.length === 0) {
    return { scenes: [{ sceneIndex: 0, startMs: 0, endMs: 999999999, sourceVideoUri }] };
  }
  const scenes = rekognitionSegments
    .filter(s => s.Type === 'SHOT')
    .map((s, i) => ({
      sceneIndex: i,
      startMs: s.StartTimestampMillis || 0,
      endMs: s.EndTimestampMillis || 999999999,
      sourceVideoUri,
    }));
  return { scenes: scenes.length > 0 ? scenes : [{ sceneIndex: 0, startMs: 0, endMs: 999999999, sourceVideoUri }] };
}

async function convertToCmaf(event) {
  const { itemId, sourceVideoUri, executionTimestamp } = event;
  const ts = executionTimestamp || Date.now();
  const cmafS3Prefix = `reframe-custom/${itemId}/${ts}/cmaf`;

  console.log(JSON.stringify({
    action: 'cmaf-start',
    itemId,
    sourceVideoUri,
    executionTimestamp: ts,
    timestamp: new Date().toISOString(),
  }));

  // Parse source S3 URI
  const srcMatch = sourceVideoUri.replace('s3://', '').split('/');
  const srcBucket = srcMatch[0];
  const srcKey = srcMatch.slice(1).join('/');

  const tmpDir = `/tmp/cmaf-${itemId}-${ts}`;
  const srcPath = `${tmpDir}/source.mp4`;

  const shortId = itemId.substring(0, 8);
  const shortCmafDir = `/tmp/cmaf-${shortId}`;

  try {
    // Create temp directory
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.mkdirSync(shortCmafDir, { recursive: true });

    // Download source video
    console.log(JSON.stringify({ action: 'cmaf-download-start', itemId, srcBucket, srcKey }));
    const s3Obj = await s3.send(new GetObjectCommand({ Bucket: srcBucket, Key: srcKey }));
    const chunks = [];
    for await (const chunk of s3Obj.Body) chunks.push(chunk);
    fs.writeFileSync(srcPath, Buffer.concat(chunks));
    console.log(JSON.stringify({ action: 'cmaf-download-done', itemId, sizeBytes: fs.statSync(srcPath).size }));

    // Run FFmpeg twice — once for video-only CMAF, once for audio-only CMAF.
    // EI requires single-track init segments: one for video, one for audio.
    const videoDir = `${shortCmafDir}/video`;
    const audioDir = `${shortCmafDir}/audio`;
    fs.mkdirSync(videoDir, { recursive: true });
    fs.mkdirSync(audioDir, { recursive: true });

    // Video-only pass — scale to 1280x720 (EI max supported resolution)
    // setpts=PTS-STARTPTS resets PTS to start from 0 so EI metadata queries
    // align with Rekognition scene timestamps (which are ms from 0).
    const ffmpegVideoArgs = [
      '-i', srcPath,
      '-threads', '0',             // use all available CPU threads
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
      '-vf', 'scale=1280:720,setpts=PTS-STARTPTS',
      '-an',
      '-force_key_frames', 'expr:gte(t,n_forced*1)',
      '-f', 'hls',
      '-hls_time', '1',
      '-hls_segment_type', 'fmp4',
      '-hls_fmp4_init_filename', 'init.mp4',
      '-hls_segment_filename', `${videoDir}/seg_%03d.m4s`,
      '-hls_list_size', '0',
      `${videoDir}/playlist.m3u8`,
    ];

    // Audio-only pass — produces separate single-track audio init + segments
    // asetpts=PTS-STARTPTS resets audio PTS to 0 to match video PTS reset
    const ffmpegAudioArgs = [
      '-i', srcPath,
      '-threads', '0',
      '-vn',
      '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2',
      '-af', 'asetpts=PTS-STARTPTS',
      '-f', 'hls',
      '-hls_time', '1',
      '-hls_segment_type', 'fmp4',
      '-hls_fmp4_init_filename', 'init.mp4',
      '-hls_segment_filename', `${audioDir}/seg_%03d.m4s`,
      '-hls_list_size', '0',
      `${audioDir}/playlist.m3u8`,
    ];

    console.log(JSON.stringify({ action: 'cmaf-ffmpeg-start', itemId, mode: 'video+audio-separate' }));

    const ffmpegVideoResult = spawnSync(FFMPEG_PATH, ffmpegVideoArgs, { stdio: 'pipe', maxBuffer: 100 * 1024 * 1024 });
    if (ffmpegVideoResult.status !== 0) {
      const stderr = ffmpegVideoResult.stderr ? ffmpegVideoResult.stderr.toString() : '';
      throw new Error(`FFmpeg video pass failed (exit ${ffmpegVideoResult.status}): ${stderr.slice(-1000)}`);
    }

    const ffmpegAudioResult = spawnSync(FFMPEG_PATH, ffmpegAudioArgs, { stdio: 'pipe', maxBuffer: 100 * 1024 * 1024 });
    if (ffmpegAudioResult.status !== 0) {
      const stderr = ffmpegAudioResult.stderr ? ffmpegAudioResult.stderr.toString() : '';
      // Audio failure is non-fatal — EI can work with video-only if needed
      console.log(JSON.stringify({ action: 'cmaf-audio-pass-failed', itemId, error: stderr.slice(-500) }));
    }

    const videoFiles = fs.readdirSync(videoDir);
    const producedInit = videoFiles.includes('init.mp4');
    const producedSegs = videoFiles.filter(f => f.startsWith('seg_') && f.endsWith('.m4s'));

    if (!producedInit || producedSegs.length === 0) {
      const stderr = ffmpegVideoResult.stderr ? ffmpegVideoResult.stderr.toString() : '';
      throw new Error(`FFmpeg did not produce CMAF video segments: ${stderr.slice(-500)}`);
    }

    const audioFiles = ffmpegAudioResult.status === 0 ? fs.readdirSync(audioDir) : [];
    const hasAudioInit = audioFiles.includes('init.mp4');

    console.log(JSON.stringify({ action: 'cmaf-ffmpeg-done', itemId, videoSegments: producedSegs.length, hasAudioInit }));

    // Collect CMAF segments from videoDir
    const initFile = 'init.mp4';
    const segFiles = producedSegs.sort();

    // Get timescale from produced video segments and frame rate from source video
    let durationSeconds = 0;
    let videoTimeBase = '1/12800'; // default for libx264 output
    let videoFrameRateNum = 30000;
    let videoFrameRateDen = 1001;  // 29.97 default
    try {
      // Get frame rate from SOURCE video (not the re-encoded output)
      const ffprobeSrc = spawnSync(FFMPEG_PATH.replace('ffmpeg', 'ffprobe'), [
        '-v', 'quiet', '-print_format', 'json', '-show_streams', '-show_format', srcPath,
      ], { stdio: 'pipe' });
      if (ffprobeSrc.status === 0) {
        const info = JSON.parse(ffprobeSrc.stdout.toString());
        durationSeconds = parseFloat(info.format?.duration || '0');
        const videoStream = (info.streams || []).find(s => s.codec_type === 'video');
        if (videoStream) {
          // r_frame_rate is the actual frame rate e.g. "30000/1001" for 29.97fps
          const rfr = videoStream.r_frame_rate || '30000/1001';
          const [n, d] = rfr.split('/').map(Number);
          videoFrameRateNum = n || 30000;
          videoFrameRateDen = d || 1001;
        }
      }
      // Get timescale from produced init segment (reflects actual output timescale)
      const ffprobeInit = spawnSync(FFMPEG_PATH.replace('ffmpeg', 'ffprobe'), [
        '-v', 'quiet', '-print_format', 'json', '-show_streams',
        path.join(videoDir, 'init.mp4'),
      ], { stdio: 'pipe' });
      if (ffprobeInit.status === 0) {
        const info = JSON.parse(ffprobeInit.stdout.toString());
        const videoStream = (info.streams || []).find(s => s.codec_type === 'video');
        if (videoStream?.time_base) {
          videoTimeBase = videoStream.time_base;
        }
      }
    } catch (_) { /* non-fatal */ }

    // Also read timescale directly from first segment's sidx box as a cross-check
    try {
      const seg0 = fs.readFileSync(path.join(videoDir, 'seg_000.m4s'));
      if (seg0.length > 44) {
        const sidxTimescale = seg0.readUInt32BE(40);
        const ffprobeTimescale = parseInt((videoTimeBase || '1/12800').split('/')[1], 10);
        if (sidxTimescale > 0 && sidxTimescale !== ffprobeTimescale) {
          console.log(JSON.stringify({ action: 'cmaf-sidx-timescale-mismatch', ffprobeTimescale, sidxTimescale }));
          videoTimeBase = `1/${sidxTimescale}`;
        }
      }
    } catch (_) { /* non-fatal */ }

    // Add lmsg (last media segment) brand to the final segments for EOS signaling.
    // Binary patch: append 'lmsg' to the styp box compatible brands list.
    // This preserves the exact CMAF structure without re-muxing.
    function addLmsgBrand(segBuffer) {
      let offset = 0;
      while (offset < segBuffer.length - 8) {
        const boxSize = segBuffer.readUInt32BE(offset);
        const boxType = segBuffer.slice(offset + 4, offset + 8).toString('ascii');
        if (boxType === 'styp') {
          const lmsg = Buffer.from('lmsg');
          const newSize = boxSize + 4;
          const newBox = Buffer.alloc(newSize);
          segBuffer.copy(newBox, 0, offset, offset + boxSize);
          newBox.writeUInt32BE(newSize, 0);
          lmsg.copy(newBox, boxSize);
          return Buffer.concat([segBuffer.slice(0, offset), newBox, segBuffer.slice(offset + boxSize)]);
        }
        if (boxSize === 0 || boxSize > segBuffer.length) break;
        offset += boxSize;
      }
      return segBuffer; // no styp found, return unchanged
    }

    // Upload video init segment
    const initKey = `${cmafS3Prefix}/init.mp4`;
    await uploadToS3(path.join(videoDir, initFile), STAGING_BUCKET, initKey, 'video/mp4');
    console.log(JSON.stringify({ action: 'cmaf-upload-init', itemId, key: initKey }));

    // Upload audio init segment (separate single-track init for EI)
    let audioInitKey = null;
    if (hasAudioInit) {
      audioInitKey = `${cmafS3Prefix}/init-audio.mp4`;
      await uploadToS3(path.join(audioDir, 'init.mp4'), STAGING_BUCKET, audioInitKey, 'video/mp4');
      console.log(JSON.stringify({ action: 'cmaf-upload-audio-init', itemId, key: audioInitKey }));
    }

    // Upload media segments — patch lmsg brand into the last segment for EOS signaling
    const segmentKeys = [];
    for (let idx = 0; idx < segFiles.length; idx++) {
      const segFile = segFiles[idx];
      let segData = fs.readFileSync(path.join(videoDir, segFile));
      if (idx === segFiles.length - 1) {
        segData = addLmsgBrand(segData);
        console.log(JSON.stringify({ action: 'cmaf-lmsg-patched', itemId, segment: segFile }));
      }
      const segKey = `${cmafS3Prefix}/${segFile}`;
      await s3.send(new PutObjectCommand({ Bucket: STAGING_BUCKET, Key: segKey, Body: segData, ContentType: 'video/iso.segment' }));
      segmentKeys.push(segKey);
    }

    // Upload audio segments — patch lmsg into the last audio segment too
    const audioSegmentKeys = [];
    if (ffmpegAudioResult.status === 0) {
      const audioSegFiles = audioFiles.filter(f => f.startsWith('seg_') && f.endsWith('.m4s')).sort();
      for (let idx = 0; idx < audioSegFiles.length; idx++) {
        const segFile = audioSegFiles[idx];
        let segData = fs.readFileSync(path.join(audioDir, segFile));
        if (idx === audioSegFiles.length - 1) {
          segData = addLmsgBrand(segData);
          console.log(JSON.stringify({ action: 'cmaf-lmsg-audio-patched', itemId, segment: segFile }));
        }
        const segKey = `${cmafS3Prefix}/audio_${segFile}`;
        await s3.send(new PutObjectCommand({ Bucket: STAGING_BUCKET, Key: segKey, Body: segData, ContentType: 'video/iso.segment' }));
        audioSegmentKeys.push(segKey);
      }
      console.log(JSON.stringify({ action: 'cmaf-upload-audio-segs', itemId, count: audioSegmentKeys.length }));
    }

    if (audioSegmentKeys.length !== segmentKeys.length) {
      console.log(JSON.stringify({ action: 'cmaf-segment-count-mismatch', video: segmentKeys.length, audio: audioSegmentKeys.length }));
    }
    console.log(JSON.stringify({ action: 'cmaf-upload-done', itemId, segmentCount: segmentKeys.length }));

    return {
      status: 'success',
      cmafPrefix: `s3://${STAGING_BUCKET}/${cmafS3Prefix}/`,
      segmentCount: segmentKeys.length,
      initSegmentKey: initKey,
      audioInitSegmentKey: audioInitKey,
      audioSegmentKeys,           // same sequence numbers as segmentKeys
      segmentKeys,
      durationSeconds,
      videoTimeBase,
      videoFrameRateNum,
      videoFrameRateDen,
    };

  } catch (err) {
    console.error(JSON.stringify({
      action: 'cmaf-error',
      itemId,
      error: err.message,
      timestamp: new Date().toISOString(),
    }));

    // Clean up any partial uploads
    await cleanupCmafSegments(STAGING_BUCKET, `${cmafS3Prefix}/`);

    return { status: 'error', errorMessage: err.message };

  } finally {
    // Clean up temp files
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    try { fs.rmSync(shortCmafDir, { recursive: true, force: true }); } catch (_) {}
  }
}  // end convertToCmaf
