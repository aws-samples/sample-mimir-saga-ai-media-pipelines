# Technical Design Document: reframe-custom

## 1. Architecture Overview

### 1.1 High-Level Pipeline Flow

```
POST /actions/reframe-custom
         │
         ▼
  mimir-handler (existing)
  ├─ validates X-API-Key
  ├─ filters video items
  └─ StartExecution (one per item)
         │
         ▼
  ┌──────────────────────────────────────────────────────────────────┐
  │              ReframeCustom State Machine                         │
  │                                                                  │
  │  GetMimirDetails ──► ClassifyCategory ──► StartRekognition       │
  │                                                │                 │
  │                                    ┌───────────▼──────────┐      │
  │                                    │  PollRekognition loop │      │
  │                                    │  (30s wait → poll)    │      │
  │                                    └───────────┬──────────┘      │
  │                                                │ SUCCEEDED        │
  │                              ┌─────────────────▼──────────────┐  │
  │                              │  Parallel (CMAF + RenderOverlay)│  │
  │                              │  ├─ ConvertToCMAF               │  │
  │                              │  └─ RenderOverlay               │  │
  │                              └─────────────────┬──────────────┘  │
  │                                                │                 │
  │                                    ┌───────────▼──────────┐      │
  │                                    │  CreateEIFeed         │      │
  │                                    │  PutMediaSegments     │      │
  │                                    │  QueryEIMetadata      │      │
  │                                    │  DeleteEIFeed         │      │
  │                                    └───────────┬──────────┘      │
  │                                                │                 │
  │                                    ┌───────────▼──────────┐      │
  │                                    │  Map: AnalyseScenes   │      │
  │                                    │  (max 5 concurrent)   │      │
  │                                    │  per scene:           │      │
  │                                    │  ├─ extract keyframe  │      │
  │                                    │  ├─ Nova description  │      │
  │                                    │  ├─ XY variance calc  │      │
  │                                    │  └─ CROP/TILE decision│      │
  │                                    └───────────┬──────────┘      │
  │                                                │                 │
  │                                    ┌───────────▼──────────┐      │
  │                                    │  Map: PerSceneMC jobs │      │
  │                                    │  (max 5 concurrent)   │      │
  │                                    │  poll loop per scene  │      │
  │                                    └───────────┬──────────┘      │
  │                                                │                 │
  │                                    ┌───────────▼──────────┐      │
  │                                    │  StitchScenes         │      │
  │                                    │  (MediaConvert stitch)│      │
  │                                    └───────────┬──────────┘      │
  │                                                │                 │
  │                                    ┌───────────▼──────────┐      │
  │                                    │  UploadToMimir        │      │
  │                                    └───────────┬──────────┘      │
  │                                                │                 │
  │                                           SUCCEEDED              │
  └──────────────────────────────────────────────────────────────────┘

  Fallback path (CMAF failure or EI failure):
         │
         ▼
  StartExecution: ReframeWithGraphics (existing state machine)
```

### 1.2 Relationship to Existing reframe-with-graphics Pipeline

The `reframe-custom` pipeline runs entirely independently. It:
- Reuses `mimir-details-handler`, `classify-category-handler`, and `graphics-overlay-handler` by invoking them as Lambda tasks (same pattern as `ReframeWithGraphics`).
- Does **not** modify any existing Lambda, state machine, or API Gateway route.
- Falls back to invoking the existing `ReframeWithGraphics` state machine via `StartExecution` when CMAF conversion or EI feed operations fail.
- Shares `outputBucket` and `videoStagingBucket` for intermediate storage.

### 1.3 Key AWS Services

| Service | Role |
|---|---|
| API Gateway | Receives `POST /actions/reframe-custom` |
| Lambda (mimir-handler) | Routes request, starts SFN execution per item |
| Step Functions | Orchestrates the full pipeline |
| Lambda (5 new) | CMAF, EI, scene analysis, MediaConvert, stitch |
| Amazon Rekognition | Shot/scene boundary detection |
| AWS Elemental Inference | Per-frame XY smart-crop coordinates (us-west-2 only) |
| AWS Elemental MediaConvert | Per-scene CROP/TILE encoding + final stitch (us-west-2) |
| Amazon Bedrock Nova Pro | Scene description for CROP/TILE decision |
| S3 (outputBucket) | All intermediate and final outputs |
| S3 (stagingBucket) | CMAF segments, keyframe images |
| CloudWatch Logs | State machine execution logs (ALL level, 30-day retention) |
| CloudWatch Metrics | `ReframeCustomFallbackCount` in `FonnCustomActions` namespace |
| SSM Parameter Store | State machine ARN at `/fonn-custom-actions/reframe-custom/state-machine-arn` |
| X-Ray | Tracing on state machine |


---

## 2. State Machine Design

### 2.1 Full State List

```
GetMimirDetails
ClassifyCategory
StartRekognition
WaitForRekognition (30 s)
PollRekognition
CheckRekognitionStatus (Choice)
  ├─ SUCCEEDED → PrepareSceneList
  ├─ FAILED    → UseSingleSceneFallback
  └─ IN_PROGRESS → WaitForRekognition
UseSingleSceneFallback (Pass)
PrepareSceneList (Pass)
ParallelCMAFAndOverlay (Parallel)
  ├─ Branch A: ConvertToCMAF
  └─ Branch B: RenderOverlay
CheckCMAFResult (Choice)
  ├─ success → CreateEIFeed
  └─ error   → EmitFallbackMetric → InvokeFallbackStateMachine → FallbackSucceeded
CreateEIFeed
PutMediaSegments
QueryEIMetadata
DeleteEIFeed
CheckEIResult (Choice)
  ├─ success → AnalyseScenes
  └─ error   → EmitFallbackMetric → InvokeFallbackStateMachine → FallbackSucceeded
AnalyseScenes (Map, maxConcurrency: 5)
  └─ AnalyseScene (Lambda: reframe-custom-scene-analysis-handler)
EncodeScenes (Map, maxConcurrency: 5)
  └─ StartSceneEncode (Lambda: reframe-custom-mediaconvert-handler, action: start)
     WaitForSceneEncode (30 s)
     PollSceneEncode (Lambda: reframe-custom-mediaconvert-handler, action: poll)
     CheckSceneEncodeStatus (Choice)
       ├─ COMPLETE → scene done
       ├─ ERROR    → StartFallbackSceneEncode → poll loop
       └─ other    → WaitForSceneEncode
StitchScenes (Lambda: reframe-custom-stitch-handler, action: start)
WaitForStitch (30 s)
PollStitch (Lambda: reframe-custom-stitch-handler, action: poll)
CheckStitchStatus (Choice)
  ├─ COMPLETE → UploadToMimir
  ├─ ERROR    → StitchFailed (terminal)
  └─ other    → WaitForStitch
UploadToMimir (Lambda: vertical-reframe-handler, action: upload)
ExecutionSucceeded (Pass, terminal)
```

### 2.2 Parallel vs Sequential Steps

**Sequential** (order matters, each step depends on previous output):
1. GetMimirDetails → ClassifyCategory → StartRekognition → (poll loop) → PrepareSceneList
2. CreateEIFeed → PutMediaSegments → QueryEIMetadata → DeleteEIFeed
3. AnalyseScenes → EncodeScenes → StitchScenes → UploadToMimir

**Parallel** (independent, merged before EI step):
- `ParallelCMAFAndOverlay`: CMAF conversion and Lottie overlay rendering run concurrently. Both outputs are needed before EI feed creation begins.

**Map** (fan-out):
- `AnalyseScenes`: one invocation of `reframe-custom-scene-analysis-handler` per scene, maxConcurrency 5.
- `EncodeScenes`: one invocation of `reframe-custom-mediaconvert-handler` per scene, maxConcurrency 5. Each branch contains its own poll loop.

### 2.3 Error Handling and Fallback Transitions

| State | Error condition | Transition |
|---|---|---|
| GetMimirDetails | Lambda error / explicit error payload | → TerminalFailure |
| ClassifyCategory | Lambda error / timeout | → TerminalFailure |
| StartRekognition | Rekognition API error | → UseSingleSceneFallback (treat whole video as 1 scene) |
| PollRekognition | Timeout (10 min) or FAILED status | → UseSingleSceneFallback |
| ConvertToCMAF | FFmpeg error, S3 write error | → EmitFallbackMetric → InvokeFallbackStateMachine |
| CreateEIFeed / PutMedia / QueryEI | EI API error | → EmitFallbackMetric → InvokeFallbackStateMachine |
| AnalyseScene | Keyframe or Nova error | → default CROP, log failure (no pipeline abort) |
| EncodeScene | MediaConvert ERROR | → StartFallbackSceneEncode (CROP via reframe-with-graphics approach) |
| StitchScenes | MediaConvert ERROR | → StitchFailed (terminal failure, error recorded) |
| UploadToMimir | Any Mimir API error | → TerminalFailure |

### 2.4 State Machine Definition Approach

The state machine is defined using the **CDK fluent API** (same pattern as `ReframeWithGraphics` in `infrastructure-stack.ts`), using `stepfunctions.DefinitionBody.fromChainable()`. JSONPath expressions (`.$` suffix) are used for field references, consistent with the existing codebase. JSONata is not used.

Catch blocks are attached to Lambda invoke states using `.addCatch()` with `resultPath: '$.error'` to preserve the execution state alongside the error detail.

```typescript
const getMimirDetails = new stepfunctionsTasks.LambdaInvoke(this, 'RCGetMimirDetails', {
  lambdaFunction: mimirDetailsHandler,
  // ...
  resultPath: '$.mimirDetails',
}).addCatch(terminalFailure, { errors: ['States.ALL'], resultPath: '$.error' });
```


---

## 3. Lambda Function Designs

### 3.1 reframe-custom-cmaf-handler

**Location:** `lambda/reframe-custom-cmaf-handler/index.js`
**Runtime:** `NODEJS_22_X`
**Timeout:** 15 minutes
**Memory:** 3008 MB
**Ephemeral storage:** 10240 MB (FFmpeg writes segments to /tmp before uploading)

#### Input Schema

```json
{
  "itemId": "string",
  "sourceVideoUri": "string",       // s3://bucket/key of source video
  "stagingBucket": "string",        // injected via env var, not passed in state
  "executionTimestamp": "number"    // Date.now() from execution input
}
```

#### Output Schema (success)

```json
{
  "status": "success",
  "cmafPrefix": "s3://staging-bucket/reframe-custom/{itemId}/{ts}/cmaf/",
  "segmentCount": 42,
  "initSegmentKey": "reframe-custom/{itemId}/{ts}/cmaf/init.mp4",
  "segmentKeys": [
    "reframe-custom/{itemId}/{ts}/cmaf/seg_000.m4s",
    "reframe-custom/{itemId}/{ts}/cmaf/seg_001.m4s"
  ],
  "durationSeconds": 42.0
}
```

#### Output Schema (error)

```json
{
  "status": "error",
  "errorMessage": "FFmpeg exited with code 1: ..."
}
```

#### FFmpeg Command

```bash
ffmpeg -i /tmp/source.mp4 \
  -c:v libx264 -preset fast -crf 23 \
  -c:a aac -b:a 128k -ar 48000 -ac 2 \
  -f mp4 \
  -movflags cmaf+frag_keyframe+empty_moov+default_base_moof \
  -frag_duration 1000000 \
  -min_frag_duration 1000000 \
  -segment_time 1 \
  -use_template 1 \
  -use_timeline 1 \
  /tmp/cmaf/seg_%03d.m4s \
  -map 0 -f mp4 -movflags cmaf+frag_keyframe+empty_moov \
  /tmp/cmaf/init.mp4
```

Practical approach: use the `dash` muxer with `-seg_duration 1` to produce a CMAF-compatible fragmented MP4 init segment plus numbered media segments:

```bash
ffmpeg -i /tmp/source.mp4 \
  -c:v libx264 -preset fast -crf 23 \
  -c:a aac -b:a 128k -ar 48000 -ac 2 \
  -f dash \
  -seg_duration 1 \
  -init_seg_name init.mp4 \
  -media_seg_name seg_$Number%03d$.m4s \
  -use_template 1 \
  -use_timeline 0 \
  /tmp/cmaf/manifest.mpd
```

The handler uploads `init.mp4` and all `seg_*.m4s` files to S3 in order. The MPD manifest is discarded.

#### S3 Key Structure for Segments

```
{stagingBucket}/reframe-custom/{itemId}/{executionTimestamp}/cmaf/init.mp4
{stagingBucket}/reframe-custom/{itemId}/{executionTimestamp}/cmaf/seg_000.m4s
{stagingBucket}/reframe-custom/{itemId}/{executionTimestamp}/cmaf/seg_001.m4s
...
```

#### Cleanup on Failure

If FFmpeg fails or any S3 upload fails, the handler calls `S3Client.send(new DeleteObjectsCommand(...))` to remove all objects under the `reframe-custom/{itemId}/{executionTimestamp}/cmaf/` prefix before returning the error payload. This prevents orphaned partial segments from accumulating.

```javascript
// Cleanup helper
async function cleanupCmafSegments(stagingBucket, prefix) {
  const listed = await s3.send(new ListObjectsV2Command({ Bucket: stagingBucket, Prefix: prefix }));
  if (listed.Contents?.length) {
    await s3.send(new DeleteObjectsCommand({
      Bucket: stagingBucket,
      Delete: { Objects: listed.Contents.map(o => ({ Key: o.Key })) },
    }));
  }
}
```

---

### 3.2 reframe-custom-ei-handler

**Location:** `lambda/reframe-custom-ei-handler/index.js`
**Runtime:** `NODEJS_22_X`
**Timeout:** 15 minutes
**Memory:** 512 MB
**Region:** `us-west-2` (hardcoded client)

#### Input Schema

```json
{
  "itemId": "string",
  "executionTimestamp": "number",
  "initSegmentKey": "string",
  "segmentKeys": ["string"],
  "stagingBucket": "string",
  "scenes": [
    { "startMs": 0, "endMs": 3200, "sceneIndex": 0 }
  ]
}
```

#### Output Schema (success)

```json
{
  "status": "success",
  "sceneCoordinates": [
    {
      "sceneIndex": 0,
      "startMs": 0,
      "endMs": 3200,
      "xyCoordinates": [
        { "pts": 0, "x": 540, "y": 960 },
        { "pts": 33, "x": 542, "y": 958 }
      ]
    }
  ]
}
```

#### Output Schema (error)

```json
{
  "status": "error",
  "errorMessage": "EI CreateFeed failed: ..."
}
```

#### EI Feed Creation

```javascript
const eiClient = new ElementalInferenceClient({ region: 'us-west-2' });

const feed = await eiClient.send(new CreateFeedCommand({
  FeedName: `reframe-custom-${itemId}-${executionTimestamp}`,
  FeedType: 'LIVE',
  SmartCropOutputConfig: {
    AspectRatio: '9:16',
    OutputWidth: 1080,
    OutputHeight: 1920,
  },
}));
const feedId = feed.FeedId;
```

#### PutMedia Streaming

Segments are streamed in order: init segment first, then media segments sequentially. Each segment is read from S3 and sent via `PutMedia`:

```javascript
// 1. Send init segment
const initObj = await s3.send(new GetObjectCommand({ Bucket: stagingBucket, Key: initSegmentKey }));
await eiClient.send(new PutMediaCommand({
  FeedId: feedId,
  Payload: initObj.Body,
  FragmentType: 'INITIALIZATION',
}));

// 2. Send media segments in order
for (const segKey of segmentKeys) {
  const segObj = await s3.send(new GetObjectCommand({ Bucket: stagingBucket, Key: segKey }));
  await eiClient.send(new PutMediaCommand({
    FeedId: feedId,
    Payload: segObj.Body,
    FragmentType: 'MEDIA',
  }));
}
```

#### Metadata Query per Scene

After all segments are sent, query EI for each scene's time range using PTS-based windows derived from Rekognition `StartTimestampMillis` / `EndTimestampMillis`:

```javascript
for (const scene of scenes) {
  const metadata = await eiClient.send(new GetSmartCropMetadataCommand({
    FeedId: feedId,
    StartTimestampMillis: scene.startMs,
    EndTimestampMillis: scene.endMs,
  }));
  sceneCoordinates.push({
    sceneIndex: scene.sceneIndex,
    startMs: scene.startMs,
    endMs: scene.endMs,
    xyCoordinates: metadata.Frames.map(f => ({ pts: f.PresentationTimestampMillis, x: f.CenterX, y: f.CenterY })),
  });
}
```

#### Feed Deletion

Feed deletion is always attempted in a `finally` block to ensure cleanup even if metadata queries fail:

```javascript
try {
  // ... PutMedia and QueryMetadata ...
} finally {
  try {
    await eiClient.send(new DeleteFeedCommand({ FeedId: feedId }));
  } catch (delErr) {
    console.log(JSON.stringify({ action: 'delete-feed-failed', feedId, error: delErr.message }));
  }
}
```

---

### 3.3 reframe-custom-scene-analysis-handler

**Location:** `lambda/reframe-custom-scene-analysis-handler/index.js`
**Runtime:** `NODEJS_22_X`
**Timeout:** 5 minutes
**Memory:** 1024 MB
**Ephemeral storage:** 1024 MB

#### Input Schema

```json
{
  "itemId": "string",
  "sceneIndex": 0,
  "startMs": 0,
  "endMs": 3200,
  "sourceVideoUri": "string",
  "stagingBucket": "string",
  "xyCoordinates": [
    { "pts": 0, "x": 540, "y": 960 }
  ],
  "varianceThreshold": 5000
}
```

#### Output Schema

```json
{
  "sceneIndex": 0,
  "startMs": 0,
  "endMs": 3200,
  "decision": "CROP",
  "novaDescription": "close-up interview with single subject",
  "xyVariance": 1234.5,
  "representativeX": 540,
  "representativeY": 960,
  "fallbackReason": null
}
```

#### FFmpeg Keyframe Extraction at Scene Midpoint

```javascript
const midpointSec = ((startMs + endMs) / 2) / 1000;
// Download source video to /tmp/source.mp4 (or use pre-staged S3 URI)
// Extract single frame at midpoint
execSync(
  `ffmpeg -ss ${midpointSec} -i /tmp/source.mp4 -frames:v 1 -q:v 2 /tmp/keyframe_${sceneIndex}.jpg`,
  { stdio: 'pipe' }
);
```

The keyframe JPEG is then read into a Buffer for the Bedrock call.

#### Bedrock Nova Prompt Design

```javascript
const response = await bedrockClient.send(new ConverseCommand({
  modelId: 'us.amazon.nova-pro-v1:0',
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
const description = response.output?.message?.content?.[0]?.text?.toLowerCase() || '';
```

#### XY Variance Calculation Algorithm

Variance is computed over the Euclidean distance of each frame's XY coordinate from the mean centre point:

```javascript
function computeXYVariance(xyCoordinates) {
  if (!xyCoordinates || xyCoordinates.length === 0) return 0;
  const n = xyCoordinates.length;
  const meanX = xyCoordinates.reduce((s, p) => s + p.x, 0) / n;
  const meanY = xyCoordinates.reduce((s, p) => s + p.y, 0) / n;
  const variance = xyCoordinates.reduce((s, p) => {
    const dx = p.x - meanX;
    const dy = p.y - meanY;
    return s + (dx * dx + dy * dy);
  }, 0) / n;
  return variance;
}

// Representative centre: median X and Y (more robust than mean for outliers)
function medianCoord(coords, axis) {
  const sorted = [...coords].map(p => p[axis]).sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}
```

#### CROP/TILE Decision Logic

```javascript
const TILE_KEYWORDS = ['wide shot', 'establishing shot', 'multiple subjects', 'crowd', 'wide angle'];
const CROP_KEYWORDS = ['close-up', 'closeup', 'interview', 'single subject', 'portrait'];

const highVariance = xyVariance > varianceThreshold;  // default threshold: 5000
const novaFavorsTile = TILE_KEYWORDS.some(kw => description.includes(kw));
const novaFavorsCrop = CROP_KEYWORDS.some(kw => description.includes(kw));

let decision;
if (highVariance || novaFavorsTile) {
  decision = 'TILE';
} else if (!highVariance && novaFavorsCrop) {
  decision = 'CROP';
} else {
  // Default: CROP when signals are ambiguous
  decision = 'CROP';
}
```

The `varianceThreshold` is passed in from the state machine execution input (default `5000`), making it configurable per-execution without a Lambda redeploy.

---

### 3.4 reframe-custom-mediaconvert-handler

**Location:** `lambda/reframe-custom-mediaconvert-handler/index.js`
**Runtime:** `NODEJS_22_X`
**Timeout:** 5 minutes
**Memory:** 256 MB
**Region:** `us-west-2` (hardcoded MediaConvert client)

#### Input Schema (action: start)

```json
{
  "action": "start",
  "itemId": "string",
  "sceneIndex": 0,
  "startMs": 0,
  "endMs": 3200,
  "decision": "CROP",
  "representativeX": 540,
  "representativeY": 960,
  "sourceVideoUri": "string",
  "overlayS3Uri": "string",
  "outputBucket": "string",
  "baseFilename": "string",
  "executionTimestamp": "number"
}
```

#### Input Schema (action: poll)

```json
{
  "action": "poll",
  "jobId": "string",
  "sceneIndex": 0,
  "expectedOutputUri": "string"
}
```

#### Output Schema (start)

```json
{
  "jobId": "string",
  "status": "SUBMITTED",
  "sceneIndex": 0,
  "expectedOutputUri": "s3://output-bucket/{itemId}/reframe-custom/scenes/scene_000.mp4"
}
```

#### Output Schema (poll)

```json
{
  "jobId": "string",
  "status": "COMPLETE",
  "sceneIndex": 0,
  "outputUri": "s3://output-bucket/{itemId}/reframe-custom/scenes/scene_000.mp4",
  "errorMessage": null
}
```

#### CROP Job Settings

For CROP scenes, MediaConvert applies smart crop using the EI representative XY centre point. The `InputClippings` array restricts the job to the scene's time range.

```javascript
const cropJobSettings = {
  Role: MEDIACONVERT_ROLE_ARN,
  Settings: {
    TimecodeConfig: { Source: 'ZEROBASED' },
    MotionImageInserter: {
      Input: overlayS3Uri,
      InsertionMode: 'MOV',
      Offset: { ImageX: 0, ImageY: 0 },
      Playback: 'REPEAT',
    },
    Inputs: [{
      FileInput: sourceVideoUri,
      TimecodeSource: 'ZEROBASED',
      InputClippings: [{
        StartTimecode: msToTimecode(startMs),
        EndTimecode: msToTimecode(endMs),
      }],
      AudioSelectors: { 'Audio Selector 1': { DefaultSelection: 'DEFAULT' } },
      VideoSelector: {
        // EI smart crop: provide the representative centre point
        // MediaConvert uses this as the crop anchor when ScalingBehavior is SMART_CROP
        // The XY values are normalised 0-1 fractions of the source frame dimensions
        // representativeX and representativeY are pixel coords from EI (source resolution)
        // We pass them as-is; MediaConvert accepts pixel coordinates for crop anchor
      },
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
          CodecSettings: {
            Codec: 'H_264',
            H264Settings: {
              RateControlMode: 'QVBR',
              QvbrSettings: { QvbrQualityLevel: 7 },
              MaxBitrate: 8000000,
              FramerateControl: 'INITIALIZE_FROM_SOURCE',
            },
          },
          ScalingBehavior: 'SMART_CROP',
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
  UserMetadata: { itemId, sceneIndex: String(sceneIndex), workflow: 'reframe-custom-crop' },
};
```

#### TILE Job Settings

For TILE scenes, the output is a 1080×1920 stacked composite. MediaConvert's `filter_complex`-equivalent is achieved using two `VideoOverlay` inputs or, more reliably, by using a two-pass approach:

**Approach:** Use MediaConvert's `VideoOverlay` feature (available in the `VideoDescription` → `VideoPreprocessors` → `VideoOverlay` block) to composite the scaled-down original over the smart-cropped top portion.

- **Top region (1080×1152, ~60%):** Smart-cropped reframed video using EI XY coordinates and `ScalingBehavior: SMART_CROP`.
- **Bottom region (1080×768, ~40%):** Original video scaled to 1080 wide with letterboxing (`ScalingBehavior: FIT`), positioned at Y=1152.

```javascript
const tileJobSettings = {
  Role: MEDIACONVERT_ROLE_ARN,
  Settings: {
    TimecodeConfig: { Source: 'ZEROBASED' },
    MotionImageInserter: {
      Input: overlayS3Uri,
      InsertionMode: 'MOV',
      Offset: { ImageX: 0, ImageY: 0 },
      Playback: 'REPEAT',
    },
    Inputs: [
      // Primary input: source video clipped to scene range (provides audio + base video)
      {
        FileInput: sourceVideoUri,
        TimecodeSource: 'ZEROBASED',
        InputClippings: [{ StartTimecode: msToTimecode(startMs), EndTimecode: msToTimecode(endMs) }],
        AudioSelectors: { 'Audio Selector 1': { DefaultSelection: 'DEFAULT' } },
        VideoSelector: {},
      },
    ],
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
          CodecSettings: {
            Codec: 'H_264',
            H264Settings: {
              RateControlMode: 'QVBR',
              QvbrSettings: { QvbrQualityLevel: 7 },
              MaxBitrate: 8000000,
              FramerateControl: 'INITIALIZE_FROM_SOURCE',
            },
          },
          // Top portion: smart crop to 1080x1152
          ScalingBehavior: 'SMART_CROP',
          // VideoOverlay places the scaled-down original in the bottom 768px
          VideoPreprocessors: {
            VideoOverlay: {
              Input: {
                FileInput: sourceVideoUri,
                InputClippings: [{ StartTimecode: msToTimecode(startMs), EndTimecode: msToTimecode(endMs) }],
              },
              InitialPosition: {
                Unit: 'PIXELS',
                XPosition: 0,
                YPosition: 1152,
                Width: 1080,
                Height: 768,
              },
              Playback: 'ONCE',
              ScalingBehavior: 'FIT',
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
  UserMetadata: { itemId, sceneIndex: String(sceneIndex), workflow: 'reframe-custom-tile' },
};
```

#### Poll Action

```javascript
if (action === 'poll') {
  const response = await mcClient.send(new GetJobCommand({ Id: jobId }));
  return {
    jobId,
    status: response.Job.Status,           // SUBMITTED | PROGRESSING | COMPLETE | ERROR | CANCELED
    sceneIndex,
    outputUri: expectedOutputUri,
    errorMessage: response.Job.ErrorMessage || null,
  };
}
```

#### Timecode Helper

```javascript
function msToTimecode(ms) {
  const totalFrames = Math.floor(ms / 1000 * 29.97);
  const h = Math.floor(totalFrames / (29.97 * 3600));
  const m = Math.floor((totalFrames % (29.97 * 3600)) / (29.97 * 60));
  const s = Math.floor((totalFrames % (29.97 * 60)) / 29.97);
  const f = Math.floor(totalFrames % 29.97);
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}:${String(f).padStart(2,'0')}`;
}
```

---

### 3.5 reframe-custom-stitch-handler

**Location:** `lambda/reframe-custom-stitch-handler/index.js`
**Runtime:** `NODEJS_22_X`
**Timeout:** 5 minutes
**Memory:** 256 MB
**Region:** `us-west-2` (hardcoded MediaConvert client)

#### Input Schema (action: start)

```json
{
  "action": "start",
  "itemId": "string",
  "baseFilename": "string",
  "sceneOutputUris": [
    "s3://output-bucket/{itemId}/reframe-custom/scenes/scene_000.mp4",
    "s3://output-bucket/{itemId}/reframe-custom/scenes/scene_001.mp4"
  ],
  "outputBucket": "string",
  "executionTimestamp": "number"
}
```

#### Input Schema (action: poll)

```json
{
  "action": "poll",
  "jobId": "string",
  "expectedOutputUri": "string"
}
```

#### Output Schema (start)

```json
{
  "jobId": "string",
  "status": "SUBMITTED",
  "expectedOutputUri": "s3://output-bucket/{itemId}/reframe-custom/final/{baseFilename}_9-16.mp4"
}
```

#### Output Schema (poll)

```json
{
  "jobId": "string",
  "status": "COMPLETE",
  "outputUri": "s3://output-bucket/{itemId}/reframe-custom/final/{baseFilename}_9-16.mp4",
  "errorMessage": null
}
```

#### MediaConvert Input Stitching Job Settings

MediaConvert supports multiple `FileInput` entries in a single job's `Inputs` array. Each input is processed sequentially and concatenated in the output. No `InputClippings` are needed since each scene file already contains only the scene's frames.

```javascript
const stitchJobSettings = {
  Role: MEDIACONVERT_ROLE_ARN,
  Settings: {
    TimecodeConfig: { Source: 'ZEROBASED' },
    Inputs: sceneOutputUris.map(uri => ({
      FileInput: uri,
      TimecodeSource: 'ZEROBASED',
      AudioSelectors: { 'Audio Selector 1': { DefaultSelection: 'DEFAULT' } },
      VideoSelector: {},
    })),
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
  UserMetadata: { itemId, workflow: 'reframe-custom-stitch' },
};
```

Output key: `{itemId}/reframe-custom/final/{baseFilename}_9-16.mp4`
Output stem passed to MediaConvert: `s3://{outputBucket}/{itemId}/reframe-custom/final/{baseFilename}_9-16`


---

## 4. CDK Infrastructure Design

### 4.1 New Lambda Function Declarations

All five new Lambda functions are declared in a clearly delimited section of `InfrastructureStack` after the existing `reframe-with-graphics` section. They follow the exact same pattern as existing handlers.

```typescript
// ---------------------------------------------------------------------------
// Reframe Custom pipeline
// ---------------------------------------------------------------------------

const reframeCustomCmafHandler = new lambda.Function(this, 'ReframeCustomCmafHandler', {
  functionName: 'reframe-custom-cmaf-handler',
  runtime: lambda.Runtime.NODEJS_22_X,
  handler: 'index.handler',
  code: lambda.Code.fromAsset('lambda/reframe-custom-cmaf-handler'),
  timeout: cdk.Duration.minutes(15),
  memorySize: 3008,
  ephemeralStorageSize: cdk.Size.mebibytes(10240),
  environment: {
    STAGING_BUCKET: videoStagingBucket.bucketName,
    OUTPUT_BUCKET: outputBucket.bucketName,
  },
});

const reframeCustomEiHandler = new lambda.Function(this, 'ReframeCustomEiHandler', {
  functionName: 'reframe-custom-ei-handler',
  runtime: lambda.Runtime.NODEJS_22_X,
  handler: 'index.handler',
  code: lambda.Code.fromAsset('lambda/reframe-custom-ei-handler'),
  timeout: cdk.Duration.minutes(15),
  memorySize: 512,
  environment: {
    STAGING_BUCKET: videoStagingBucket.bucketName,
    EI_REGION: 'us-west-2',
  },
});

const reframeCustomSceneAnalysisHandler = new lambda.Function(this, 'ReframeCustomSceneAnalysisHandler', {
  functionName: 'reframe-custom-scene-analysis-handler',
  runtime: lambda.Runtime.NODEJS_22_X,
  handler: 'index.handler',
  code: lambda.Code.fromAsset('lambda/reframe-custom-scene-analysis-handler'),
  timeout: cdk.Duration.minutes(5),
  memorySize: 1024,
  ephemeralStorageSize: cdk.Size.mebibytes(1024),
  environment: {
    STAGING_BUCKET: videoStagingBucket.bucketName,
    NOVA_MODEL_ID: 'us.amazon.nova-pro-v1:0',
    XY_VARIANCE_THRESHOLD: '5000',
  },
});

const reframeCustomMediaConvertHandler = new lambda.Function(this, 'ReframeCustomMediaConvertHandler', {
  functionName: 'reframe-custom-mediaconvert-handler',
  runtime: lambda.Runtime.NODEJS_22_X,
  handler: 'index.handler',
  code: lambda.Code.fromAsset('lambda/reframe-custom-mediaconvert-handler'),
  timeout: cdk.Duration.minutes(5),
  memorySize: 256,
  environment: {
    OUTPUT_BUCKET: outputBucket.bucketName,
    MEDIACONVERT_ROLE_ARN: mediaConvertRole.roleArn,   // existing role reused
    MEDIACONVERT_REGION: 'us-west-2',
  },
});

const reframeCustomStitchHandler = new lambda.Function(this, 'ReframeCustomStitchHandler', {
  functionName: 'reframe-custom-stitch-handler',
  runtime: lambda.Runtime.NODEJS_22_X,
  handler: 'index.handler',
  code: lambda.Code.fromAsset('lambda/reframe-custom-stitch-handler'),
  timeout: cdk.Duration.minutes(5),
  memorySize: 256,
  environment: {
    OUTPUT_BUCKET: outputBucket.bucketName,
    MEDIACONVERT_ROLE_ARN: mediaConvertRole.roleArn,
    MEDIACONVERT_REGION: 'us-west-2',
  },
});
```

### 4.2 Step Functions State Machine Definition

The state machine is defined using the CDK fluent API, consistent with `ReframeWithGraphics`. Key structural elements:

```typescript
// Rekognition polling loop
const waitForRekognition = new stepfunctions.Wait(this, 'RCWaitForRekognition', {
  time: stepfunctions.WaitTime.duration(cdk.Duration.seconds(30)),
});

const pollRekognition = new stepfunctionsTasks.CallAwsService(this, 'RCPollRekognition', {
  service: 'rekognition',
  action: 'getSegmentDetection',
  parameters: { 'JobId.$': '$.rekognitionJobId' },
  iamResources: ['*'],
  resultPath: '$.rekognitionResult',
});

const checkRekognitionStatus = new stepfunctions.Choice(this, 'RCCheckRekognitionStatus')
  .when(stepfunctions.Condition.stringEquals('$.rekognitionResult.JobStatus', 'SUCCEEDED'), prepareSceneList)
  .when(stepfunctions.Condition.stringEquals('$.rekognitionResult.JobStatus', 'FAILED'), useSingleSceneFallback)
  .otherwise(waitForRekognition);

waitForRekognition.next(pollRekognition).next(checkRekognitionStatus);

// Parallel: CMAF conversion + overlay rendering
const parallelCmafAndOverlay = new stepfunctions.Parallel(this, 'RCParallelCmafAndOverlay')
  .branch(convertToCmaf)
  .branch(renderOverlayForCustom);

// Scene analysis Map
const analyseScenes = new stepfunctions.Map(this, 'RCAnalyseScenes', {
  itemsPath: stepfunctions.JsonPath.stringAt('$.scenes'),
  maxConcurrency: 5,
  itemSelector: {
    'itemId.$': '$$.Execution.Input.itemId',
    'sceneIndex.$': '$$.Map.Item.Value.sceneIndex',
    'startMs.$': '$$.Map.Item.Value.startMs',
    'endMs.$': '$$.Map.Item.Value.endMs',
    'sourceVideoUri.$': '$.sourceVideoUri',
    'stagingBucket.$': '$.stagingBucket',
    'xyCoordinates.$': '$$.Map.Item.Value.xyCoordinates',
    'varianceThreshold.$': '$$.Execution.Input.varianceThreshold',
  },
}).itemProcessor(analyseScene);

// Per-scene encode Map (each branch has its own poll loop)
const encodeScenes = new stepfunctions.Map(this, 'RCEncodeScenes', {
  itemsPath: stepfunctions.JsonPath.stringAt('$.sceneAnalysisResults'),
  maxConcurrency: 5,
  itemSelector: {
    'itemId.$': '$$.Execution.Input.itemId',
    'sceneIndex.$': '$$.Map.Item.Value.sceneIndex',
    'startMs.$': '$$.Map.Item.Value.startMs',
    'endMs.$': '$$.Map.Item.Value.endMs',
    'decision.$': '$$.Map.Item.Value.decision',
    'representativeX.$': '$$.Map.Item.Value.representativeX',
    'representativeY.$': '$$.Map.Item.Value.representativeY',
    'sourceVideoUri.$': '$.sourceVideoUri',
    'overlayS3Uri.$': '$.overlayS3Uri',
    'outputBucket.$': '$.outputBucket',
    'baseFilename.$': '$$.Execution.Input.baseFilename',
    'executionTimestamp.$': '$$.Execution.Input.executionTimestamp',
  },
}).itemProcessor(encodeSceneChain);  // encodeSceneChain = start → wait → poll → check (loop)

const reframeCustomDefinition = getMimirDetailsForCustom
  .next(classifyCategoryForCustom)
  .next(startRekognition)
  .next(waitForRekognition)   // enters poll loop
  .next(/* ... */)
  // ... full chain ...

const reframeCustomStateMachine = new stepfunctions.StateMachine(this, 'ReframeCustomStateMachine', {
  stateMachineName: 'ReframeCustom',
  definitionBody: stepfunctions.DefinitionBody.fromChainable(reframeCustomDefinition),
  timeout: cdk.Duration.minutes(120),
  tracingEnabled: true,
  logs: {
    destination: new logs.LogGroup(this, 'ReframeCustomStateMachineLogs', {
      logGroupName: '/aws/states/ReframeCustom',
      retention: logs.RetentionDays.ONE_MONTH,
    }),
    level: stepfunctions.LogLevel.ALL,
  },
});
```

### 4.3 IAM Permissions per Lambda

#### reframe-custom-cmaf-handler
```typescript
videoStagingBucket.grantReadWrite(reframeCustomCmafHandler);
outputBucket.grantRead(reframeCustomCmafHandler);
// S3 DeleteObjects for cleanup
reframeCustomCmafHandler.addToRolePolicy(new iam.PolicyStatement({
  effect: iam.Effect.ALLOW,
  actions: ['s3:DeleteObject', 's3:ListBucket'],
  resources: [videoStagingBucket.bucketArn, `${videoStagingBucket.bucketArn}/*`],
}));
```

#### reframe-custom-ei-handler
```typescript
videoStagingBucket.grantRead(reframeCustomEiHandler);
reframeCustomEiHandler.addToRolePolicy(new iam.PolicyStatement({
  effect: iam.Effect.ALLOW,
  actions: [
    'elemental-inference:CreateFeed',
    'elemental-inference:DeleteFeed',
    'elemental-inference:PutMedia',
    'elemental-inference:GetSmartCropMetadata',
  ],
  resources: ['*'],
}));
```

#### reframe-custom-scene-analysis-handler
```typescript
videoStagingBucket.grantReadWrite(reframeCustomSceneAnalysisHandler);
reframeCustomSceneAnalysisHandler.addToRolePolicy(new iam.PolicyStatement({
  effect: iam.Effect.ALLOW,
  actions: ['bedrock:InvokeModel'],
  resources: ['*'],
}));
// S3 read for source video (may be in outputBucket or stagingBucket)
outputBucket.grantRead(reframeCustomSceneAnalysisHandler);
```

#### reframe-custom-mediaconvert-handler
```typescript
outputBucket.grantReadWrite(reframeCustomMediaConvertHandler);
reframeCustomMediaConvertHandler.addToRolePolicy(new iam.PolicyStatement({
  effect: iam.Effect.ALLOW,
  actions: ['mediaconvert:CreateJob', 'mediaconvert:GetJob'],
  resources: ['*'],
}));
reframeCustomMediaConvertHandler.addToRolePolicy(new iam.PolicyStatement({
  effect: iam.Effect.ALLOW,
  actions: ['iam:PassRole'],
  resources: [mediaConvertRole.roleArn],
}));
```

#### reframe-custom-stitch-handler
```typescript
outputBucket.grantReadWrite(reframeCustomStitchHandler);
reframeCustomStitchHandler.addToRolePolicy(new iam.PolicyStatement({
  effect: iam.Effect.ALLOW,
  actions: ['mediaconvert:CreateJob', 'mediaconvert:GetJob'],
  resources: ['*'],
}));
reframeCustomStitchHandler.addToRolePolicy(new iam.PolicyStatement({
  effect: iam.Effect.ALLOW,
  actions: ['iam:PassRole'],
  resources: [mediaConvertRole.roleArn],
}));
```

#### State Machine permissions
```typescript
// Grant state machine permission to invoke all new Lambdas
reframeCustomCmafHandler.grantInvoke(reframeCustomStateMachine);
reframeCustomEiHandler.grantInvoke(reframeCustomStateMachine);
reframeCustomSceneAnalysisHandler.grantInvoke(reframeCustomStateMachine);
reframeCustomMediaConvertHandler.grantInvoke(reframeCustomStateMachine);
reframeCustomStitchHandler.grantInvoke(reframeCustomStateMachine);
// Reused handlers
mimirDetailsHandler.grantInvoke(reframeCustomStateMachine);
classifyCategoryHandler.grantInvoke(reframeCustomStateMachine);
graphicsOverlayHandler.grantInvoke(reframeCustomStateMachine);
verticalReframeHandler.grantInvoke(reframeCustomStateMachine);  // for upload action

// Rekognition (via CallAwsService state — needs role policy, not grantInvoke)
reframeCustomStateMachine.addToRolePolicy(new iam.PolicyStatement({
  effect: iam.Effect.ALLOW,
  actions: ['rekognition:StartSegmentDetection', 'rekognition:GetSegmentDetection'],
  resources: ['*'],
}));

// CloudWatch PutMetricData for fallback counter
reframeCustomStateMachine.addToRolePolicy(new iam.PolicyStatement({
  effect: iam.Effect.ALLOW,
  actions: ['cloudwatch:PutMetricData'],
  resources: ['*'],
}));

// StartExecution on ReframeWithGraphics for fallback
reframeCustomStateMachine.addToRolePolicy(new iam.PolicyStatement({
  effect: iam.Effect.ALLOW,
  actions: ['states:StartExecution'],
  resources: [reframeWithGraphicsStateMachine.stateMachineArn],
}));
```

### 4.4 API Gateway Route Addition

A new resource and method are added to the existing `RestApi` instance. The existing `api` variable is referenced directly — no new API Gateway is created.

```typescript
// Existing: api.root.addResource('actions').addResource('reframe-with-graphics')
// New:
const reframeCustomResource = actionsResource.addResource('reframe-custom');
reframeCustomResource.addMethod('POST',
  new apigateway.LambdaIntegration(mimirHandler, { proxy: true }),
  { apiKeyRequired: false }  // auth handled inside mimir-handler via X-API-Key header
);
```

### 4.5 SSM Parameter for State Machine ARN

```typescript
new ssm.StringParameter(this, 'ReframeCustomStateMachineArnParam', {
  parameterName: '/fonn-custom-actions/reframe-custom/state-machine-arn',
  stringValue: reframeCustomStateMachine.stateMachineArn,
  description: 'ARN of the ReframeCustom Step Functions state machine',
});
```

### 4.6 mimir-handler Update for reframe-custom Case

A new `case 'reframe-custom':` block is added to the `switch (actionType)` statement in `lambda/mimir-handler/index.js`. It follows the same pattern as the existing `reframe-with-graphics` case: one execution per item, explicit `execName`, structured `execInput`.

```javascript
case 'reframe-custom': {
  stateMachineArn = process.env.REFRAME_CUSTOM_STATE_MACHINE_ARN;
  filteredItems = items.filter(item => item.itemType === 'video');
  if (filteredItems.length === 0) {
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({
        message: 'No video items found to process for reframe-custom',
        status: 'success',
        processedItems: [],
      }),
    };
  }
  const customResults = [];
  for (const item of filteredItems) {
    const itemTitle = item.title || item.metadata?.title || item.id || '';
    const formData = item.metadata?.formData || {};
    const itemDesc = item.description || formData.description || formData.default_description || formData.synopsis || '';
    const execName = `reframe-custom-${item.id}-${Date.now()}`;
    const execInput = {
      itemId: item.id,
      storyId: item.storyId || null,
      itemDetails: item,
      baseFilename: (item.originalFileName || item.title || item.id).replace(/\.[^/.]+$/, ''),
      title: itemTitle,
      description: itemDesc,
      transcript: '',
      lottieTemplates: {
        '9:16': 'templates/IG-Story-1080x1920-9:16.json',
        '1:1':  'templates/IG-Square-1080x1080-1:1.json',
        '4:5':  'templates/Twitter-portrait-1080x1350-4:5.json',
      },
      aspectRatios: ['9:16'],   // reframe-custom targets 9:16 only
      varianceThreshold: 5000,
      executionTimestamp: Date.now(),
      mimirApiKey,
      userToken,
      userId,
      userEmail,
    };
    const execCmd = new StartExecutionCommand({
      stateMachineArn,
      name: execName,
      input: JSON.stringify(execInput),
    });
    const execResult = await sfnClient.send(execCmd);
    customResults.push({ itemId: item.id, executionArn: execResult.executionArn });
    console.log(JSON.stringify({ action: 'started-reframe-custom', itemId: item.id, executionArn: execResult.executionArn }));
  }
  return {
    statusCode: 200,
    headers: corsHeaders,
    body: JSON.stringify({
      message: `Started Reframe Custom for ${filteredItems.length} item(s)`,
      status: 'success',
      executions: customResults,
      actionType,
    }),
  };
}
```

The `REFRAME_CUSTOM_STATE_MACHINE_ARN` environment variable is added to the `mimirHandler` Lambda declaration:

```typescript
// In the existing mimirHandler Lambda environment block, add:
REFRAME_CUSTOM_STATE_MACHINE_ARN: reframeCustomStateMachine.stateMachineArn,
```

And grant the mimir-handler permission to start executions:

```typescript
reframeCustomStateMachine.grantStartExecution(mimirHandler);
```


---

## 5. Data Flow

### 5.1 S3 Key Structure

All intermediate and final outputs use the `itemId` and `executionTimestamp` as the top-level scope to prevent collisions between concurrent executions of the same item.

```
# CMAF segments (stagingBucket)
reframe-custom/{itemId}/{executionTimestamp}/cmaf/init.mp4
reframe-custom/{itemId}/{executionTimestamp}/cmaf/seg_000.m4s
reframe-custom/{itemId}/{executionTimestamp}/cmaf/seg_001.m4s
...

# Keyframe images for scene analysis (stagingBucket)
reframe-custom/{itemId}/{executionTimestamp}/keyframes/scene_000.jpg
reframe-custom/{itemId}/{executionTimestamp}/keyframes/scene_001.jpg
...

# Per-scene MediaConvert outputs (outputBucket)
{itemId}/reframe-custom/scenes/scene_000.mp4
{itemId}/reframe-custom/scenes/scene_001.mp4
...

# Lottie overlay MOV (outputBucket) — produced by graphics-overlay-handler
{itemId}/overlays/{baseFilename}_9-16.mov

# Final stitched output (outputBucket)
{itemId}/reframe-custom/final/{baseFilename}_9-16.mp4
```

### 5.2 Step Functions Execution Input Schema

```json
{
  "itemId": "abc123",
  "storyId": "story456",
  "itemDetails": { /* full Mimir item object */ },
  "baseFilename": "breaking-news-clip",
  "title": "Breaking News Clip",
  "description": "Optional description",
  "transcript": "",
  "lottieTemplates": {
    "9:16": "templates/IG-Story-1080x1920-9:16.json"
  },
  "aspectRatios": ["9:16"],
  "varianceThreshold": 5000,
  "executionTimestamp": 1700000000000,
  "mimirApiKey": "...",
  "userToken": "...",
  "userId": "user@example.com",
  "userEmail": "user@example.com"
}
```

### 5.3 Data Passed Between States

The state machine accumulates results in the execution state object using `resultPath`. Key fields at each stage:

| After state | New fields added to `$` |
|---|---|
| GetMimirDetails | `$.mimirDetails`, `$.sourceVideoUri`, `$.proxyUrl` |
| ClassifyCategory | `$.classification` (category, line1-3, headline, location) |
| StartRekognition | `$.rekognitionJobId` |
| PollRekognition (SUCCEEDED) | `$.scenes[]` (sceneIndex, startMs, endMs) |
| ParallelCMAFAndOverlay | `$.cmafResult` (initSegmentKey, segmentKeys, segmentCount), `$.overlayResult` (overlayS3Uri) |
| QueryEIMetadata | `$.sceneCoordinates[]` (sceneIndex, xyCoordinates[]) |
| AnalyseScenes (Map) | `$.sceneAnalysisResults[]` (sceneIndex, decision, representativeX/Y, xyVariance, novaDescription) |
| EncodeScenes (Map) | `$.sceneEncodeResults[]` (sceneIndex, outputUri) |
| StitchScenes | `$.stitchResult` (jobId, outputUri) |
| UploadToMimir | `$.uploadResult` (newItemId, outputUri, status) |

The `overlayS3Uri` from the parallel branch is merged into the main state before the `EncodeScenes` Map so each scene branch can reference it via `$$.Execution.Input` or the merged state.


---

## 6. Key Technical Decisions

### 6.1 Why CMAF 1-Second Segments (EI Requirement)

AWS Elemental Inference requires video to be delivered as CMAF (Common Media Application Format) fragmented MP4 via the `PutMedia` API. The 1-second segment duration is the minimum granularity EI supports for smart-crop metadata queries. Shorter segments would increase the number of S3 objects and API calls without benefit; longer segments would reduce the temporal resolution of the XY coordinate data, making per-scene variance calculations less accurate.

The CMAF format uses:
- **Init segment** (`init.mp4`): contains codec parameters, track headers, no media data.
- **Media segments** (`seg_NNN.m4s`): each contains exactly 1 second of H.264 + AAC data, starting on a keyframe boundary.

FFmpeg's `-f dash` muxer with `-seg_duration 1` produces this structure reliably. The resulting `.m4s` files are valid CMAF media segments.

### 6.2 How EI XY Coordinates Map to MediaConvert Crop Settings

Elemental Inference returns per-frame `CenterX` / `CenterY` pixel coordinates in the source video's coordinate space (e.g. for a 1920×1080 source, X ranges 0–1920, Y ranges 0–1080). These represent the recommended centre point for the smart crop window.

MediaConvert's `ScalingBehavior: SMART_CROP` uses its own internal EI integration when no explicit crop anchor is provided. To use the pre-computed EI coordinates instead, the handler uses MediaConvert's `VideoSelector` crop settings:

```
cropLeft  = max(0, representativeX - outputWidth/2)
cropTop   = max(0, representativeY - outputHeight/2)
cropWidth = outputWidth   (1080 for 9:16)
cropHeight = outputHeight (1920 for 9:16)
```

These are passed as `VideoSelector.Crop` in the MediaConvert job:

```javascript
VideoSelector: {
  Crop: {
    X: Math.max(0, Math.round(representativeX - 540)),
    Y: Math.max(0, Math.round(representativeY - 960)),
    Width: 1080,
    Height: 1920,
  },
},
```

The `representativeX/Y` values are the median coordinates across all EI frames in the scene (computed in `reframe-custom-scene-analysis-handler`), providing a stable crop anchor that is robust to brief subject movements.

### 6.3 TILE Layout Implementation: MediaConvert VideoOverlay Approach

The TILE layout stacks two video regions vertically in a 1080×1920 frame:
- **Top 60% (1080×1152):** Smart-cropped reframed video.
- **Bottom 40% (1080×768):** Original video scaled to fit 1080 wide.

MediaConvert's `VideoOverlay` feature (under `VideoDescription.VideoPreprocessors`) composites a secondary video input over the primary output at a specified pixel position. This is the correct MediaConvert-native approach — it avoids the need for a separate FFmpeg compositing step.

The primary input produces the 1080×1920 smart-cropped output. The `VideoOverlay` then places the original video (scaled to 1080×768 with `ScalingBehavior: FIT`) at `YPosition: 1152`, covering the bottom 40% of the frame.

Both inputs use `InputClippings` with the same scene start/end timecodes to ensure temporal alignment.

**Alternative considered:** A two-pass approach (smart crop first, then composite with FFmpeg) was rejected because it requires an additional Lambda invocation, intermediate S3 storage, and FFmpeg execution for every TILE scene. The single MediaConvert job approach is simpler and more cost-effective.

### 6.4 Fallback Invocation of Existing ReframeWithGraphics State Machine

When CMAF conversion or EI feed operations fail, the pipeline invokes the existing `ReframeWithGraphics` state machine via a `stepfunctionsTasks.StepFunctionsStartExecution` state (synchronous, `.sync:2` integration pattern) or an asynchronous `StartExecution` SDK call.

The fallback state passes the same `itemId`, `storyId`, `title`, `description`, `lottieTemplates`, `aspectRatios`, and `mimirApiKey` that were in the original execution input. This ensures the fallback produces the same output format as a direct `reframe-with-graphics` invocation.

Before triggering the fallback, the pipeline emits a `ReframeCustomFallbackCount` CloudWatch metric via a `stepfunctionsTasks.CallAwsService` state targeting `cloudwatch:PutMetricData`:

```typescript
const emitFallbackMetric = new stepfunctionsTasks.CallAwsService(this, 'RCEmitFallbackMetric', {
  service: 'cloudwatch',
  action: 'putMetricData',
  parameters: {
    Namespace: 'FonnCustomActions',
    MetricData: [{
      MetricName: 'ReframeCustomFallbackCount',
      Value: 1,
      Unit: 'Count',
      Dimensions: [{ Name: 'ItemId', 'Value.$': '$$.Execution.Input.itemId' }],
    }],
  },
  iamResources: ['*'],
  resultPath: stepfunctions.JsonPath.DISCARD,
});
```


---

## 7. Error Handling Strategy

### 7.1 Per-Step Error Handling Table

| Step | Error Type | Handler | Outcome |
|---|---|---|---|
| GetMimirDetails | Lambda error, HTTP error from Mimir | `.addCatch(terminalFailure)` | Terminal failure, error recorded in state |
| ClassifyCategory | Lambda error, Bedrock timeout | `.addCatch(terminalFailure)` | Terminal failure |
| StartRekognition | Rekognition API error | `.addCatch(useSingleSceneFallback)` | Treat whole video as 1 scene, continue |
| PollRekognition | 10-min timeout (SFN `TimeoutSeconds`) | Choice: FAILED → useSingleSceneFallback | Treat whole video as 1 scene, continue |
| ConvertToCMAF | FFmpeg error, S3 error | `.addCatch(emitFallbackMetric)` | Cleanup partial segments, invoke ReframeWithGraphics |
| RenderOverlay | Lambda error | `.addCatch(terminalFailure)` | Terminal failure (overlay is required) |
| CreateEIFeed | EI API error | `.addCatch(emitFallbackMetric)` | Invoke ReframeWithGraphics |
| PutMediaSegments | EI PutMedia error | `.addCatch(emitFallbackMetric)` | Delete feed, invoke ReframeWithGraphics |
| QueryEIMetadata | EI query error, empty/unusable data | `.addCatch(emitFallbackMetric)` | Delete feed, invoke ReframeWithGraphics |
| DeleteEIFeed | EI delete error | Logged, non-fatal (finally block) | Continue pipeline |
| AnalyseScene (per scene) | Keyframe extraction error, Nova error | Default to CROP, log failure | Scene gets CROP decision, pipeline continues |
| EncodeScene (per scene) | MediaConvert ERROR | Start fallback CROP job for that scene | Scene re-encoded with basic smart crop |
| StitchScenes | MediaConvert ERROR | `.addCatch(stitchFailed)` | Terminal failure, error recorded |
| UploadToMimir | Any Mimir API error | `.addCatch(terminalFailure)` | Terminal failure |

### 7.2 Fallback Trigger Conditions

The full-pipeline fallback to `ReframeWithGraphics` is triggered by:
1. **CMAF conversion failure** — FFmpeg exits non-zero, or S3 upload of any segment fails.
2. **EI feed creation failure** — `CreateFeed` API returns an error.
3. **EI PutMedia failure** — Any segment fails to stream to EI.
4. **EI metadata query failure** — `GetSmartCropMetadata` returns an error or empty coordinate set for any scene.

The fallback is **not** triggered by:
- Rekognition failure (handled by treating the whole video as one scene).
- Per-scene MediaConvert errors (handled by per-scene fallback CROP job).
- Stitch or upload failures (these are terminal failures, not fallbacks).

When multiple EI failures occur simultaneously (e.g. during a parallel metadata query), the handler emits a single enhanced structured log entry before triggering the fallback:

```javascript
console.log(JSON.stringify({
  action: 'ei-multi-failure',
  itemId,
  failures: errors.map(e => ({ sceneIndex: e.sceneIndex, error: e.message })),
  fallbackReason: 'EI metadata query failed for one or more scenes',
}));
```

### 7.3 CloudWatch Metric Emission

The `ReframeCustomFallbackCount` metric is emitted via a `CallAwsService` state immediately before the fallback `StartExecution` state. This ensures the metric is recorded even if the fallback execution itself fails to start.

Metric specification:
- **Namespace:** `FonnCustomActions`
- **MetricName:** `ReframeCustomFallbackCount`
- **Unit:** `Count`
- **Value:** `1`
- **Dimensions:** `ItemId` = `$$.Execution.Input.itemId`, `FallbackReason` = derived from the error path

All new Lambda functions emit structured JSON logs at each major processing step:

```javascript
// Standard log format used across all new handlers
console.log(JSON.stringify({
  action: 'convert-cmaf-start',
  itemId: event.itemId,
  sourceVideoUri: event.sourceVideoUri,
  timestamp: new Date().toISOString(),
}));

// Error log format
console.error(JSON.stringify({
  action: 'convert-cmaf-error',
  itemId: event.itemId,
  error: err.message,
  stack: err.stack,
  timestamp: new Date().toISOString(),
}));
```

The `ReframeCustom` state machine has X-Ray tracing enabled (`tracingEnabled: true`) and writes all execution events to a dedicated CloudWatch Log Group (`/aws/states/ReframeCustom`) with 30-day retention.

