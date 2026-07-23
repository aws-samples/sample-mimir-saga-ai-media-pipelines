# Implementation Plan: Transcript Generation

## Overview

Add a transcript generation step to the RoughCutTimeline state machine so video assets lacking Mimir-native transcripts are transcribed via Amazon Transcribe before the Rough Cut Agent runs. This involves a new `transcribe-handler` Lambda, state machine modifications (JSONata), a new agent tool, and CDK infrastructure updates.

## Tasks

- [x] 1. Create the transcribe-handler Lambda
  - [x] 1.1 Implement `check-video` action
    - Create `lambda/transcribe-handler/index.js` with the `check-video` action
    - Use `ListObjectsV2` with prefix `videos/{itemId}/` and `MaxKeys: 1` on the staging bucket (`VIDEO_STAGING_BUCKET` env var)
    - Return `{ exists: true, s3Uri }` when found, `{ exists: false }` when not
    - _Requirements: 2.1, 2.2_

  - [x] 1.2 Implement `start-transcribe` action
    - Add the `start-transcribe` action to the handler
    - Call `StartTranscriptionJob` with job name `transcript-{itemId}-{Date.now()}`, `LanguageCode: en-US`, `MediaFormat: mp4`, `Media.MediaFileUri` from input, `OutputBucketName` from env, `OutputKey: transcripts/{itemId}/raw-output.json`
    - Return `{ jobName, status: "IN_PROGRESS" }`
    - _Requirements: 4.1, 4.2, 4.3, 4.4_

  - [x] 1.3 Implement `poll-transcribe` action with transcript conversion
    - Add the `poll-transcribe` action to the handler
    - Call `GetTranscriptionJob` to get status
    - On `IN_PROGRESS`, return `{ status: "IN_PROGRESS" }`
    - On `FAILED`, return `{ status: "FAILED", error: "<reason>" }`
    - On `COMPLETED`: read raw output from `transcripts/{itemId}/raw-output.json`, convert to sentence/word format per design (sentences split on `.?!`, punctuation folded into preceding word, word-level timing preserved), write to `transcripts/{itemId}/transcript.json`, return `{ status: "COMPLETED", transcriptS3Uri }`
    - _Requirements: 5.2, 6.1, 6.2, 6.3, 6.4_

  - [ ]* 1.4 Write property test: Asset filtering (Property 1)
    - **Property 1: Asset filtering selects exactly the video assets lacking transcripts**
    - Use `fast-check` to generate random arrays of enriched assets with varying `hasTranscript` and `itemType`
    - Verify filtered output contains exactly video assets with `hasTranscript === false`
    - **Validates: Requirements 1.1, 1.3**

  - [ ]* 1.5 Write property test: Start-transcribe configuration (Property 3)
    - **Property 3: Start-transcribe produces correctly configured job**
    - Use `fast-check` to generate random item IDs and S3 URIs, mock `StartTranscriptionJob`
    - Verify job name contains item ID, language is `en-US`, format is `mp4`, output key prefix is correct
    - **Validates: Requirements 4.1, 4.2, 4.3, 4.4**

  - [ ]* 1.6 Write property test: Poll-transcribe status (Property 4)
    - **Property 4: Poll-transcribe returns a valid status**
    - Use `fast-check` to generate random job names, mock `GetTranscriptionJob` with random statuses
    - Verify response always has valid `status`, `COMPLETED` includes `transcriptS3Uri`, `FAILED` includes `error`
    - **Validates: Requirements 5.2**

  - [ ]* 1.7 Write property test: Transcript conversion (Property 5)
    - **Property 5: Transcribe output conversion produces correct sentence and word groupings**
    - Use `fast-check` to generate random Transcribe output JSON with pronunciation/punctuation items
    - Verify sentence boundaries at `.?!`, `startTime`/`endTime` match first/last word, punctuation folded, word count matches pronunciation count, `fullTranscript` matches input
    - **Validates: Requirements 6.1, 6.2, 6.3, 6.4**

- [x] 2. Checkpoint - Ensure transcribe-handler tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 3. Update the RoughCutTimeline state machine definition
  - [x] 3.1 Add NeedTranscription Choice state and TranscribeAssets Map state
    - Modify the `roughCutDefinition` JSON in `lib/infrastructure-stack.ts`
    - Change `GatherStoryContext.Next` from `InvokeRoughCutAgent` to `NeedTranscription`
    - Add `NeedTranscription` Choice state using JSONata: `{% $count($storyContext.assets[hasTranscript = false and itemType = 'video']) > 0 %}`
    - If true → `TranscribeAssets`; if false → `InvokeRoughCutAgent`
    - Add `TranscribeAssets` Map state (max concurrency 5) iterating over filtered assets
    - Inside Map: `CheckExistingVideo` → `VideoExistsChoice` → (`DownloadVideo` or skip) → `StartTranscribeJob` → `WaitForTranscribe` (15s) → `PollTranscribeStatus` → `TranscribeStatusChoice` (loop/complete/fail) → `TranscribeComplete` or `SkipFailedAsset`
    - Add retry config: 2s interval, 3 max attempts, 2x backoff for Lambda errors
    - Add Catch on Map state to fall through to `InvokeRoughCutAgent` with original data (graceful degradation)
    - _Requirements: 1.1, 1.2, 1.3, 5.1, 5.3, 5.4, 5.5, 7.1, 7.2, 7.3, 7.4, 11.1, 11.2, 11.3, 11.4, 11.5_

  - [x] 3.2 Add MergeTranscriptResults Pass state
    - Add `MergeTranscriptResults` Pass state after the Map state
    - Use JSONata to merge `transcriptS3Uri` from Map results back into `$storyContext.assets` by matching `mimirItemId`
    - Assign updated assets to `$storyContext` and transition to `InvokeRoughCutAgent`
    - _Requirements: 8.1, 8.2, 8.3_

  - [ ]* 3.3 Write property test: Merge logic (Property 6)
    - **Property 6: Merge correctly adds transcript URIs to matching assets**
    - Use `fast-check` to generate random asset lists and transcribe result lists
    - Verify output length equals input, matched completed results add `generatedTranscriptS3Uri`, unmatched/failed don't, all original fields preserved
    - **Validates: Requirements 8.1, 8.2**

- [x] 4. Add CDK infrastructure for transcribe-handler
  - [x] 4.1 Add transcribe-handler Lambda and IAM permissions in CDK
    - Add `transcribeHandler` Lambda in `lib/infrastructure-stack.ts`: Node.js 22.x, 60s timeout, 256 MB, env vars `VIDEO_STAGING_BUCKET` and `MIMIR_API_KEY_SECRET_ARN`
    - Grant `videoStagingBucket.grantReadWrite(transcribeHandler)`
    - Add Transcribe IAM permissions: `transcribe:StartTranscriptionJob`, `transcribe:GetTranscriptionJob`, `transcribe:DeleteTranscriptionJob`
    - Grant `mimirApiKeySecret.grantRead(transcribeHandler)`
    - Grant `transcribeHandler.grantInvoke(roughCutStateMachine)` and `videoToS3Handler.grantInvoke(roughCutStateMachine)`
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 12.1_

  - [x] 4.2 Add Transcribe service role and agent S3 permissions
    - Create `transcribeServiceRole` IAM role assumed by `transcribe.amazonaws.com`
    - Grant read/write on `videoStagingBucket` to the service role
    - Grant `videoStagingBucket.grantRead` to the agent execution role for `get_generated_transcript`
    - Add `TRANSCRIPT_STAGING_BUCKET` env var to the agent configuration
    - _Requirements: 12.2, 12.3, 12.4_

- [x] 5. Checkpoint - Ensure CDK synth succeeds
  - Ensure all tests pass, ask the user if questions arise.

- [x] 6. Add `get_generated_transcript` agent tool
  - [x] 6.1 Implement `get_generated_transcript` tool in `agents/rough-cut-agent/tools.py`
    - Add `@tool` function `get_generated_transcript(mimir_item_id: str) -> str`
    - Read `TRANSCRIPT_STAGING_BUCKET` env var
    - Construct key `transcripts/{mimir_item_id}/transcript.json`
    - Call `s3.get_object` and return JSON content as string
    - On `NoSuchKey`, return `{"error": "No generated transcript found for item {mimir_item_id}"}`
    - _Requirements: 9.1, 9.2, 9.4_

  - [x] 6.2 Register tool with Source Material Agent in `agents/rough-cut-agent/rough_cut_agent.py`
    - Import `get_generated_transcript` from `tools`
    - Add it to the `tools` list in `run_source_material` alongside `get_transcript`, `query_embeddings`, `get_mimir_item_details`
    - _Requirements: 9.3_

  - [ ]* 6.3 Write property test: get_generated_transcript S3 path (Property 7)
    - **Property 7: get_generated_transcript reads from correct S3 path**
    - Use `hypothesis` to generate random alphanumeric item IDs
    - Mock S3 `get_object` — verify reads from `transcripts/{itemId}/transcript.json`, returns content on success, returns error JSON on `NoSuchKey`
    - **Validates: Requirements 9.1, 9.2, 9.4**

- [x] 7. Update Source Material Agent prompt
  - [x] 7.1 Update `SOURCE_MATERIAL_PROMPT` in `agents/rough-cut-agent/prompts.py`
    - Add instructions for the agent to use `get_generated_transcript` when an asset has `hasTranscript: false` and `generatedTranscriptS3Uri` is present
    - Add `get_generated_transcript` to the tool usage documentation in the prompt
    - _Requirements: 9.3_

- [x] 8. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- The design uses JavaScript (Node.js 22.x) for the Lambda, Python (Strands SDK) for the agent tool, and TypeScript for CDK
- The state machine uses JSONata query language, matching the existing `RoughCutTimeline` pattern
- The existing `video-to-s3-handler` Lambda is reused as-is for video downloads
- Property tests use `fast-check` for JavaScript and `hypothesis` for Python
- Graceful degradation: if the entire transcript Map state fails, the pipeline proceeds with original data
