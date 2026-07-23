# Implementation Plan

- [x] 1. Create `reframe-custom-cmaf-handler` Lambda
  - Create `lambda/reframe-custom-cmaf-handler/index.js` with an `exports.handler` entry point
  - Download source video from S3 to `/tmp/source.mp4` using `@aws-sdk/client-s3` `GetObjectCommand`
  - Run FFmpeg using the `-f dash -seg_duration 1` muxer to produce `init.mp4` and `seg_NNN.m4s` files under `/tmp/cmaf/`
  - Upload `init.mp4` then all `seg_*.m4s` files in order to `s3://{STAGING_BUCKET}/reframe-custom/{itemId}/{executionTimestamp}/cmaf/`
  - On any FFmpeg or S3 upload failure, call `DeleteObjectsCommand` to clean up all partial objects under the prefix, then return `{ status: "error", errorMessage: "..." }`
  - On success return `{ status: "success", cmafPrefix, segmentCount, initSegmentKey, segmentKeys, durationSeconds }`
  - Emit structured JSON logs (`action`, `itemId`, `timestamp`) at start, after FFmpeg, after upload, and on error
  - Create `lambda/reframe-custom-cmaf-handler/package.json` with `@aws-sdk/client-s3` as a dependency
  - _Requirements: Req 5, Req 15_

- [x] 2. Create `reframe-custom-ei-handler` Lambda
  - Create `lambda/reframe-custom-ei-handler/index.js` with an `exports.handler` entry point
  - Instantiate `ElementalInferenceClient` hardcoded to `us-west-2`
  - Call `CreateFeedCommand` with feed name `reframe-custom-{itemId}-{executionTimestamp}`, type `LIVE`, smart-crop output config `9:16` at `1080×1920`
  - Stream the init segment via `PutMediaCommand` with `FragmentType: 'INITIALIZATION'`, then each media segment in order with `FragmentType: 'MEDIA'` (reading each from S3 via `GetObjectCommand`)
  - After all segments are sent, loop over `scenes` and call `GetSmartCropMetadataCommand` per scene using `StartTimestampMillis` / `EndTimestampMillis` from Rekognition boundaries; collect `xyCoordinates` arrays
  - Always call `DeleteFeedCommand` in a `finally` block; log but do not throw on delete failure
  - On any EI API error, log a structured entry with `action: 'ei-multi-failure'` if multiple scenes fail simultaneously, then return `{ status: "error", errorMessage: "..." }`
  - On success return `{ status: "success", sceneCoordinates: [{ sceneIndex, startMs, endMs, xyCoordinates }] }`
  - Create `lambda/reframe-custom-ei-handler/package.json` with `@aws-sdk/client-s3` and the EI SDK as dependencies
  - _Requirements: Req 6, Req 14, Req 15_

- [x] 3. Create `reframe-custom-scene-analysis-handler` Lambda
  - Create `lambda/reframe-custom-scene-analysis-handler/index.js` with an `exports.handler` entry point
  - Download source video from S3 to `/tmp/source.mp4`; extract a single JPEG keyframe at the scene midpoint using `ffmpeg -ss {midpointSec} -i /tmp/source.mp4 -frames:v 1 -q:v 2 /tmp/keyframe_{sceneIndex}.jpg`
  - Upload the keyframe JPEG to `s3://{STAGING_BUCKET}/reframe-custom/{itemId}/{executionTimestamp}/keyframes/scene_{NNN}.jpg`
  - Call Bedrock `ConverseCommand` with model `us.amazon.nova-pro-v1:0`, passing the keyframe bytes as an inline image and the scene-description prompt (≤10 words, shot type + subject count + context); read `NOVA_MODEL_ID` from env
  - Implement `computeXYVariance(xyCoordinates)` using mean-squared Euclidean distance; implement `medianCoord(coords, axis)` for the representative centre point
  - Apply CROP/TILE decision logic: `TILE` if `xyVariance > varianceThreshold` OR Nova description contains a TILE keyword; `CROP` otherwise (including ambiguous cases)
  - Read `varianceThreshold` from the event payload (default `5000` from env `XY_VARIANCE_THRESHOLD`)
  - On keyframe extraction or Nova failure, default to `CROP`, log the failure reason, and return a valid response (do not throw)
  - Return `{ sceneIndex, startMs, endMs, decision, novaDescription, xyVariance, representativeX, representativeY, fallbackReason }`
  - Create `lambda/reframe-custom-scene-analysis-handler/package.json` with `@aws-sdk/client-s3` and `@aws-sdk/client-bedrock-runtime` as dependencies
  - _Requirements: Req 7, Req 15_

- [x] 4. Create `reframe-custom-mediaconvert-handler` Lambda
  - Create `lambda/reframe-custom-mediaconvert-handler/index.js` with an `exports.handler` entry point; dispatch on `event.action` (`"start"` or `"poll"`)
  - Implement `msToTimecode(ms)` helper converting milliseconds to `HH:MM:SS:FF` at 29.97 fps
  - For `action: "start"` with `decision: "CROP"`: build a MediaConvert job using `VideoSelector.Crop` with `X = max(0, representativeX - 540)`, `Y = max(0, representativeY - 960)`, `Width: 1080`, `Height: 1920`; set `ScalingBehavior: SMART_CROP`; apply `InputClippings` for the scene time range; add `MotionImageInserter` for the Lottie overlay with `Playback: REPEAT`; output to `s3://{outputBucket}/{itemId}/reframe-custom/scenes/scene_{NNN}`
  - For `action: "start"` with `decision: "TILE"`: build a MediaConvert job with the same CROP primary output (top 1080×1152) plus a `VideoOverlay` in `VideoPreprocessors` placing the original video at `YPosition: 1152`, `Width: 1080`, `Height: 768`, `ScalingBehavior: FIT`; both inputs use the same `InputClippings`
  - Both job types use H.264 QVBR quality 7, max 8 Mbps; AAC 128 kbps stereo 48 kHz; hardcode MediaConvert client to `us-west-2`
  - Submit the job via `CreateJobCommand` and return `{ jobId, status: "SUBMITTED", sceneIndex, expectedOutputUri }`
  - For `action: "poll"`: call `GetJobCommand` and return `{ jobId, status, sceneIndex, outputUri, errorMessage }`
  - Read `MEDIACONVERT_ROLE_ARN`, `OUTPUT_BUCKET`, and `MEDIACONVERT_REGION` from environment variables
  - Create `lambda/reframe-custom-mediaconvert-handler/package.json` with `@aws-sdk/client-mediaconvert` as a dependency
  - _Requirements: Req 9, Req 14, Req 15_

- [x] 5. Create `reframe-custom-stitch-handler` Lambda
  - Create `lambda/reframe-custom-stitch-handler/index.js` with an `exports.handler` entry point; dispatch on `event.action` (`"start"` or `"poll"`)
  - For `action: "start"`: build a MediaConvert job with `Inputs` array containing one entry per URI in `sceneOutputUris` (in order), each with `TimecodeSource: ZEROBASED` and default audio/video selectors; no `InputClippings` needed
  - Output to `s3://{outputBucket}/{itemId}/reframe-custom/final/{baseFilename}_9-16` using H.264 QVBR quality 7, max 8 Mbps; AAC 128 kbps stereo 48 kHz; 1080×1920; hardcode MediaConvert client to `us-west-2`
  - Submit via `CreateJobCommand` and return `{ jobId, status: "SUBMITTED", expectedOutputUri }`
  - For `action: "poll"`: call `GetJobCommand` and return `{ jobId, status, outputUri, errorMessage }`
  - Read `MEDIACONVERT_ROLE_ARN`, `OUTPUT_BUCKET`, and `MEDIACONVERT_REGION` from environment variables
  - Create `lambda/reframe-custom-stitch-handler/package.json` with `@aws-sdk/client-mediaconvert` as a dependency
  - _Requirements: Req 10, Req 14, Req 15_

- [x] 6. Update `mimir-handler` to add `reframe-custom` case
  - Open `lambda/mimir-handler/index.js` and locate the `switch (actionType)` statement
  - Add a new `case 'reframe-custom':` block that reads `stateMachineArn` from `process.env.REFRAME_CUSTOM_STATE_MACHINE_ARN`; filters `items` to video items only; returns HTTP 200 with `status: "success"` and a no-video message if the filtered list is empty
  - For each video item, build `execInput` with `itemId`, `storyId`, `itemDetails`, `baseFilename` (filename without extension), `title`, `description`, `transcript: ''`, `lottieTemplates`, `aspectRatios: ['9:16']`, `varianceThreshold: 5000`, `executionTimestamp: Date.now()`, `mimirApiKey`, `userToken`, `userId`, `userEmail`
  - Start one `StartExecutionCommand` per item with `name: reframe-custom-{item.id}-{Date.now()}`; collect `{ itemId, executionArn }` results
  - Return HTTP 200 with `status: "success"`, `executions` array, and `actionType`
  - Log `{ action: 'started-reframe-custom', itemId, executionArn }` for each started execution
  - Do not modify any existing `case` blocks or shared handler logic
  - _Requirements: Req 1, Req 2_

- [x] 7. Add CDK infrastructure for the `reframe-custom` pipeline
  - Open `lib/infrastructure-stack.ts` and add a clearly delimited `// Reframe Custom pipeline` section after the existing `reframe-with-graphics` section
  - Declare all five new Lambda functions using `lambda.Code.fromAsset()` with explicit `functionName` values, runtime `NODEJS_24_X`, timeouts, memory sizes, ephemeral storage, and environment variables as specified in design section 4.1
  - Add `REFRAME_CUSTOM_STATE_MACHINE_ARN` to the existing `mimirHandler` Lambda's environment and call `reframeCustomStateMachine.grantStartExecution(mimirHandler)`
  - Define the `ReframeCustom` Step Functions state machine using the CDK fluent API (`DefinitionBody.fromChainable()`), implementing all states from design section 2.1: GetMimirDetails → ClassifyCategory → StartRekognition → Rekognition poll loop → PrepareSceneList → ParallelCMAFAndOverlay → CheckCMAFResult → EI steps → AnalyseScenes Map → EncodeScenes Map (with per-scene poll loop) → StitchScenes poll loop → UploadToMimir; include all fallback paths, `EmitFallbackMetric` states, and `addCatch` blocks per design sections 2.3 and 7.1
  - Enable X-Ray tracing and CloudWatch logging at `ALL` level to `/aws/states/ReframeCustom` with 30-day retention
  - Apply all IAM grants per design section 4.3: bucket grants, EI actions, Bedrock `InvokeModel`, MediaConvert `CreateJob`/`GetJob`, `iam:PassRole`, Rekognition, CloudWatch `PutMetricData`, and `states:StartExecution` on the existing `ReframeWithGraphics` state machine
  - Add the `POST /actions/reframe-custom` route to the existing `actionsResource` API Gateway resource backed by `mimirHandler`
  - Store the state machine ARN in SSM at `/fonn-custom-actions/reframe-custom/state-machine-arn` using `ssm.StringParameter`
  - Run `npm run build` and fix any TypeScript compilation errors before proceeding
  - _Requirements: Req 1, Req 13, Req 14, Req 15_

- [ ] 8. Local testing of each Lambda in isolation
  - Create `scripts/test-reframe-custom-cmaf.js`: invoke `reframe-custom-cmaf-handler` locally with a real S3 video URI and verify the response contains `status: "success"`, a non-empty `segmentKeys` array, and that the CMAF segments exist in the staging bucket; also test the failure path by pointing to a non-existent key and verify cleanup
  - Create `scripts/test-reframe-custom-ei.js`: invoke `reframe-custom-ei-handler` locally with the CMAF output from the previous test and a single-scene input; verify `status: "success"` and that `sceneCoordinates[0].xyCoordinates` is non-empty
  - Create `scripts/test-reframe-custom-scene-analysis.js`: invoke `reframe-custom-scene-analysis-handler` locally with a real source video URI and sample `xyCoordinates`; verify the response contains a valid `decision` (`CROP` or `TILE`), a non-empty `novaDescription`, and a numeric `xyVariance`
  - Create `scripts/test-reframe-custom-mediaconvert.js`: invoke `reframe-custom-mediaconvert-handler` with `action: "start"` for both `CROP` and `TILE` decisions; verify `status: "SUBMITTED"` and a valid `jobId`; then poll until `COMPLETE` and verify the output file exists in S3
  - Create `scripts/test-reframe-custom-stitch.js`: invoke `reframe-custom-stitch-handler` with `action: "start"` using two scene output URIs from the previous test; verify `status: "SUBMITTED"`; poll until `COMPLETE` and verify the final stitched file exists in S3
  - _Requirements: Req 5, Req 6, Req 7, Req 9, Req 10_

- [ ] 9. Deploy and end-to-end test via Mimir
  - Run `npm run build` then `npx cdk deploy FonnGroupCustomActionsStack --require-approval never` to deploy all new resources
  - Verify in the AWS Console that all five new Lambda functions exist with correct names, runtimes, memory, and environment variables; verify the `ReframeCustom` state machine exists with X-Ray tracing and CloudWatch logging enabled; verify the SSM parameter `/fonn-custom-actions/reframe-custom/state-machine-arn` is populated
  - Create `scripts/test-reframe-custom-e2e.js`: send a `POST /actions/reframe-custom` request with a valid `X-API-Key` header and a payload containing one video item; assert HTTP 200 and `status: "success"` with an `executions` array
  - Monitor the Step Functions execution until it reaches `ExecutionSucceeded`; verify the final stitched MP4 exists in the output bucket under `{itemId}/reframe-custom/final/`; verify a new Mimir item titled `{originalTitle} - 9:16 (Custom)` was created with a `related` relation to the original item
  - Test the fallback path: trigger a CMAF failure and verify the execution falls back to `ReframeWithGraphics` and the `ReframeCustomFallbackCount` CloudWatch metric increments
  - Test the no-video-items path: send a request with only non-video items and verify HTTP 200 with the no-video message
  - Test the invalid API key path: send a request without `X-API-Key` and verify HTTP 401
  - _Requirements: Req 1, Req 2, Req 3, Req 4, Req 5, Req 6, Req 7, Req 8, Req 9, Req 10, Req 11, Req 12, Req 13, Req 15_
