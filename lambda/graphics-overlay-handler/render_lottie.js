#!/usr/bin/env node
/**
 * render_lottie.js
 *
 * Renders a Lottie animation to a QuickTime MOV (qtrle + argb) using
 * Puppeteer + lottie-web (SVG renderer).
 *
 * Usage:
 *   node render_lottie.js <animation_json_path> <output_mov_path> \
 *     <width> <height> <fps> [max_frames] [fade_out_seconds] [start_frame]
 *
 * - fade_out_seconds > 0 ramps the output MOV's alpha from 1.0 → 0.0 over
 *   the final N seconds via an FFmpeg `fade=t=out:alpha=1` filter, so the
 *   overlay dissolves off screen instead of hard-cutting.
 * - start_frame > 0 seeks past the intro before capture, so renders can
 *   begin at a specific point in the animation timeline (e.g. frame 90
 *   to skip a one-shot slide-in and emit only the settled state).
 *
 * Stdout: JSON { frameCount, fps, width, height }
 * Stderr: progress logs
 */

const puppeteer = require('puppeteer');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ORIGIN = 'http://lottie.render';

const EMPTY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);

async function main() {
  const [,, animJsonPath, outputMovPath, widthStr, heightStr, fpsStr, maxFramesStr, fadeOutSecondsStr, startFrameStr] = process.argv;

  if (!animJsonPath || !outputMovPath || !widthStr || !heightStr || !fpsStr) {
    process.stderr.write('Usage: node render_lottie.js <anim.json> <output.mov> <width> <height> <fps> [max_frames] [fade_out_seconds] [start_frame]\n');
    process.exit(1);
  }

  const W = parseInt(widthStr);
  const H = parseInt(heightStr);
  const fps = parseFloat(fpsStr);
  const maxFrames = maxFramesStr ? parseInt(maxFramesStr) : null;
  // Fade length in seconds; 0 (or absent) disables the fade entirely so the
  // overlay ends on its final rendered frame.
  const fadeOutSeconds = fadeOutSecondsStr ? parseFloat(fadeOutSecondsStr) : 0;
  // Starting point in the Lottie timeline. Lets a caller request e.g. frame 90
  // to skip past a one-shot slide-in and capture only the settled state —
  // useful for the "persistent" overlay variant that stays on-screen for the
  // whole clip. Default 0 renders from the very beginning as before.
  const startFrame = startFrameStr ? parseInt(startFrameStr) : 0;

  const animJson = fs.readFileSync(animJsonPath, 'utf8');
  const animData = JSON.parse(animJson);
  const lottieJs = fs.readFileSync(
    path.join(__dirname, 'node_modules/lottie-web/build/player/lottie.min.js'),
    'utf8'
  );
  // Stub font bundled with Lambda — served for font requests so lottie-web
  // DOMLoaded fires. Actual glyph shapes come from the chars array in the JSON.
  const stubFont = fs.readFileSync(path.join(__dirname, 'DejaVuSans.ttf'));

  const NATIVE_W = animData.w || W;
  const NATIVE_H = animData.h || H;
  const needsScale = (NATIVE_W !== W || NATIVE_H !== H);
  if (needsScale) {
    process.stderr.write(`Native canvas: ${NATIVE_W}x${NATIVE_H} → scaling to ${W}x${H}\n`);
  }

  // Build HTML first — must be defined before the request handler references it
  const html = `<!DOCTYPE html>
<html>
<head>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: ${NATIVE_W}px; height: ${NATIVE_H}px; overflow: hidden; background: transparent; }
  #c { width: ${NATIVE_W}px; height: ${NATIVE_H}px; position: relative; }
</style>
</head>
<body>
<div id="c"></div>
<script src="${ORIGIN}/lottie.min.js"></script>
<script>
  window._anim = lottie.loadAnimation({
    renderer: 'svg',
    loop: false,
    autoplay: false,
    path: '${ORIGIN}/anim.json',
    container: document.getElementById('c'),
    rendererSettings: {
      preserveAspectRatio: 'xMidYMid meet',
      progressiveLoad: false,
    }
  });
  window._anim.addEventListener('DOMLoaded', function() {
    var svg = document.querySelector('#c svg');
    if (svg) {
      svg.setAttribute('width', ${NATIVE_W});
      svg.setAttribute('height', ${NATIVE_H});
      svg.style.width = '${NATIVE_W}px';
      svg.style.height = '${NATIVE_H}px';
    }
    window._ready = true;
    window._totalFrames = window._anim.totalFrames;
    window._fps = window._anim.frameRate;
    console.log('DOMLoaded fps=' + window._fps + ' frames=' + window._totalFrames);
  });
  window._anim.addEventListener('error', function(e) {
    // configError and renderFrameError are non-fatal — lottie-web fires these
    // for broken expressions but continues rendering fine.
    var type = e && e.type;
    if (type === 'configError' || type === 'renderFrameError') {
      console.log('Lottie non-fatal: ' + type);
      return;
    }
    window._lottieError = JSON.stringify(e);
    console.log('Lottie fatal error: ' + window._lottieError);
  });
</script>
</body>
</html>`;

  const browser = await puppeteer.launch({
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--single-process',
      '--no-zygote',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-default-apps',
      '--disable-sync',
      '--no-first-run',
    ],
    headless: true,
    timeout: 60000,  // 60s launch timeout for Lambda cold starts
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: NATIVE_W, height: NATIVE_H, deviceScaleFactor: 1 });

    page.on('console', msg => {
      const t = msg.text();
      if (!t.includes('parser-blocking')) process.stderr.write(`PAGE: ${t}\n`);
    });
    page.on('pageerror', err => process.stderr.write(`PAGE ERROR: ${err.message}\n`));

    await page.setRequestInterception(true);
    page.on('request', req => {
      const url = req.url();
      if (url === `${ORIGIN}/index.html` || url === `${ORIGIN}/`) {
        req.respond({ status: 200, contentType: 'text/html', body: html });
      } else if (url.includes('lottie.min.js')) {
        req.respond({ status: 200, contentType: 'application/javascript', body: lottieJs });
      } else if (url.includes('anim.json')) {
        req.respond({ status: 200, contentType: 'application/json', body: animJson });
      } else if (url.includes('/fonts/')) {
        req.respond({ status: 200, contentType: 'font/truetype', body: stubFont });
      } else {
        req.respond({ status: 200, contentType: 'image/png', body: EMPTY_PNG });
      }
    });

    // Set transparent background BEFORE navigating so Chromium doesn't fill with white
    const cdpSession = await page.createCDPSession();
    await cdpSession.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });

    // networkidle0 waits until lottie-web has loaded the JSON + fonts and fired DOMLoaded
    await page.goto(`${ORIGIN}/index.html`, { waitUntil: 'networkidle0', timeout: 30000 });

    const result = await page.evaluate(() => ({
      ready: window._ready,
      totalFrames: window._totalFrames,
      fps: window._fps,
      error: window._lottieError,
    }));

    if (result.error) throw new Error(`Lottie fatal error: ${result.error}`);
    if (!result.ready) throw new Error('DOMLoaded never fired — animation failed to load');

    const totalFrames = result.totalFrames;
    const animFps = result.fps;
    // startFrame caps against the animation's last frame so a caller asking
    // for frame 90 of a 60-frame animation safely falls back to the end
    // instead of rendering nothing.
    const effectiveStartFrame = Math.max(0, Math.min(startFrame, totalFrames - 1));
    const framesAvailable = totalFrames - effectiveStartFrame;
    const framesToRender = maxFrames
      ? Math.min(maxFrames, framesAvailable)
      : framesAvailable;

    process.stderr.write(`Animation loaded: ${totalFrames} frames @ ${animFps}fps (${NATIVE_W}x${NATIVE_H})\n`);
    process.stderr.write(`Rendering ${framesToRender} frames starting at frame ${effectiveStartFrame} → ${outputMovPath}\n`);

    // Start FFmpeg — reads PNG frames from stdin, outputs qtrle MOV with alpha
    const ffmpegArgs = [
      '-y',
      '-f', 'image2pipe', '-vcodec', 'png', '-r', String(fps), '-i', 'pipe:0',
    ];
    const filters = [];
    if (needsScale) filters.push(`scale=${W}:${H}:flags=lanczos`);
    // Alpha fade-out ramp applied to the LAST `fadeOutSeconds` of the MOV so
    // the overlay dissolves off instead of popping off. `alpha=1` restricts
    // the fade to the alpha plane — RGB stays untouched, which matters once
    // MediaConvert composites the MOV onto the smart-crop video.
    const totalSeconds = framesToRender / fps;
    const fadeStart = fadeOutSeconds > 0
      ? Math.max(0, totalSeconds - fadeOutSeconds)
      : null;
    if (fadeStart !== null) {
      filters.push(`fade=t=out:st=${fadeStart.toFixed(3)}:d=${fadeOutSeconds.toFixed(3)}:alpha=1`);
      process.stderr.write(`Alpha fade-out: start=${fadeStart.toFixed(3)}s, duration=${fadeOutSeconds.toFixed(3)}s (clip ends at ${totalSeconds.toFixed(3)}s)\n`);
    }
    if (filters.length) ffmpegArgs.push('-vf', filters.join(','));
    ffmpegArgs.push('-vcodec', 'qtrle', '-pix_fmt', 'rgba', '-movflags', '+faststart', outputMovPath);

    const ffmpeg = spawn('/usr/local/bin/ffmpeg', ffmpegArgs);
    ffmpeg.stderr.on('data', d => process.stderr.write(`FFMPEG: ${d}`));

    const ffmpegPromise = new Promise((resolve, reject) => {
      ffmpeg.on('close', code => code !== 0 ? reject(new Error(`FFmpeg exited ${code}`)) : resolve());
      ffmpeg.on('error', reject);
    });

    for (let i = 0; i < framesToRender; i++) {
      const lottieFrame = effectiveStartFrame + i;
      await page.evaluate(f => { window._anim.goToAndStop(f, true); }, lottieFrame);
      const pngBuf = await page.screenshot({
        omitBackground: true,
        clip: { x: 0, y: 0, width: NATIVE_W, height: NATIVE_H },
      });
      ffmpeg.stdin.write(pngBuf);
      if (i % 50 === 0) process.stderr.write(`  Frame ${i}/${framesToRender} (lottie frame ${lottieFrame})\n`);
    }

    ffmpeg.stdin.end();
    await ffmpegPromise;

    process.stderr.write(`Done. Output: ${outputMovPath}\n`);
    console.log(JSON.stringify({ frameCount: framesToRender, fps: animFps, width: W, height: H }));

  } finally {
    await browser.close();
  }
}

main().catch(err => {
  process.stderr.write(`render_lottie.js fatal error: ${err.message}\n${err.stack}\n`);
  process.exit(1);
});
