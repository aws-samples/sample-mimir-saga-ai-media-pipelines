#!/usr/bin/env node
/**
 * render_lottie.js
 *
 * Renders a Lottie animation to a QuickTime MOV (qtrle + argb) using
 * Puppeteer + lottie-web (SVG renderer).
 *
 * Usage:
 *   node render_lottie.js <animation_json_path> <output_mov_path> <width> <height> <fps> [max_frames]
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
  const [,, animJsonPath, outputMovPath, widthStr, heightStr, fpsStr, maxFramesStr] = process.argv;

  if (!animJsonPath || !outputMovPath || !widthStr || !heightStr || !fpsStr) {
    process.stderr.write('Usage: node render_lottie.js <anim.json> <output.mov> <width> <height> <fps> [max_frames]\n');
    process.exit(1);
  }

  const W = parseInt(widthStr);
  const H = parseInt(heightStr);
  const fps = parseFloat(fpsStr);
  const maxFrames = maxFramesStr ? parseInt(maxFramesStr) : null;

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
    const framesToRender = maxFrames ? Math.min(maxFrames, totalFrames) : totalFrames;

    process.stderr.write(`Animation loaded: ${totalFrames} frames @ ${animFps}fps (${NATIVE_W}x${NATIVE_H})\n`);
    process.stderr.write(`Rendering ${framesToRender} frames → ${outputMovPath}\n`);

    // Start FFmpeg — reads PNG frames from stdin, outputs qtrle MOV with alpha
    const ffmpegArgs = [
      '-y',
      '-f', 'image2pipe', '-vcodec', 'png', '-r', String(fps), '-i', 'pipe:0',
    ];
    if (needsScale) ffmpegArgs.push('-vf', `scale=${W}:${H}:flags=lanczos`);
    ffmpegArgs.push('-vcodec', 'qtrle', '-pix_fmt', 'rgba', '-movflags', '+faststart', outputMovPath);

    const ffmpeg = spawn('/usr/local/bin/ffmpeg', ffmpegArgs);
    ffmpeg.stderr.on('data', d => process.stderr.write(`FFMPEG: ${d}`));

    const ffmpegPromise = new Promise((resolve, reject) => {
      ffmpeg.on('close', code => code !== 0 ? reject(new Error(`FFmpeg exited ${code}`)) : resolve());
      ffmpeg.on('error', reject);
    });

    for (let i = 0; i < framesToRender; i++) {
      await page.evaluate(f => { window._anim.goToAndStop(f, true); }, i);
      const pngBuf = await page.screenshot({
        omitBackground: true,
        clip: { x: 0, y: 0, width: NATIVE_W, height: NATIVE_H },
      });
      ffmpeg.stdin.write(pngBuf);
      if (i % 50 === 0) process.stderr.write(`  Frame ${i}/${framesToRender}\n`);
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
