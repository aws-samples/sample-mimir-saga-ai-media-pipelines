/**
 * reframe-custom-ei-handler
 *
 * Manages an AWS Elemental Inference feed to extract per-frame smart-crop
 * XY centre-point coordinates for each scene in the video.
 *
 * Control plane: https://elemental-inference.{region}.amazonaws.com
 *   - CreateFeed:     POST   /v1/feed
 *   - AssociateFeed:  POST   /v1/feed/{id}/associate   ← REQUIRED before PutMedia
 *   - GetFeed:        GET    /v1/feed/{id}
 *   - DeleteFeed:     DELETE /v1/feed/{id}
 *
 * Data plane: feed.dataEndpoints[0]  (different host, same signing service)
 *   - PutMedia:    PUT    /v1/feed/{feedId}/input/{inputId}/media/{mediaPath+}
 *   - GetMetadata: POST   /v1/feed/{feedId}/input/{inputId}/metadata
 *
 * PutMedia has @unsignedPayload — must set x-amz-content-sha256: UNSIGNED-PAYLOAD.
 */

const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { SignatureV4 } = require('@aws-sdk/signature-v4');
const { HttpRequest } = require('@smithy/protocol-http');
const { defaultProvider } = require('@aws-sdk/credential-provider-node');
const { createHash, createHmac } = require('crypto');

const s3 = new S3Client();
const EI_REGION = process.env.EI_REGION || 'us-west-2';
const STAGING_BUCKET = process.env.STAGING_BUCKET;
const EI_SERVICE = 'elemental-inference';
const EI_BASE_URL = `https://${EI_SERVICE}.${EI_REGION}.amazonaws.com`;

// SHA256 that handles both plain hash and HMAC modes.
// SignatureV4 calls new NodeSha256(secret) for HMAC key derivation —
// the secret parameter MUST be handled or the signing key will be wrong.
class NodeSha256 {
  constructor(secret) {
    this.hash = secret ? createHmac('sha256', secret) : createHash('sha256');
  }
  update(data) { this.hash.update(data); return this; }
  async digest() { return this.hash.digest(); }
}

const signer = new SignatureV4({
  credentials: defaultProvider(),
  region: EI_REGION,
  service: EI_SERVICE,  // same for both control and data plane
  sha256: NodeSha256,
});

/**
 * Make a SigV4-signed request to an EI endpoint.
 * Retries up to 5 times with exponential backoff on 429 rate limit responses.
 */
async function eiRequest(baseUrl, method, path, body = null, extraHeaders = {}, unsignedPayload = false) {
  const MAX_RETRIES = 5;
  const BASE_DELAY_MS = 500;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const normalizedBase = baseUrl.replace(/\/$/, '');
    const encodedPath = path.replace(/\(/g, '%28').replace(/\)/g, '%29');
    const url = new URL(`${normalizedBase}${encodedPath}`);

    const bodyBuf = body instanceof Buffer ? body
      : body ? Buffer.from(JSON.stringify(body))
      : undefined;

    const isJson = body !== null && !(body instanceof Buffer);

    const headers = {
      host: url.hostname,
      'content-type': isJson ? 'application/json' : 'application/octet-stream',
      ...extraHeaders,
    };
    if (bodyBuf) headers['content-length'] = String(bodyBuf.length);
    if (unsignedPayload) headers['x-amz-content-sha256'] = 'UNSIGNED-PAYLOAD';

    const httpRequest = new HttpRequest({
      method,
      protocol: 'https:',
      hostname: url.hostname,
      path: url.pathname + (url.search || ''),
      headers,
      body: bodyBuf,
    });

    const signed = await signer.sign(httpRequest, {
      signingDate: new Date(),
      ...(unsignedPayload ? { unsignedPayload: true } : {}),
    });

    const response = await fetch(`${normalizedBase}${encodedPath}`, {
      method,
      headers: signed.headers,
      body: bodyBuf,
    });

    // Retry on 429 with exponential backoff
    if (response.status === 429) {
      if (attempt === MAX_RETRIES) {
        const text = await response.text().catch(() => '');
        throw new Error(`EI ${method} ${path} failed: 429 ${text.slice(0, 500)} (exhausted ${MAX_RETRIES} retries)`);
      }
      const retryAfter = response.headers.get('retry-after');
      const delay = retryAfter ? parseInt(retryAfter) * 1000 : BASE_DELAY_MS * Math.pow(2, attempt);
      console.log(JSON.stringify({ action: 'ei-rate-limit-retry', path, attempt, delayMs: delay }));
      await new Promise(r => setTimeout(r, delay));
      continue;
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`EI ${method} ${path} failed: ${response.status} ${text.slice(0, 500)}`);
    }

    if (response.status === 204) return null;
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) return response.json();
    const rawText = await response.text().catch(() => '');
    if (rawText) console.log(JSON.stringify({ action: 'ei-non-json-response', status: response.status, contentType, body: rawText.slice(0, 300) }));
    try {
      return rawText ? JSON.parse(rawText) : null;
    } catch {
      console.log(JSON.stringify({ action: 'ei-parse-failed', status: response.status, body: rawText.slice(0, 300) }));
      return null;
    }
  }
}

async function readS3Object(bucket, key) {
  const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const chunks = [];
  for await (const chunk of obj.Body) chunks.push(chunk);
  return Buffer.concat(chunks);
}

exports.handler = async (event) => {
  const { itemId, executionTimestamp, initSegmentKey, segmentKeys, scenes } = event;
  const stagingBucket = event.stagingBucket || STAGING_BUCKET;
  const feedName = `reframe-custom-${itemId}-${executionTimestamp}`;

  // Frame rate from CMAF handler — used in GetMetadata frameRate parameter
  const videoFrameRateNum = event.videoFrameRateNum || 30000;
  const videoFrameRateDen = event.videoFrameRateDen || 1001;

  console.log(JSON.stringify({
    action: 'ei-start', itemId, feedName,
    segmentCount: segmentKeys?.length, sceneCount: scenes?.length,
    videoFrameRateNum, videoFrameRateDen,
    timestamp: new Date().toISOString(),
  }));

  let feedId = null;
  let dataEndpoint = EI_BASE_URL;

  try {
    // Step 1: Create feed — POST /v1/feed
    // NOTE: The `inputs` field is ignored by the service. Inputs are auto-created
    // based on output config. A cropping output creates a video input.
    console.log(JSON.stringify({ action: 'ei-create-feed', itemId, feedName }));
    const createResp = await eiRequest(EI_BASE_URL, 'POST', '/v1/feed', {
      name: feedName,
      outputs: [{
        name: 'smartCropOutput',
        outputConfig: { cropping: {} },
        status: 'ENABLED',
      }],
    });

    feedId = createResp.id;
    dataEndpoint = createResp.dataEndpoints?.[0] || EI_BASE_URL;
    if (!dataEndpoint.startsWith('http')) dataEndpoint = `https://${dataEndpoint}`;
    console.log(JSON.stringify({ action: 'ei-feed-created', itemId, feedId, dataEndpoint }));

    // Step 2: AssociateFeed — REQUIRED before PutMedia
    // PutMedia returns 409 "Feed is not associated with a resource" without this.
    // For standalone (non-MediaLive) use, pass a non-ARN name as associatedResourceName.
    console.log(JSON.stringify({ action: 'ei-associate-feed', itemId, feedId }));
    await eiRequest(EI_BASE_URL, 'POST', `/v1/feed/${feedId}/associate`, {
      associatedResourceName: feedName,
      outputs: [{
        name: 'smartCropOutput',
        outputConfig: { cropping: {} },
        status: 'ENABLED',
      }],
    });
    console.log(JSON.stringify({ action: 'ei-feed-associated', itemId, feedId }));

    // Step 3: Poll GetFeed until ACTIVE/AVAILABLE
    // Both audio and video use input/0 per the EI docs
    console.log(JSON.stringify({ action: 'ei-wait-active', itemId, feedId }));
    let feedReady = false;

    for (let attempt = 0; attempt < 30; attempt++) {
      const feedDetails = await eiRequest(EI_BASE_URL, 'GET', `/v1/feed/${feedId}`);
      const status = feedDetails?.status;
      if (attempt === 0) {
        console.log(JSON.stringify({ action: 'ei-feed-details', itemId, feedId, details: feedDetails }));
      } else {
        console.log(JSON.stringify({ action: 'ei-feed-status', itemId, feedId, status, attempt }));
      }
      if (status === 'ACTIVE' || status === 'AVAILABLE') { feedReady = true; break; }
      if (status === 'ERROR' || status === 'FAILED') throw new Error(`Feed entered ${status} state`);
      await new Promise(r => setTimeout(r, 2000));
    }
    if (!feedReady) throw new Error('Feed did not become ready after 30 attempts');

    // Step 4: PutMedia — both audio and video to input/0, interleaved by sequence number
    // Docs: "EI ingests all media segments for a given sequence number before proceeding to the next"
    // Both streams go to input/0 (not input/1 — that was wrong)
    console.log(JSON.stringify({ action: 'ei-put-init', itemId, feedId, key: initSegmentKey }));
    const initBuffer = await readS3Object(stagingBucket, initSegmentKey);

    // Video init → input/0
    const videoInitPath = `/v1/feed/${feedId}/input/0/media/Streams(default-video.cmfv)/InitializationSegment`;
    await eiRequest(dataEndpoint, 'PUT', videoInitPath, initBuffer, {}, true);

    // Audio init → input/0 (best-effort)
    if (event.audioInitSegmentKey) {
      const audioInitBuffer = await readS3Object(stagingBucket, event.audioInitSegmentKey);
      const audioInitPath = `/v1/feed/${feedId}/input/0/media/Streams(default-audio.cmfa)/InitializationSegment`;
      await eiRequest(dataEndpoint, 'PUT', audioInitPath, audioInitBuffer, {}, true).catch(e => {
        console.log(JSON.stringify({ action: 'ei-audio-init-skip', note: e.message }));
      });
    }

    // Step 5: Stream segments interleaved — video then audio for each sequence number
    const audioSegmentKeys = event.audioSegmentKeys || [];
    for (let i = 0; i < segmentKeys.length; i++) {
      const segBuffer = await readS3Object(stagingBucket, segmentKeys[i]);
      const segPath = `/v1/feed/${feedId}/input/0/media/Streams(default-video.cmfv)/Segment(${i + 1})`;
      await eiRequest(dataEndpoint, 'PUT', segPath, segBuffer, {}, true);

      // Audio segment for same sequence number
      if (audioSegmentKeys[i]) {
        const audioSegBuffer = await readS3Object(stagingBucket, audioSegmentKeys[i]);
        const audioSegPath = `/v1/feed/${feedId}/input/0/media/Streams(default-audio.cmfa)/Segment(${i + 1})`;
        await eiRequest(dataEndpoint, 'PUT', audioSegPath, audioSegBuffer, {}, true).catch(e => {
          if (i === 0) console.log(JSON.stringify({ action: 'ei-audio-seg-skip', note: e.message }));
        });
      }

      await new Promise(r => setTimeout(r, 100));
      if (i % 10 === 0) {
        console.log(JSON.stringify({ action: 'ei-put-media-progress', itemId, feedId, segment: i, total: segmentKeys.length }));
      }
    }

    // EOS: the last segment has lmsg brand (added by CMAF handler).
    // Short wait as fallback in case lmsg wasn't added.
    console.log(JSON.stringify({ action: 'ei-eos-wait', itemId, feedId }));
    await new Promise(r => setTimeout(r, 2000));
    console.log(JSON.stringify({ action: 'ei-put-media-done', itemId, feedId, totalSegments: segmentKeys.length }));

    // Step 6: GetMetadata per scene
    const sceneCoordinates = [];
    const errors = [];

    // Elemental Inference caps a single GetMetadata query at a 30s range
    // (413 RESULT_SET_TOO_LARGE beyond that). Split each scene into windows that
    // stay safely under the limit, query each, and concatenate the results.
    const MAX_METADATA_WINDOW_MS = 29000;

    for (const scene of scenes) {
      try {
        const collected = [];
        for (let windowStart = scene.startMs; windowStart < scene.endMs; windowStart += MAX_METADATA_WINDOW_MS) {
          const windowEnd = Math.min(windowStart + MAX_METADATA_WINDOW_MS, scene.endMs);
          const metaResp = await eiRequest(dataEndpoint, 'POST', `/v1/feed/${feedId}/input/0/metadata`, {
            outputName: 'smartCropOutput',
            timeSpecification: {
              // Docs show timescale: 1000 (milliseconds) for GetMetadata queries
              ptsBased: { startPts: windowStart, endPts: windowEnd, timescale: 1000 },
            },
            parameters: {
              smartCropping: { frameRate: { numerator: videoFrameRateNum, denominator: videoFrameRateDen } },
            },
          });

          for (const item of (metaResp?.items || [])) {
            collected.push({
              pts: item.pts,
              x: item.metadata?.smartCropping?.crop?.centerPoint?.xPosition ?? 0,
              y: item.metadata?.smartCropping?.crop?.centerPoint?.yPosition ?? 0,
            });
          }
        }

        // De-duplicate by pts (a frame at a window boundary can appear in two
        // adjacent queries) and keep them ordered by presentation time.
        const seenPts = new Set();
        const xyCoordinates = collected
          .sort((a, b) => a.pts - b.pts)
          .filter(c => (seenPts.has(c.pts) ? false : seenPts.add(c.pts)));

        if (xyCoordinates.length === 0) {
          errors.push({ sceneIndex: scene.sceneIndex, error: 'No coordinate data returned' });
        } else {
          sceneCoordinates.push({ sceneIndex: scene.sceneIndex, startMs: scene.startMs, endMs: scene.endMs, xyCoordinates });
        }
      } catch (sceneErr) {
        errors.push({ sceneIndex: scene.sceneIndex, error: sceneErr.message });
      }
    }

    if (errors.length > 0) {
      console.error(JSON.stringify({ action: 'ei-multi-failure', itemId, feedId, failures: errors }));
      throw new Error(`EI metadata query failed for ${errors.length} scene(s): ${errors[0].error}`);
    }

    console.log(JSON.stringify({ action: 'ei-query-done', itemId, feedId, sceneCount: sceneCoordinates.length }));
    return { status: 'success', sceneCoordinates };

  } catch (err) {
    console.error(JSON.stringify({ action: 'ei-error', itemId, feedId, error: err.message, timestamp: new Date().toISOString() }));
    throw err;

  } finally {
    if (feedId) {
      try {
        await eiRequest(EI_BASE_URL, 'POST', `/v1/feed/${feedId}/disassociate`, { associatedResourceName: feedName });
        console.log(JSON.stringify({ action: 'ei-feed-disassociated', itemId, feedId }));
      } catch (disErr) {
        console.log(JSON.stringify({ action: 'ei-feed-disassociate-failed', itemId, feedId, error: disErr.message }));
      }
      try {
        await eiRequest(EI_BASE_URL, 'DELETE', `/v1/feed/${feedId}`);
        console.log(JSON.stringify({ action: 'ei-feed-deleted', itemId, feedId }));
      } catch (delErr) {
        console.log(JSON.stringify({ action: 'ei-feed-delete-failed', itemId, feedId, error: delErr.message }));
      }
    }
  }
};
