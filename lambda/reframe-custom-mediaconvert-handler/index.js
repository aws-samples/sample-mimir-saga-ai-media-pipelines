/**
 * reframe-custom-mediaconvert-handler
 *
 * Creates per-scene MediaConvert jobs (CROP or TILE) and polls for completion.
 *
 * Actions:
 *   start — create a MediaConvert job for a scene
 *   poll  — check job status
 *
 * CROP: smart crop using EI XY coordinates (VideoSelector.Crop)
 * TILE: top 60% smart-cropped + bottom 40% original via VideoOverlay
 */

const { MediaConvertClient, CreateJobCommand, GetJobCommand } = require('@aws-sdk/client-mediaconvert');

const MEDIACONVERT_REGION = process.env.MEDIACONVERT_REGION || 'us-west-2';
const MEDIACONVERT_ROLE_ARN = process.env.MEDIACONVERT_ROLE_ARN;
const OUTPUT_BUCKET = process.env.OUTPUT_BUCKET;
const MEDIACONVERT_QUEUE_ARN = process.env.MEDIACONVERT_QUEUE_ARN || '';

let mcEndpoint = null;

async function getMcClient() {
  if (!mcEndpoint) {
    // Discover MediaConvert endpoint
    const { MediaConvertClient: MC, DescribeEndpointsCommand } = require('@aws-sdk/client-mediaconvert');
    const discovery = new MC({ region: MEDIACONVERT_REGION });
    const resp = await discovery.send(new DescribeEndpointsCommand({ Mode: 'DEFAULT' }));
    mcEndpoint = resp.Endpoints[0].Url;
  }
  return new MediaConvertClient({ region: MEDIACONVERT_REGION, endpoint: mcEndpoint });
}

/**
 * Convert milliseconds to MediaConvert timecode HH:MM:SS:FF at 29.97 fps.
 */
function msToTimecode(ms) {
  const totalFrames = Math.floor(ms / 1000 * 29.97);
  const fps = 29.97;
  const h = Math.floor(totalFrames / (fps * 3600));
  const m = Math.floor((totalFrames % (fps * 3600)) / (fps * 60));
  const s = Math.floor((totalFrames % (fps * 60)) / fps);
  const f = Math.floor(totalFrames % fps);
  return [h, m, s, f].map(v => String(Math.floor(v)).padStart(2, '0')).join(':');
}

/**
 * Convert EI normalized coordinates (0–10000 scale) to pixel values
 * in the SOURCE video dimensions (1920x1080).
 * EI was run on 1280x720 CMAF, so we scale back up to source dimensions.
 */
const EI_FRAME_WIDTH = 1280;   // CMAF encode width
const EI_FRAME_HEIGHT = 720;   // CMAF encode height
const SRC_WIDTH = 1920;        // source video width
const SRC_HEIGHT = 1080;       // source video height
const EI_SCALE = 10000;

// Scale factor from CMAF to source
const SCALE_X = SRC_WIDTH / EI_FRAME_WIDTH;   // 1.5
const SCALE_Y = SRC_HEIGHT / EI_FRAME_HEIGHT; // 1.5

function eiToSourcePixel(normalizedX, normalizedY) {
  // Convert EI 0-10000 → CMAF pixels → source pixels
  const cmafX = (normalizedX / EI_SCALE) * EI_FRAME_WIDTH;
  const cmafY = (normalizedY / EI_SCALE) * EI_FRAME_HEIGHT;
  return {
    px: Math.round(cmafX * SCALE_X),
    py: Math.round(cmafY * SCALE_Y),
  };
}

// 9:16 crop window at source resolution: 607x1080 (1080 * 9/16 = 607.5)
const CROP_W = 608;   // 9:16 width at 1080p height
const CROP_H = 1080;  // full height

/**
 * Build a CROP MediaConvert job using EI XY coordinates.
 */
function buildCropJob(event, outputStem) {
  const { sourceVideoUri, startMs, endMs, representativeX, representativeY } = event;

  // Convert EI normalized coords to source video pixels (1920x1080)
  const { px } = eiToSourcePixel(representativeX, representativeY);
  // Center a 608x1080 (9:16) crop window on the subject — full height, horizontal pan only
  // cropX must be even (MediaConvert requirement)
  const cropX = Math.max(0, Math.min(SRC_WIDTH - CROP_W, Math.round((px - CROP_W / 2) / 2) * 2));

  return {
    Role: MEDIACONVERT_ROLE_ARN,
    Settings: {
      TimecodeConfig: { Source: 'ZEROBASED' },
      Inputs: [{
        FileInput: sourceVideoUri,
        TimecodeSource: 'ZEROBASED',
        InputClippings: [{ StartTimecode: msToTimecode(startMs), EndTimecode: msToTimecode(endMs) }],
        AudioSelectors: { 'Audio Selector 1': { DefaultSelection: 'DEFAULT' } },
        VideoSelector: {},
      }],
      OutputGroups: [{
        Name: 'File Group',
        OutputGroupSettings: {
          Type: 'FILE_GROUP_SETTINGS',
          FileGroupSettings: { Destination: outputStem },
        },
        Outputs: [{
          ContainerSettings: { Container: 'MP4', Mp4Settings: {} },
          VideoDescription: {
            Width: 1080,
            Height: 1920,
            // Crop the 1920x1080 source to 608x1080 (9:16) centered on subject,
            // then scale up to 1080x1920
            Crop: { X: cropX, Y: 0, Width: CROP_W, Height: CROP_H },
            CodecSettings: {
              Codec: 'H_264',
              H264Settings: {
                RateControlMode: 'QVBR',
                QvbrSettings: { QvbrQualityLevel: 7 },
                MaxBitrate: 8000000,
                FramerateControl: 'INITIALIZE_FROM_SOURCE',
              },
            },
          },
          AudioDescriptions: [{
            CodecSettings: {
              Codec: 'AAC',
              AacSettings: { Bitrate: 128000, CodingMode: 'CODING_MODE_2_0', SampleRate: 48000 },
            },
          }],
        }],
      }],
    },
  };
}
/**
 * Build a TILE MediaConvert job:
 * - Top 60% (1080x1152): smart-cropped using EI XY coordinates
 * - Bottom 40% (1080x768): original video scaled to fit via VideoOverlay
 */
function buildTileJob(event, outputStem) {
  const { sourceVideoUri, startMs, endMs, representativeX, representativeY } = event;

  // Convert EI normalized coords to source video pixels (1920x1080)
  const { px } = eiToSourcePixel(representativeX, representativeY);
  // For TILE: same 9:16 crop as CROP but output includes full-width context in bottom 40%
  // cropX must be even (MediaConvert requirement)
  const cropX = Math.max(0, Math.min(SRC_WIDTH - CROP_W, Math.round((px - CROP_W / 2) / 2) * 2));
  const clippings = [{ StartTimecode: msToTimecode(startMs), EndTimecode: msToTimecode(endMs) }];

  return {
    Role: MEDIACONVERT_ROLE_ARN,
    Settings: {
      TimecodeConfig: { Source: 'ZEROBASED' },
      Inputs: [{
        FileInput: sourceVideoUri,
        TimecodeSource: 'ZEROBASED',
        InputClippings: clippings,
        AudioSelectors: { 'Audio Selector 1': { DefaultSelection: 'DEFAULT' } },
        VideoSelector: {},
      }],
      OutputGroups: [{
        Name: 'File Group',
        OutputGroupSettings: {
          Type: 'FILE_GROUP_SETTINGS',
          FileGroupSettings: { Destination: outputStem },
        },
        Outputs: [{
          ContainerSettings: { Container: 'MP4', Mp4Settings: {} },
          VideoDescription: {
            Width: 1080,
            Height: 1920,
            // Crop to 9:16 portrait window centered on subject
            Crop: { X: cropX, Y: 0, Width: CROP_W, Height: CROP_H },
            CodecSettings: {
              Codec: 'H_264',
              H264Settings: {
                RateControlMode: 'QVBR',
                QvbrSettings: { QvbrQualityLevel: 7 },
                MaxBitrate: 8000000,
                FramerateControl: 'INITIALIZE_FROM_SOURCE',
              },
            },
          },
          AudioDescriptions: [{
            CodecSettings: {
              Codec: 'AAC',
              AacSettings: { Bitrate: 128000, CodingMode: 'CODING_MODE_2_0', SampleRate: 48000 },
            },
          }],
        }],
      }],
    },
  };
}

exports.handler = async (event) => {
  const { action, itemId, sceneIndex } = event;

  if (action === 'poll') {
    const { jobId, expectedOutputUri } = event;
    const mc = await getMcClient();
    const resp = await mc.send(new GetJobCommand({ Id: jobId }));
    return {
      jobId,
      status: resp.Job.Status,
      sceneIndex,
      outputUri: expectedOutputUri,
      errorMessage: resp.Job.ErrorMessage || null,
    };
  }

  // action === 'start'
  const { decision, baseFilename, executionTimestamp } = event;
  const ts = executionTimestamp || Date.now();
  const scenePad = String(sceneIndex).padStart(3, '0');
  const outputStem = `s3://${OUTPUT_BUCKET}/${itemId}/reframe-custom/scenes/scene_${scenePad}`;
  const expectedOutputUri = `${outputStem}.mp4`;

  console.log(JSON.stringify({
    action: 'mc-scene-start',
    itemId,
    sceneIndex,
    decision,
    startMs: event.startMs,
    endMs: event.endMs,
    representativeX: event.representativeX,
    representativeY: event.representativeY,
    timestamp: new Date().toISOString(),
  }));

  const jobSettings = decision === 'TILE'
    ? buildTileJob(event, outputStem)
    : buildCropJob(event, outputStem);

  // Log the VideoSelector to verify crop is being applied
  console.log(JSON.stringify({
    action: 'mc-job-settings',
    itemId,
    sceneIndex,
    decision,
    input0VideoSelector: jobSettings.Settings.Inputs[0].VideoSelector,
    inputCount: jobSettings.Settings.Inputs.length,
  }));

  jobSettings.UserMetadata = { itemId, sceneIndex: String(sceneIndex), workflow: `reframe-custom-${decision.toLowerCase()}` };
  if (MEDIACONVERT_QUEUE_ARN) jobSettings.Queue = MEDIACONVERT_QUEUE_ARN;

  const mc = await getMcClient();
  const resp = await mc.send(new CreateJobCommand(jobSettings));

  console.log(JSON.stringify({
    action: 'mc-scene-submitted',
    itemId,
    sceneIndex,
    jobId: resp.Job.Id,
    decision,
  }));

  return {
    jobId: resp.Job.Id,
    status: resp.Job.Status,
    sceneIndex,
    expectedOutputUri,
  };
};
