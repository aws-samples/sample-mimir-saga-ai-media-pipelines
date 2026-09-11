/**
 * Stability Analysis Handler
 *
 * Scores camera stability across a video clip so downstream consumers (the
 * rough cut agent) can avoid B-roll moments where the operator is hunting for
 * a shot, reframing, or walking with the camera rolling.
 *
 * How it works:
 * 1. Resolves the video source without unnecessary copying:
 *    - staged copy in our bucket (s3Uri input) when present, else
 *    - the customer's original S3 object (ingestSourceS3Bucket/FullPath) when
 *      this account can read it (customer-account deployment), else
 *    - the Mimir pre-signed proxy URL (cross-account deployment).
 *    FFmpeg reads the source over HTTPS — nothing is staged to disk.
 * 2. Runs FFmpeg's vidstabdetect (downscaled to 480px) which emits per-frame
 *    local motion vectors; the per-frame global camera motion is the median of
 *    those vectors.
 * 3. Aggregates per-second: mean motion magnitude + direction coherence
 *    (|vector sum| / sum of magnitudes). Magnitude alone can't distinguish an
 *    intentional pan from hunting — coherence can: a smooth pan moves in one
 *    consistent direction (coherence ~1), hunting jitters back and forth
 *    (coherence ~0).
 * 4. Classifies each second (stable / move / wobble / shaky), merges
 *    consecutive seconds into segments, and writes a compact JSON to
 *    stability/{itemId}/segments.json. Per-second metrics are retained so
 *    thresholds can be re-tuned later without re-running FFmpeg.
 *
 * Actions:
 * - analyze: run the analysis (input: itemId + s3Uri | proxyUrl | ingest source fields)
 * - check-stability: HeadObject probe for an existing stability file
 */

const { S3Client, PutObjectCommand, HeadObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');

const execFileAsync = promisify(execFile);
const s3Client = new S3Client();

const FFMPEG = process.env.FFMPEG_PATH || '/opt/bin/ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || '/opt/bin/ffprobe';
// Durable store for stability maps. Falls back to the staging bucket only if
// STABILITY_BUCKET is unset (older deploys). The staging bucket has a 7-day
// expiry, so stability data written there would silently disappear — the
// dedicated bucket is where these belong long-term.
const STABILITY_BUCKET = process.env.STABILITY_BUCKET || process.env.VIDEO_STAGING_BUCKET;

// Classification thresholds (pixels of global motion per frame at 480px width).
// Tuned against real field footage (news B-roll): tripod noise stays well under
// MAG_STABLE; operator hunting shows high magnitude with low coherence.
const THRESHOLDS = {
  magStable: Number(process.env.STAB_MAG_STABLE || 1.0),   // below: stable regardless of coherence
  magShaky: Number(process.env.STAB_MAG_SHAKY || 3.0),     // above + incoherent: shaky
  cohIntentional: Number(process.env.STAB_COH_INTENTIONAL || 0.7), // coherent motion = deliberate pan/tilt
  // A coherent-motion ("move") run must last at least this many consecutive
  // seconds to count as an intentional pan/tilt. Shorter bursts inside static
  // footage are settles/bumps ("settle") and are unusable.
  minPanRunSecs: Number(process.env.STAB_MIN_PAN_RUN_SECS || 3),
  // deshake block-matching contrast threshold (0-255). The filter default (125)
  // is blind on dark footage — low-light scenes have no blocks above the
  // threshold, so heavy shake reads as zero motion. 32 tracks dark club/night
  // footage reliably while staying above sensor-noise level.
  contrast: Number(process.env.STAB_CONTRAST || 32),
  // A second whose mean blur exceeds (clip median blur * this ratio) is "soft"
  // (out of focus / focus hunting) and unusable. Blur is content-relative, so
  // the threshold is relative to the clip's own median sharpness.
  blurSoftRatio: Number(process.env.STAB_BLUR_SOFT_RATIO || 1.25),
  // Handheld micro-jiggle: motion above jiggleMag that is directionally
  // incoherent (coherence below jiggleCoh) is visible shake even though it is
  // under magStable. Note magnitudes are measured at 480px analysis width, so
  // a visible ~2-3px shake at 1920 reads as ~0.3-0.8 here.
  jiggleMag: Number(process.env.STAB_JIGGLE_MAG || 0.3),
  jiggleCoh: Number(process.env.STAB_JIGGLE_COH || 0.6),
};

function parseS3Uri(s3Uri) {
  const match = (s3Uri || '').match(/^s3:\/\/([^/]+)\/(.+)$/);
  if (!match) return null;
  return { bucket: match[1], key: match[2] };
}

/**
 * Resolves a readable HTTPS URL for the video, in preference order:
 * staged copy -> customer's source S3 object (direct access) -> Mimir proxy URL.
 * S3 sources are converted to short-lived pre-signed URLs we generate ourselves
 * so FFmpeg can stream them without downloading to disk first.
 */
async function resolveVideoUrl(event) {
  // Lazy require: only needed at runtime (provided by the Lambda Node runtime);
  // keeps the pure parse/classify functions importable in local tests.
  const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
  // 1. Staged copy in our bucket (embed pipeline stages before analysis)
  const staged = parseS3Uri(event.s3Uri);
  if (staged) {
    try {
      await s3Client.send(new HeadObjectCommand({ Bucket: staged.bucket, Key: staged.key }));
      const url = await getSignedUrl(s3Client,
        new GetObjectCommand({ Bucket: staged.bucket, Key: staged.key }), { expiresIn: 3600 });
      return { url, source: 'staged' };
    } catch (err) {
      console.log(`Staged copy not readable (${err.name}), trying other sources`);
    }
  }

  // 2. Customer's original object — works when deployed in the customer account
  if (event.ingestSourceS3Bucket && event.ingestSourceFullPath) {
    const bucket = event.ingestSourceS3Bucket;
    const key = event.ingestSourceFullPath;
    try {
      await s3Client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      const url = await getSignedUrl(s3Client,
        new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: 3600 });
      return { url, source: 'direct-s3' };
    } catch (err) {
      console.log(`Cannot access s3://${bucket}/${key} directly (${err.name}), falling back to proxy`);
    }
  }

  // 3. Mimir pre-signed proxy URL (cross-account fallback)
  if (event.proxyUrl) {
    return { url: event.proxyUrl, source: 'proxy' };
  }

  throw new Error('No readable video source (no staged s3Uri, no accessible source object, no proxyUrl)');
}

/** Probes fps and duration from the source. */
async function probeVideo(url) {
  const { stdout } = await execFileAsync(FFPROBE, [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=r_frame_rate,duration',
    '-show_entries', 'format=duration',
    '-of', 'json', url,
  ], { maxBuffer: 1024 * 1024 });
  const info = JSON.parse(stdout);
  const stream = info.streams?.[0] || {};
  const [num, den] = (stream.r_frame_rate || '30/1').split('/').map(Number);
  const fps = den ? num / den : 30;
  const duration = Number(stream.duration) || Number(info.format?.duration) || 0;
  return { fps, durationMs: Math.round(duration * 1000) };
}

/**
 * Runs the deshake filter over the (downscaled) video purely for its motion
 * log, returns the CSV log path. deshake writes an ASCII CSV with per-frame
 * global motion ("Ori x"/"Ori y" columns) — unlike vidstabdetect, whose .trf
 * output switched to an undocumented binary format (TRF1) in newer libvidstab
 * builds, the deshake log format is stable and portable across versions.
 */
async function runMotionDetect(url, workDir) {
  const logPath = path.join(workDir, 'deshake.log');
  const blurPath = path.join(workDir, 'blur.log');
  // Single decode pass produces both signals: deshake's motion log (camera
  // movement) and blurdetect frame metadata (focus/sharpness). The lowered
  // contrast threshold keeps block-matching working on dark footage (the
  // filter default of 125 reports zero motion on low-light scenes).
  await execFileAsync(FFMPEG, [
    '-hide_banner', '-loglevel', 'error',
    '-i', url,
    '-vf', `scale=480:-2,deshake=contrast=${THRESHOLDS.contrast}:filename=${logPath},blurdetect,metadata=mode=print:key=lavfi.blur:file=${blurPath}`,
    '-an', '-f', 'null', '-',
  ], { maxBuffer: 10 * 1024 * 1024 });
  return { logPath, blurPath };
}

/**
 * Parses the blurdetect metadata log into per-second mean blur scores.
 * Higher blur = softer/less sharp image. Format: alternating
 * "frame:N pts:... pts_time:T" and "lavfi.blur=V" lines.
 */
function parseBlurLog(blurPath) {
  const bySecond = new Map();
  let t = null;
  for (const line of fs.readFileSync(blurPath, 'utf8').split('\n')) {
    const tm = /pts_time:([0-9.]+)/.exec(line);
    if (tm) { t = Number(tm[1]); continue; }
    const bm = /lavfi\.blur=([0-9.]+)/.exec(line);
    if (bm && t !== null) {
      const sec = Math.floor(t);
      if (!bySecond.has(sec)) bySecond.set(sec, []);
      bySecond.get(sec).push(Number(bm[1]));
    }
  }
  const out = new Map();
  for (const [sec, vals] of bySecond) {
    out.set(sec, vals.reduce((a, b) => a + b, 0) / vals.length);
  }
  return out;
}

/**
 * Parses the deshake motion log (CSV; header then one row per frame).
 * Columns 1 and 4 are the original detected global x/y shift in pixels.
 */
function parseMotionLog(logPath) {
  const text = fs.readFileSync(logPath, 'utf8');
  const frames = [];
  const lines = text.split('\n');
  let n = 0;
  for (const line of lines) {
    if (!line.trim() || line.startsWith('Ori')) continue;
    const cols = line.split(',').map((c) => Number(c.trim()));
    if (cols.length < 4 || Number.isNaN(cols[0])) continue;
    n += 1;
    frames.push({ n, dx: cols[0], dy: cols[3] });
  }
  return frames;
}

/** Aggregates per-frame global motion into per-second magnitude + coherence. */
function perSecondMetrics(frames, fps) {
  const buckets = new Map();
  for (const { n, dx, dy } of frames) {
    const sec = Math.floor((n - 1) / fps);
    if (!buckets.has(sec)) buckets.set(sec, []);
    buckets.get(sec).push({ dx, dy });
  }

  const rows = [];
  for (const sec of [...buckets.keys()].sort((a, b) => a - b)) {
    const vecs = buckets.get(sec);
    const mags = vecs.map(({ dx, dy }) => Math.hypot(dx, dy));
    const meanMag = mags.reduce((a, b) => a + b, 0) / mags.length;
    const sx = vecs.reduce((a, v) => a + v.dx, 0);
    const sy = vecs.reduce((a, v) => a + v.dy, 0);
    const total = mags.reduce((a, b) => a + b, 0) || 1e-9;
    const coherence = Math.hypot(sx, sy) / total;
    rows.push({ sec, mag: Math.round(meanMag * 100) / 100, coh: Math.round(coherence * 100) / 100 });
  }
  return rows;
}

/**
 * Classifies each second: stable | move (intentional pan) | jiggle | settle |
 * wobble | shaky | soft.
 *
 * Two-phase: first assign motion labels, then demote "move" seconds that are
 * not part of a sustained run (>= minPanRunSecs consecutive) to "settle" — an
 * isolated 1-2s coherent burst inside static footage is the camera settling
 * into or drifting off a shot, not a deliberate pan. Finally, any second whose
 * blur is well above the clip's median is "soft" (out of focus) regardless of
 * motion.
 */
function classify(rows, t = THRESHOLDS) {
  for (const r of rows) {
    if (r.mag >= t.magStable) {
      if (r.coh >= t.cohIntentional) r.label = 'move';
      else if (r.mag >= t.magShaky) r.label = 'shaky';
      else r.label = 'wobble';
    } else if (r.mag >= t.jiggleMag && r.coh < t.jiggleCoh) {
      // Sub-threshold but incoherent motion: handheld micro-shake. A locked
      // shot reads near-zero; a smooth drift reads coherent. Neither applies.
      r.label = 'jiggle';
    } else {
      r.label = 'stable';
    }
  }

  // Demote short "move" runs to "settle"
  let i = 0;
  while (i < rows.length) {
    if (rows[i].label !== 'move') { i += 1; continue; }
    let j = i;
    while (j < rows.length && rows[j].label === 'move') j += 1;
    if (j - i < t.minPanRunSecs) {
      for (let k = i; k < j; k += 1) rows[k].label = 'settle';
    }
    i = j;
  }

  // Blur: relative to the clip's own median (content-dependent metric)
  const blurs = rows.map((r) => r.blur).filter((b) => b !== undefined && b !== null);
  if (blurs.length > 0) {
    const sorted = [...blurs].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const cutoff = median * t.blurSoftRatio;
    for (const r of rows) {
      if (r.blur !== undefined && r.blur !== null && r.blur > cutoff) r.label = 'soft';
    }
  }
  return rows;
}

/**
 * Merges consecutive seconds into segments by usability. "stable" and "move"
 * are usable B-roll; "wobble" and "shaky" (operator hunting/reframing) are not.
 */
function buildSegments(rows, durationMs, minUsableMs = 2000) {
  // Usable: locked-off (stable) or sustained intentional pan (move).
  // Unusable: settle bursts, wobble, shaky hunting, and soft/out-of-focus.
  const usable = (label) => label === 'stable' || label === 'move';
  let segments = [];
  for (const r of rows) {
    const startMs = r.sec * 1000;
    const endMs = Math.min((r.sec + 1) * 1000, durationMs || (r.sec + 1) * 1000);
    const label = usable(r.label) ? 'usable' : 'unusable';
    const last = segments[segments.length - 1];
    if (last && last.label === label) {
      last.endMs = endMs;
    } else {
      segments.push({ startMs, endMs, label });
    }
  }

  // Smooth: a usable sliver shorter than minUsableMs sandwiched between
  // unusable spans can't hold a B-roll shot — relabel it unusable and re-merge.
  segments = segments.map((s, i) => {
    if (s.label === 'usable' && (s.endMs - s.startMs) < minUsableMs
        && i > 0 && i < segments.length - 1) {
      return { ...s, label: 'unusable' };
    }
    return s;
  });
  const merged = [];
  for (const s of segments) {
    const last = merged[merged.length - 1];
    if (last && last.label === s.label) last.endMs = s.endMs;
    else merged.push({ ...s });
  }
  return merged;
}

async function handleAnalyze(event) {
  const { itemId } = event;
  if (!itemId) throw new Error('itemId is required');
  if (!STABILITY_BUCKET) throw new Error('STABILITY_BUCKET (or VIDEO_STAGING_BUCKET) environment variable is not set');

  const { url, source } = await resolveVideoUrl(event);
  console.log(`Analyzing stability for ${itemId} (source: ${source})`);

  const { fps, durationMs } = await probeVideo(url);
  const { logPath, blurPath } = await runMotionDetect(url, '/tmp');

  const frames = parseMotionLog(logPath);
  const blurBySecond = parseBlurLog(blurPath);
  fs.unlinkSync(logPath);
  fs.unlinkSync(blurPath);
  if (frames.length === 0) {
    throw new Error('motion detection produced no frame data');
  }

  const metrics = perSecondMetrics(frames, fps);
  for (const r of metrics) {
    const b = blurBySecond.get(r.sec);
    if (b !== undefined) r.blur = Math.round(b * 100) / 100;
  }
  const rows = classify(metrics);
  const segments = buildSegments(rows, durationMs);
  const unusableMs = segments.filter((s) => s.label === 'unusable')
    .reduce((a, s) => a + (s.endMs - s.startMs), 0);

  const result = {
    itemId,
    analyzedAt: new Date().toISOString(),
    videoSource: source,
    fps: Math.round(fps * 100) / 100,
    durationMs,
    thresholds: THRESHOLDS,
    seconds: rows,
    segments,
  };

  const key = `stability/${itemId}/segments.json`;
  await s3Client.send(new PutObjectCommand({
    Bucket: STABILITY_BUCKET,
    Key: key,
    Body: JSON.stringify(result),
    ContentType: 'application/json',
  }));

  console.log(`Stability written: s3://${STABILITY_BUCKET}/${key} ` +
    `(${segments.length} segments, ${Math.round(unusableMs / 1000)}s unusable of ${Math.round(durationMs / 1000)}s)`);
  return {
    itemId,
    stabilityS3Uri: `s3://${STABILITY_BUCKET}/${key}`,
    segmentCount: segments.length,
    unusableMs,
    durationMs,
  };
}

async function handleCheckStability(event) {
  const { itemId } = event;
  if (!itemId) throw new Error('itemId is required');
  const key = `stability/${itemId}/segments.json`;
  try {
    await s3Client.send(new HeadObjectCommand({ Bucket: STABILITY_BUCKET, Key: key }));
    return { exists: true, stabilityS3Uri: `s3://${STABILITY_BUCKET}/${key}` };
  } catch (err) {
    if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) {
      return { exists: false };
    }
    throw err;
  }
}

exports.handler = async (event) => {
  const { action } = event;
  switch (action) {
    case 'analyze':
      return handleAnalyze(event);
    case 'check-stability':
      return handleCheckStability(event);
    default:
      throw new Error(`Unknown action: ${action}. Expected "analyze" or "check-stability".`);
  }
};

// Exported for testing
exports.parseMotionLog = parseMotionLog;
exports.parseBlurLog = parseBlurLog;
exports.perSecondMetrics = perSecondMetrics;
exports.classify = classify;
exports.buildSegments = buildSegments;
