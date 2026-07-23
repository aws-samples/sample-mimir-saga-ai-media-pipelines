# Requirements Document

## Introduction

This feature adds a transcript generation step to the RoughCutTimeline state machine so that video assets lacking Mimir-native transcripts (`hasTranscript: false`) get transcribed via Amazon Transcribe before the Rough Cut Agent is invoked. Without transcripts, the Source Material Agent cannot resolve in/out points for video clips, resulting in empty timelines. The transcript generation reuses the existing temp S3 staging bucket (`video-embedding-staging-{account}-{region}`) and follows the same video download pattern as the embedding pipeline. Generated transcripts are stored in S3 and their locations are passed to the agent so the Source Material Agent can access word-level timed transcript data.

## Glossary

- **Rough_Cut_State_Machine**: The existing Step Functions Standard state machine (`RoughCutTimeline`) that orchestrates story context gathering and agent invocation for rough cut timeline generation
- **Story_Context_Lambda**: The existing Lambda function (`story-context-handler`) that fetches story context from the Saga API and enriches assets with `hasTranscript` and `hasEmbeddings` flags
- **Staging_Bucket**: The existing S3 bucket (`video-embedding-staging-{account}-{region}`) used for temporary video file storage during the embedding pipeline, reused here for transcript generation
- **Transcript_Bucket_Prefix**: The S3 key prefix `transcripts/{itemId}/transcript.json` within the Staging_Bucket where generated transcript output is stored
- **Video_Bucket_Prefix**: The S3 key prefix `videos/{itemId}/` within the Staging_Bucket where proxy video files are staged
- **Mimir_API**: The Mimir REST API at `https://us.mjoll.no` used to retrieve item details including `proxyUrl` for video download, authenticated via `x-mimir-cognito-id-token: Bearer {apiKey}` header
- **Transcribe_Service**: The Amazon Transcribe service used to generate word-level timed transcripts from video files stored in S3
- **Transcribe_Handler_Lambda**: A new Lambda function that manages Amazon Transcribe jobs: starting transcription, polling for completion, and converting output to the agent-consumable format
- **Video_Download_Lambda**: The existing Lambda function (`video-to-s3-handler`) that downloads proxy video from Mimir to the Staging_Bucket, reused for transcript generation
- **Rough_Cut_Agent**: The existing multi-agent system on AgentCore Runtime that analyzes scripts, searches source material, and assembles timelines
- **Source_Material_Agent**: The sub-agent within the Rough_Cut_Agent that uses transcripts to resolve in/out points for video clips
- **Enriched_Asset**: An asset object returned by the Story_Context_Lambda containing `mimirItemId`, `hasTranscript`, `hasEmbeddings`, and other metadata fields

## Requirements

### Requirement 1: Identify Assets Needing Transcription

**User Story:** As the rough cut pipeline, I want to identify which video assets lack transcripts after story context gathering, so that only those assets are sent through the transcription step.

#### Acceptance Criteria

1. WHEN the Story_Context_Lambda returns the enriched asset list, THE Rough_Cut_State_Machine SHALL filter the list to identify video assets where `hasTranscript` is false
2. IF all video assets already have transcripts (`hasTranscript` is true for every video asset), THEN THE Rough_Cut_State_Machine SHALL skip the transcript generation step and proceed directly to agent invocation
3. THE Rough_Cut_State_Machine SHALL pass only the filtered list of transcript-lacking assets to the transcript generation Map state

### Requirement 2: Check for Existing Video in Staging Bucket

**User Story:** As the transcript generation step, I want to check if the video file already exists in the staging bucket before downloading, so that duplicate downloads are avoided when the embedding pipeline has already staged the file.

#### Acceptance Criteria

1. WHEN a video asset enters the transcript generation Map state, THE Transcribe_Handler_Lambda SHALL check the Staging_Bucket for existing video files under the `videos/{itemId}/` prefix
2. IF a video file exists under the `videos/{itemId}/` prefix in the Staging_Bucket, THEN THE Transcribe_Handler_Lambda SHALL return the S3 URI of the existing file and skip the download step
3. IF no video file exists under the `videos/{itemId}/` prefix in the Staging_Bucket, THEN THE Rough_Cut_State_Machine SHALL invoke the Video_Download_Lambda to download the proxy video from the Mimir_API to the Staging_Bucket

### Requirement 3: Download Proxy Video from Mimir

**User Story:** As the transcript generation step, I want to download the proxy video from Mimir to S3 when it is not already staged, so that Amazon Transcribe can access the video file.

#### Acceptance Criteria

1. WHEN the video file is not found in the Staging_Bucket, THE Rough_Cut_State_Machine SHALL invoke the Video_Download_Lambda with the `proxyUrl` and `itemId` from the Mimir_API item details
2. THE Video_Download_Lambda SHALL stream the proxy video to the Staging_Bucket under the key `videos/{itemId}/{timestamp}.mp4`
3. IF the video download fails with a non-2xx HTTP response, THEN THE Video_Download_Lambda SHALL return an error containing the HTTP status code

### Requirement 4: Start Amazon Transcribe Job

**User Story:** As the transcript generation step, I want to start an Amazon Transcribe job on the staged video file, so that a word-level timed transcript is generated.

#### Acceptance Criteria

1. WHEN a video file is available in the Staging_Bucket (either pre-existing or freshly downloaded), THE Transcribe_Handler_Lambda SHALL start an Amazon Transcribe job using the `StartTranscriptionJob` API with the S3 URI of the video file as the media source
2. THE Transcribe_Handler_Lambda SHALL configure the Transcribe job with `en-US` as the default language code, media format set to `mp4`, and output directed to the Staging_Bucket under the key prefix `transcripts/{itemId}/`
3. THE Transcribe_Handler_Lambda SHALL set the Transcribe job name to a unique value derived from the `itemId` and a timestamp to avoid name collisions
4. THE Transcribe_Handler_Lambda SHALL return the Transcribe job name so the state machine can poll for completion

### Requirement 5: Poll for Transcribe Job Completion

**User Story:** As the transcript generation step, I want to poll the Transcribe job status until it completes, so that the pipeline waits for the transcript before proceeding.

#### Acceptance Criteria

1. WHEN a Transcribe job has been started, THE Rough_Cut_State_Machine SHALL poll the job status by invoking the Transcribe_Handler_Lambda with the job name at regular intervals
2. THE Transcribe_Handler_Lambda SHALL call the `GetTranscriptionJob` API and return the current job status (`IN_PROGRESS`, `COMPLETED`, or `FAILED`)
3. WHILE the Transcribe job status is `IN_PROGRESS`, THE Rough_Cut_State_Machine SHALL wait 15 seconds between poll attempts
4. WHEN the Transcribe job status is `COMPLETED`, THE Rough_Cut_State_Machine SHALL proceed to the transcript conversion step
5. IF the Transcribe job status is `FAILED`, THEN THE Rough_Cut_State_Machine SHALL skip the failed asset and continue processing remaining assets without failing the entire pipeline

### Requirement 6: Convert Transcribe Output to Agent-Consumable Format

**User Story:** As the transcript generation step, I want to convert the Amazon Transcribe output into a word-level timed JSON format compatible with the Source Material Agent, so that the agent can resolve in/out points from the generated transcript.

#### Acceptance Criteria

1. WHEN a Transcribe job completes successfully, THE Transcribe_Handler_Lambda SHALL read the Transcribe output JSON from the Staging_Bucket
2. THE Transcribe_Handler_Lambda SHALL convert the Transcribe output into a word-level timed JSON array where each entry contains the word text, start time in seconds, and end time in seconds
3. THE Transcribe_Handler_Lambda SHALL save the converted transcript to the Staging_Bucket at the key `transcripts/{itemId}/transcript.json`
4. THE Transcribe_Handler_Lambda SHALL return the S3 URI of the saved transcript file

### Requirement 7: Parallel Asset Processing

**User Story:** As the rough cut pipeline, I want to process multiple assets needing transcription in parallel, so that the total transcription time is minimized.

#### Acceptance Criteria

1. THE Rough_Cut_State_Machine SHALL use a Map state to process all transcript-lacking assets concurrently
2. THE Map state SHALL limit concurrency to 5 parallel executions to avoid throttling from the Transcribe_Service
3. IF an individual asset fails during transcription (download failure, Transcribe failure, or conversion failure), THEN THE Map state SHALL continue processing remaining assets and record the failure for the failed asset
4. THE Map state SHALL collect the transcript S3 URIs for all successfully transcribed assets

### Requirement 8: Update Enriched Asset Data with Transcript Locations

**User Story:** As the rough cut pipeline, I want to merge the generated transcript locations back into the enriched asset data, so that the agent payload includes transcript S3 paths for all available transcripts.

#### Acceptance Criteria

1. WHEN the transcript generation Map state completes, THE Rough_Cut_State_Machine SHALL merge the transcript S3 URIs into the enriched asset list by matching on `mimirItemId`
2. EACH enriched asset that was successfully transcribed SHALL have a `generatedTranscriptS3Uri` field added containing the S3 URI of the transcript file
3. THE Rough_Cut_State_Machine SHALL pass the updated enriched asset list to the agent invocation step

### Requirement 9: Agent Access to Generated Transcripts

**User Story:** As the Source Material Agent, I want to read generated transcripts from S3 by item ID, so that I can resolve in/out points for video clips that lack Mimir-native transcripts.

#### Acceptance Criteria

1. THE Rough_Cut_Agent SHALL expose a `get_generated_transcript` tool that reads a transcript JSON file from the Staging_Bucket given an item ID
2. THE `get_generated_transcript` tool SHALL read the file at `transcripts/{itemId}/transcript.json` from the Staging_Bucket and return the word-level timed JSON content
3. WHEN the Source_Material_Agent encounters an asset with `hasTranscript` set to false and `generatedTranscriptS3Uri` present, THE Source_Material_Agent SHALL use the `get_generated_transcript` tool instead of the `get_transcript` tool
4. IF the transcript file does not exist at the expected S3 path, THEN THE `get_generated_transcript` tool SHALL return a descriptive error message

### Requirement 10: Transcribe Handler Lambda Infrastructure

**User Story:** As a system operator, I want the Transcribe Handler Lambda deployed with appropriate permissions and configuration, so that it can manage Transcribe jobs and access S3.

#### Acceptance Criteria

1. THE CDK stack SHALL deploy the Transcribe_Handler_Lambda as a Node.js 22.x Lambda function with a 60-second timeout and 256 MB memory
2. THE Transcribe_Handler_Lambda SHALL have IAM permissions to call `transcribe:StartTranscriptionJob`, `transcribe:GetTranscriptionJob`, and `transcribe:DeleteTranscriptionJob` on all Transcribe resources
3. THE Transcribe_Handler_Lambda SHALL have IAM permissions to read from and write to the Staging_Bucket
4. THE Transcribe_Handler_Lambda SHALL have IAM permissions to read the Mimir API key secret from Secrets Manager
5. THE Transcribe_Handler_Lambda SHALL receive the Staging_Bucket name and Mimir API key secret ARN as environment variables

### Requirement 11: State Machine Modifications

**User Story:** As a system operator, I want the RoughCutTimeline state machine updated to include the transcript generation step between story context gathering and agent invocation, so that transcripts are available before the agent runs.

#### Acceptance Criteria

1. THE Rough_Cut_State_Machine SHALL insert a transcript generation step between the `GatherStoryContext` state and the `InvokeRoughCutAgent` state
2. THE Rough_Cut_State_Machine SHALL include a Choice state after `GatherStoryContext` that evaluates whether any video assets need transcription
3. WHEN no assets need transcription, THE Rough_Cut_State_Machine SHALL transition directly from the Choice state to `InvokeRoughCutAgent`
4. THE Rough_Cut_State_Machine SHALL include retry configuration with exponential backoff (2-second interval, 3 max attempts, 2x backoff rate) for transient Lambda errors in the transcript generation step
5. IF the entire transcript generation Map state fails, THEN THE Rough_Cut_State_Machine SHALL proceed to `InvokeRoughCutAgent` with the original enriched asset data rather than failing the pipeline

### Requirement 12: IAM Permissions for Transcribe

**User Story:** As a system operator, I want all transcript generation components to have least-privilege IAM permissions, so that the pipeline operates securely.

#### Acceptance Criteria

1. THE Rough_Cut_State_Machine SHALL have permission to invoke the Transcribe_Handler_Lambda and the Video_Download_Lambda
2. THE Transcribe_Handler_Lambda SHALL have permission to pass the Staging_Bucket ARN to the Transcribe_Service via the `s3:GetObject` permission on the Staging_Bucket for the Transcribe service role
3. THE Rough_Cut_Agent execution role SHALL have permission to call `s3:GetObject` on the Staging_Bucket for reading generated transcripts
4. THE CDK stack SHALL create or reuse an IAM role for the Transcribe_Service that grants read access to the Staging_Bucket for media input
