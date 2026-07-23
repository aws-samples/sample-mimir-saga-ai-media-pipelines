# Requirements Document

## Introduction

The `reframe-custom` action is a new Mimir custom action that extends the existing `reframe-with-graphics` pipeline with per-scene intelligence. Rather than applying a uniform smart crop to the entire video, the pipeline analyses each scene individually and decides whether to apply a straight smart crop (CROP) or a stacked tiled layout (TILE) that places the reframed crop on the top portion of the frame and a full-width scaled-down version of the original below it.

The pipeline is implemented as an AWS CDK TypeScript stack with Node.js Lambda functions and an AWS Step Functions state machine. It reuses existing Lambda handlers (`mimir-details-handler`, `classify-category-handler`, `graphics-overlay-handler`) and adds new Lambda handlers for scene analysis, per-scene MediaConvert job construction, and video stitching. The new action is exposed at `POST /actions/reframe-custom` and must not modify the existing `reframe-with-graphics` pipeline.

---

## Glossary

- **Pipeline**: The `reframe-custom` AWS Step Functions state machine and all supporting Lambda functions.
- **Mimir**: The media asset management system that triggers the action and receives the final output.
- **Item**: A Mimir video asset identified by a unique `itemId`.
- **Scene**: A contiguous video segment whose boundaries are detected by Amazon Rekognition `StartSegmentDetection`.
- **CMAF**: Common Media Application Format — fragmented MP4 with 1-second segments, H.264 video and AAC audio, required by Elemental Inference.
- **Elemental_Inference (EI)**: AWS Elemental Inference service, available only in `us-west-2`, used to produce per-frame XY centre-point coordinates for smart crop.
- **EI_Feed**: An Elemental Inference feed created to receive CMAF segments and produce smart-crop metadata.
- **XY_Variance**: The statistical variance of the XY centre-point coordinates returned by Elemental Inference across all frames within a scene, used as a measure of subject motion.
- **CROP**: A per-scene output mode in which the scene is smart-cropped to the target aspect ratio using EI XY coordinates.
- **TILE**: A per-scene output mode in which the top ~60 % of the output frame contains the smart-cropped reframed video and the bottom ~40 % contains the original video scaled to full width with letterboxing.
- **Scene_Analysis_Lambda**: The new Lambda function that, for each Rekognition scene segment, extracts a keyframe, calls Bedrock Nova for a scene description, computes XY variance, and returns a CROP/TILE decision.
- **Stitch_Lambda**: The new Lambda function that concatenates all per-scene MediaConvert outputs into a single final video using MediaConvert input stitching.
- **Nova**: Amazon Bedrock Nova Pro model (`us.amazon.nova-pro-v1:0`), used for scene description.
- **Rekognition**: Amazon Rekognition, used for shot-boundary / scene-cut detection via `StartSegmentDetection`.
- **MediaConvert**: AWS Elemental MediaConvert, used for per-scene encoding (CROP and TILE modes) and final stitching.
- **Lottie_Overlay**: The QuickTime MOV graphics overlay produced by the existing `graphics-overlay-handler`.
- **Output_Bucket**: The existing S3 bucket `reframed-videos-{account}-{region}` used for all intermediate and final outputs.
- **Staging_Bucket**: The existing S3 bucket `video-embedding-staging-{account}-{region}` used for temporary CMAF segments and keyframes.

---

## Requirements

### Requirement 1: API Endpoint

**User Story:** As a Mimir operator, I want to trigger the reframe-custom action via a dedicated API endpoint, so that it runs independently of the existing reframe-with-graphics pipeline.

#### Acceptance Criteria

1. THE Pipeline SHALL expose a `POST /actions/reframe-custom` endpoint on the existing API Gateway, adding only the minimal route table entries required to support the new endpoint.
2. WHEN a `POST /actions/reframe-custom` request is received with a valid `X-API-Key` header, THE Pipeline SHALL accept the request and return HTTP 200 with a JSON body containing `status: "success"` and the Step Functions `executionArn`.
3. IF a `POST /actions/reframe-custom` request is received with an invalid or missing `X-API-Key` header, THEN THE Pipeline SHALL return HTTP 401.
4. WHEN a `POST /actions/reframe-custom` request is received and the `items` array contains no video items, THE Pipeline SHALL return HTTP 200 with `status: "success"` and a message indicating no video items were found.
5. THE Pipeline SHALL start one Step Functions execution per video item in the `items` array.
6. THE Pipeline SHALL NOT modify any existing Lambda functions, state machines, or API Gateway routes belonging to the `reframe-with-graphics` action.
7. IF a `POST /actions/reframe-custom` request is received with valid video items present and processing encounters an error, THEN THE Pipeline SHALL return HTTP 200 with `status: "failure"` and an error message indicating the failure reason.

---

### Requirement 2: Mimir Item Details Retrieval

**User Story:** As a pipeline operator, I want the pipeline to fetch full Mimir item details at the start of each execution, so that downstream steps have access to video URLs, metadata, and transcript information.

#### Acceptance Criteria

1. WHEN a Step Functions execution starts, THE Pipeline SHALL invoke the existing `mimir-details-handler` Lambda to retrieve item details for the target `itemId`.
2. THE Pipeline SHALL pass the `mimirApiKey` from Secrets Manager to `mimir-details-handler` for authentication.
3. IF `mimir-details-handler` explicitly returns an error, THEN THE Pipeline SHALL immediately transition to a terminal failure state and record the error reason.

---

### Requirement 3: Category Classification and Text Generation

**User Story:** As a broadcast producer, I want the pipeline to classify the video category and generate overlay text, so that the Lottie graphics overlay reflects the correct category and headline.

#### Acceptance Criteria

1. WHEN Mimir item details have been retrieved, THE Pipeline SHALL invoke the existing `classify-category-handler` Lambda with the item `title`, `description`, and `timedTranscriptUrl`.
2. THE `classify-category-handler` SHALL return a `category`, `line1`, `line2`, `line3`, `headline`, and `location` for use in the Lottie overlay.
3. IF `classify-category-handler` returns an error or times out, THEN THE Pipeline SHALL transition to a terminal failure state and record the error reason.

---

### Requirement 4: Scene Detection via Amazon Rekognition

**User Story:** As a pipeline operator, I want the pipeline to detect scene cuts in the source video, so that per-scene analysis and encoding decisions can be made.

#### Acceptance Criteria

1. WHEN item details have been retrieved, THE Pipeline SHALL call Amazon Rekognition `StartSegmentDetection` on the source video S3 URI with segment type `SHOT`.
2. THE Pipeline SHALL poll Rekognition `GetSegmentDetection` until the job status is `SUCCEEDED` or `FAILED`, continuing to poll while the status is `IN_PROGRESS`.
3. WHEN Rekognition returns `SUCCEEDED`, THE Pipeline SHALL extract the list of shot segments, each with a `StartTimestampMillis` and `EndTimestampMillis`; IF segment extraction fails after receiving `SUCCEEDED` status, THEN THE Pipeline SHALL transition to a terminal failure state.
4. IF Rekognition returns `FAILED` or the polling timeout of 10 minutes is exceeded, THEN THE Pipeline SHALL fall back to treating the entire video as a single scene and continue processing.
5. THE Pipeline SHALL pass the scene segment list to all downstream steps that require scene boundaries.

---

### Requirement 5: CMAF Conversion for Elemental Inference

**User Story:** As a pipeline operator, I want the source video converted to CMAF format before sending it to Elemental Inference, so that EI can process the video and return smart-crop metadata.

#### Acceptance Criteria

1. WHEN scene detection is complete, THE Pipeline SHALL invoke a Lambda that uses FFmpeg to convert the source video to CMAF format.
2. THE CMAF output SHALL use fragmented MP4 container, 1-second segment duration, H.264 video codec, and AAC audio codec.
3. WHEN FFmpeg conversion succeeds, THE Pipeline SHALL write CMAF segments immediately to the Staging_Bucket under a key prefix scoped to the `itemId` and execution timestamp, with no separate trigger required.
4. IF FFmpeg conversion fails, THEN THE Pipeline SHALL atomically skip writing any partial CMAF segments, clean up any partial output from the Staging_Bucket, and trigger the fallback to the existing `reframe-with-graphics` behaviour for the entire video.
5. THE Pipeline SHALL record the S3 location of the CMAF segments for use in subsequent EI steps.

---

### Requirement 6: Elemental Inference Feed Management

**User Story:** As a pipeline operator, I want the pipeline to create, use, and clean up an Elemental Inference feed, so that smart-crop XY coordinates are obtained for each frame of the video.

#### Acceptance Criteria

1. WHEN CMAF conversion is complete, THE Pipeline SHALL create an EI feed in the `us-west-2` region with a smart-crop output configuration targeting the 9:16 aspect ratio.
2. THE Pipeline SHALL stream all CMAF segments to the EI feed via the `PutMedia` API in segment order.
3. WHEN all segments have been sent, THE Pipeline SHALL query EI metadata for each scene's time range using the Rekognition scene boundaries as query windows, retrieving per-frame XY centre-point coordinates.
4. WHEN EI metadata retrieval is complete, THE Pipeline SHALL delete the EI feed to release resources.
5. IF EI feed creation fails, THEN THE Pipeline SHALL immediately trigger the fallback to the existing `reframe-with-graphics` behaviour for the entire video without attempting to use the failed feed; IF `PutMedia` or metadata query fails, THEN THE Pipeline SHALL also trigger the same fallback; IF any scene's retrieved EI coordinate data is absent or unusable, THEN THE Pipeline SHALL trigger the fallback for the entire video; IF multiple EI failures occur simultaneously, THE Pipeline SHALL emit an enhanced structured log entry recording all concurrent failure details before triggering the fallback.
6. THE Pipeline SHALL store the per-scene EI XY coordinate arrays in the Step Functions execution state for use by the Scene_Analysis_Lambda.

---

### Requirement 7: Per-Scene Analysis and CROP/TILE Decision

**User Story:** As a broadcast producer, I want each scene to be individually analysed so that the pipeline can choose the most visually appropriate layout — smart crop or tiled — for that scene.

#### Acceptance Criteria

1. WHEN EI metadata has been retrieved for all scenes, THE Pipeline SHALL invoke the Scene_Analysis_Lambda once per scene in parallel (up to 5 concurrent invocations).
2. FOR each scene, THE Scene_Analysis_Lambda SHALL extract a keyframe at the scene midpoint using FFmpeg from the source video.
3. THE Scene_Analysis_Lambda SHALL send the keyframe image to Bedrock Nova Pro (`us.amazon.nova-pro-v1:0`) with a prompt requesting a scene description (e.g. "wide establishing shot", "close-up interview", "multiple subjects").
4. THE Scene_Analysis_Lambda SHALL compute the XY_Variance of the EI centre-point coordinates for that scene.
5. WHEN XY_Variance exceeds the configured variance threshold OR Nova describes the scene as containing "wide shot", "establishing shot", or "multiple subjects", THE Scene_Analysis_Lambda SHALL assign the decision `TILE` to that scene.
6. WHEN XY_Variance is at or below the configured variance threshold AND Nova describes the scene as "close-up", "interview", or "single subject", THE Scene_Analysis_Lambda SHALL assign the decision `CROP` to that scene.
7. THE Scene_Analysis_Lambda SHALL return the scene decision (`CROP` or `TILE`), the EI XY coordinates for that scene, the Nova scene description, and the computed XY_Variance.
8. IF keyframe extraction or Nova invocation fails for a scene, THEN THE Scene_Analysis_Lambda SHALL default to `CROP` for that scene and log the failure reason.

---

### Requirement 8: Lottie Graphics Overlay Rendering

**User Story:** As a broadcast producer, I want the Lottie graphics overlay rendered for the full output frame, so that the final video carries the correct category branding and headline text.

#### Acceptance Criteria

1. WHEN per-scene analysis is complete, THE Pipeline SHALL invoke the existing `graphics-overlay-handler` Lambda with the classification output (`category`, `line1`, `line2`, `line3`, `headline`, `location`) and the 9:16 aspect ratio.
2. THE `graphics-overlay-handler` SHALL produce a QuickTime MOV (qtrle + argb) overlay at 1080×1920 resolution and upload it to the Output_Bucket.
3. WHEN `graphics-overlay-handler` succeeds, THE Pipeline SHALL pass the overlay S3 URI to the per-scene MediaConvert job construction step.
4. IF `graphics-overlay-handler` returns an error, THEN THE Pipeline SHALL transition to a terminal failure state and record the error reason.

---

### Requirement 9: Per-Scene MediaConvert Job Construction and Execution

**User Story:** As a pipeline operator, I want a MediaConvert job created for each scene based on its CROP or TILE decision, so that each scene is encoded with the appropriate layout.

#### Acceptance Criteria

1. WHEN per-scene decisions and the Lottie overlay URI are available, THE Pipeline SHALL create one MediaConvert job per scene.
2. FOR scenes with decision `CROP`, THE Pipeline SHALL configure the MediaConvert job to apply smart crop using the EI XY coordinates for that scene, producing a 1080×1920 output.
3. FOR scenes with decision `TILE`, THE Pipeline SHALL configure the MediaConvert job to produce a 1080×1920 stacked composite: the top 60 % of the frame (approximately 1152 pixels) SHALL contain the smart-cropped reframed video using EI XY coordinates, and the bottom 40 % (approximately 768 pixels) SHALL contain the original video scaled to full width (1080 pixels wide) with letterboxing to fill the remaining height.
4. THE Pipeline SHALL apply the Lottie_Overlay to the full 1080×1920 output frame for all scenes using MediaConvert `MotionImageInserter` with `Playback: REPEAT`.
5. THE Pipeline SHALL use H.264 video codec with QVBR rate control at quality level 7 and a maximum bitrate of 8 Mbps for all per-scene outputs.
6. THE Pipeline SHALL use AAC audio at 128 kbps, stereo, 48 kHz for all per-scene outputs.
7. THE Pipeline SHALL poll each MediaConvert job until its status is `COMPLETE` or `ERROR`, with a 30-second wait between polls.
8. IF a per-scene MediaConvert job returns `ERROR`, THEN THE Pipeline SHALL log the error and substitute the corresponding scene with the output of a fallback CROP job using the full-video smart-crop approach from `reframe-with-graphics`.
9. THE Pipeline SHALL write per-scene outputs to the Output_Bucket under the key prefix `{itemId}/reframe-custom/scenes/`.

---

### Requirement 10: Video Stitching

**User Story:** As a pipeline operator, I want all per-scene outputs concatenated into a single final video, so that the Mimir item receives one complete reframed video.

#### Acceptance Criteria

1. WHEN all per-scene MediaConvert jobs are complete, THE Pipeline SHALL invoke the Stitch_Lambda to concatenate the per-scene outputs in scene order.
2. THE Stitch_Lambda SHALL use MediaConvert input stitching (multiple `FileInput` entries in a single job) to produce a single MP4 output.
3. THE stitched output SHALL be written to the Output_Bucket under the key `{itemId}/reframe-custom/final/{baseFilename}_9-16.mp4`.
4. THE stitched output SHALL use H.264 video codec with QVBR rate control at quality level 7 and a maximum bitrate of 8 Mbps.
5. THE stitched output SHALL use AAC audio at 128 kbps, stereo, 48 kHz.
6. IF the stitching MediaConvert job returns `ERROR` status, THEN THE Pipeline SHALL transition to a terminal failure state and record the error reason; THE Pipeline SHALL attempt to record the error reason before transitioning, and IF error recording fails, THEN THE Pipeline SHALL attempt fallback logging (e.g. CloudWatch) before transitioning; IF all error recording attempts fail, THE Pipeline SHALL still transition to a terminal failure state.

---

### Requirement 11: Upload to Mimir

**User Story:** As a Mimir operator, I want the final stitched video uploaded to Mimir as a new item related to the original, so that the reframed video is accessible in the Mimir library.

#### Acceptance Criteria

1. WHEN the stitched video is available in S3, THE Pipeline SHALL create a new Mimir video item with the title `{originalTitle} - 9:16 (Custom)`.
2. THE Pipeline SHALL upload the stitched MP4 from S3 to the new Mimir item using the Mimir upload lock and signed URL flow.
3. THE Pipeline SHALL create a `related` relation between the new Mimir item and the original `itemId`.
4. IF `storyId` is present in the execution input, THEN THE Pipeline SHALL add the new item to that story; IF `storyId` is absent from the execution input, THEN the new item SHALL remain unassociated with no story.
5. THE Pipeline SHALL copy the metadata `formData` from the original item to the new item, updating the `default_title` field to match the new item title.
6. IF any Mimir API call in this step fails, THEN THE Pipeline SHALL transition to a terminal failure state and record the failure reason, regardless of whether the stitched video remains recoverable in S3.

---

### Requirement 12: Fallback Behaviour

**User Story:** As a pipeline operator, I want the pipeline to fall back gracefully to the existing reframe-with-graphics behaviour when critical upstream steps fail, so that the user always receives a reframed output.

#### Acceptance Criteria

1. IF Rekognition scene detection fails (Requirement 4, criterion 4), THEN THE Pipeline SHALL treat the entire video as a single scene with decision `CROP` and continue with EI-based processing.
2. IF CMAF conversion fails (Requirement 5, criterion 4) OR EI feed operations fail (Requirement 6, criterion 5), THEN THE Pipeline SHALL invoke the existing `ReframeWithGraphics` state machine for the item and return its result as the pipeline output.
3. WHEN the fallback to `ReframeWithGraphics` is triggered, THE Pipeline SHALL record a `fallbackReason` field in the Step Functions execution output.
4. THE Pipeline SHALL NOT invoke the fallback path for per-scene MediaConvert job errors after per-scene MediaConvert jobs have started; those individual scene failures SHALL be handled per Requirement 9, criterion 8; IF a non-scene infrastructure or network failure occurs after per-scene MediaConvert jobs have started, THEN THE Pipeline MAY invoke the fallback path for the entire video.

---

### Requirement 13: Infrastructure and Deployment

**User Story:** As a CDK developer, I want the reframe-custom pipeline deployed as a self-contained CDK construct within the existing `InfrastructureStack`, so that it can be deployed and updated independently without affecting other actions.

#### Acceptance Criteria

1. THE Pipeline SHALL be defined as a new CDK construct or a clearly delimited section within `InfrastructureStack` that does not modify existing resource definitions.
2. THE Pipeline SHALL reuse the existing `outputBucket`, `videoStagingBucket`, `mimirApiKeySecret`, `apiKeySecret`, `mimirDetailsHandler`, `classifyCategoryHandler`, and `graphicsOverlayHandler` resources by reference.
3. THE Pipeline SHALL create a new Step Functions state machine named `ReframeCustom`.
4. THE Pipeline SHALL create new Lambda functions for: CMAF conversion (`reframe-custom-cmaf-handler`), EI feed management (`reframe-custom-ei-handler`), scene analysis (`reframe-custom-scene-analysis-handler`), per-scene MediaConvert job management (`reframe-custom-mediaconvert-handler`), and video stitching (`reframe-custom-stitch-handler`).
5. ALL new Lambda functions SHALL use `lambda.Runtime.NODEJS_22_X` and be declared using `lambda.Code.fromAsset()` referencing directories under `lambda/`.
6. ALL new Lambda functions SHALL have explicit `functionName` values following the pattern `reframe-custom-{purpose}`.
7. THE Pipeline SHALL grant each Lambda function only the IAM permissions required for its specific operations, following the principle of least privilege.
8. THE Pipeline SHALL store the `ReframeCustom` state machine ARN in SSM Parameter Store at `/fonn-custom-actions/reframe-custom/state-machine-arn`.
9. ALL MediaConvert operations in the new Lambda functions SHALL target the `us-west-2` region.
10. ALL Elemental Inference operations SHALL target the `us-west-2` region.

---

### Requirement 14: Region Constraint for Elemental Inference and MediaConvert

**User Story:** As a platform engineer, I want all Elemental Inference and MediaConvert operations constrained to `us-west-2`, so that smart-crop features remain available.

#### Acceptance Criteria

1. THE `reframe-custom-ei-handler` Lambda SHALL create and manage EI feeds exclusively in the `us-west-2` region.
2. THE `reframe-custom-cmaf-handler` Lambda SHALL write CMAF segments to an S3 bucket accessible from `us-west-2`.
3. THE `reframe-custom-mediaconvert-handler` Lambda SHALL submit all MediaConvert jobs to the `us-west-2` region endpoint.
4. THE `reframe-custom-stitch-handler` Lambda SHALL submit the stitching MediaConvert job to the `us-west-2` region endpoint.
5. THE Pipeline SHALL handle cross-region routing to `us-west-2` internally for all EI and MediaConvert API calls, functioning correctly regardless of the deployment region, cross-region routing configuration, or failure type encountered during routing.

---

### Requirement 15: Observability and Error Handling

**User Story:** As a platform engineer, I want all pipeline steps to emit structured logs and the state machine to have X-Ray tracing enabled, so that failures can be diagnosed quickly.

#### Acceptance Criteria

1. THE `ReframeCustom` state machine SHALL have X-Ray tracing enabled.
2. THE `ReframeCustom` state machine SHALL write execution logs at `ALL` level to a dedicated CloudWatch Log Group with a 30-day retention period.
3. ALL new Lambda functions SHALL log structured JSON including `itemId`, `action`, and any error details at each major processing step.
4. IF a Lambda function throws an unhandled exception, THEN THE Pipeline SHALL catch it via a Step Functions `Catch` block, log the error, and transition to an appropriate failure or fallback state.
5. THE Pipeline SHALL emit a CloudWatch metric `ReframeCustomFallbackCount` (namespace `FonnCustomActions`) whenever the fallback path is triggered.
