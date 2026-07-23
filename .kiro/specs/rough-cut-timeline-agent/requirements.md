# Requirements Document

## Introduction

This feature adds an agentic rough cut timeline generation pipeline to the Fonn Group Custom Actions project. When a Saga custom action is triggered on a story, a Step Functions workflow gathers story context from the Saga API (story details, assets, instances, notes), evaluates which video assets have embeddings and transcripts available, and then invokes an AgentCore Runtime multi-agent system (built with Strands SDK) that analyzes the story script, searches source material via transcripts and semantic embeddings, and assembles a rough cut video timeline in Mimir using the `sequenceDetails` track/clip model. The pipeline creates a new Mimir item representing the timeline and updates the Saga story to indicate the rough cut is ready.

## Glossary

- **Custom_Actions_API**: The existing Mimir Custom Actions REST API Gateway (`api`) that exposes POST endpoints under `/actions/` for custom action handlers
- **Mimir_Handler**: The existing Lambda function (`mimir-handler`) that authenticates incoming custom action requests, resolves the action type, and starts the appropriate Step Functions state machine
- **Rough_Cut_State_Machine**: A new Step Functions Standard state machine that orchestrates story context gathering and AgentCore agent invocation for rough cut timeline generation
- **Story_Context_Lambda**: A new Lambda function that fetches story details, assets, instances, and notes from the Saga_API and evaluates asset readiness (embeddings and transcripts)
- **Saga_API**: The Saga REST API used to retrieve story data (GET /stories/{id}, GET /stories/{id}/assets, GET /stories/{id}/instances, GET /stories/{id}/notes) and update story metadata (PATCH /stories/{id}), authenticated via `x-api-key` header
- **Mimir_API**: The Mimir REST API (configured via `MIMIR_API_BASE` environment variable) used to retrieve item details, transcripts, and create items with sequence details, authenticated via `x-mimir-cognito-id-token: Bearer {apiKey}` header
- **AgentCore_Runtime**: The AWS Bedrock AgentCore Runtime service that hosts and executes Strands SDK agents, invokable directly from Step Functions
- **Rough_Cut_Agent**: The multi-agent system deployed on AgentCore_Runtime, composed of a Script_Analysis_Agent, Source_Material_Agent, and Timeline_Assembly_Agent working together to produce a rough cut timeline
- **Script_Analysis_Agent**: A sub-agent within the Rough_Cut_Agent that analyzes story scripts and notes to identify narrative structure (lead, body, wrap-up), key soundbites, and interview segments
- **Source_Material_Agent**: A sub-agent within the Rough_Cut_Agent that reviews transcripts and queries the Vector_Index to find video segments matching the script structure
- **Timeline_Assembly_Agent**: A sub-agent within the Rough_Cut_Agent that constructs the final timeline with in/out points and assembles clips in narrative order using the Mimir sequenceDetails format
- **Vector_Index**: The existing S3 Vector Index (`video-embeddings-index`) that stores Nova multimodal embeddings for video segments with timing metadata
- **Timed_Transcript**: A word-level timed transcript available via the Mimir_API `timedTranscriptUrl` field on video items, providing word-by-word timing for transcript alignment
- **Sequence_Details**: The Mimir item creation model that describes a timeline as tracks (video/audio) containing clips with `start`, `end`, `duration`, `inPoint`, `outPoint`, and `mimirItemId` fields

## Requirements

### Requirement 1: Custom Action Endpoint Registration

**User Story:** As a Saga editor, I want a "Generate Rough Cut" custom action available on stories, so that I can trigger automated rough cut timeline generation from within Saga.

#### Acceptance Criteria

1. THE Custom_Actions_API SHALL expose a POST endpoint at `/actions/rough-cut`
2. WHEN a POST request is received at `/actions/rough-cut`, THE Mimir_Handler SHALL validate the request API key, extract the story context from the request body, and start the Rough_Cut_State_Machine asynchronously
3. WHEN the Mimir_Handler starts the Rough_Cut_State_Machine, THE Mimir_Handler SHALL pass the story ID, user token, action data, user ID, user email, and Mimir API key as input to the state machine
4. THE Mimir_Handler SHALL return an HTTP 200 response with the Step Functions execution ARN to the caller within 30 seconds of receiving the request
5. IF the request body contains no items or the API key is invalid, THEN THE Mimir_Handler SHALL return an appropriate error response without starting the state machine

### Requirement 2: Story Details Retrieval

**User Story:** As the rough cut pipeline, I want to fetch the full story context from Saga, so that the agent has the editorial intent, script, and asset references needed to build a timeline.

#### Acceptance Criteria

1. WHEN the Rough_Cut_State_Machine starts, THE Story_Context_Lambda SHALL call the Saga_API at GET /stories/{id} to retrieve the story details including title, description, script content, and metadata
2. THE Story_Context_Lambda SHALL call the Saga_API at GET /stories/{id}/assets to retrieve the list of Mimir item references associated with the story
3. THE Story_Context_Lambda SHALL call the Saga_API at GET /stories/{id}/instances to retrieve broadcast instances with rundown information
4. THE Story_Context_Lambda SHALL call the Saga_API at GET /stories/{id}/notes to retrieve editorial notes, research notes, and pitch content
5. THE Story_Context_Lambda SHALL authenticate all Saga_API calls using the `x-api-key` header with the API key retrieved from AWS Secrets Manager
6. IF any Saga_API call returns an error, THEN THE Story_Context_Lambda SHALL return a descriptive error including the endpoint path and HTTP status code

### Requirement 3: Asset Readiness Evaluation

**User Story:** As the rough cut pipeline, I want to evaluate which video assets have embeddings and transcripts available, so that the agent knows which source material is searchable and alignable.

#### Acceptance Criteria

1. WHEN the story assets are retrieved, THE Story_Context_Lambda SHALL query the Vector_Index for each video asset to determine if embeddings exist by checking for vectors with a matching `itemId` metadata field
2. THE Story_Context_Lambda SHALL call the Mimir_API at GET /api/v1/items/{itemId} for each video asset to check if the `timedTranscriptUrl` field is present and non-empty
3. THE Story_Context_Lambda SHALL return an enriched asset list where each asset includes boolean flags `hasEmbeddings` and `hasTranscript` alongside the original asset data
4. IF a video asset has neither embeddings nor a transcript, THEN THE Story_Context_Lambda SHALL include the asset in the result with both flags set to false and a warning message indicating limited searchability

### Requirement 4: AgentCore Runtime Invocation

**User Story:** As the rough cut pipeline, I want to invoke the Rough_Cut_Agent via AgentCore Runtime from Step Functions, so that the multi-agent system can analyze the story and build the timeline.

#### Acceptance Criteria

1. WHEN the story context and enriched asset list are assembled, THE Rough_Cut_State_Machine SHALL invoke the AgentCore_Runtime using the Step Functions direct integration with a `waitForTaskToken` pattern
2. THE Rough_Cut_State_Machine SHALL pass the story details, enriched asset list, instances, notes, and a Step Functions task token to the AgentCore_Runtime invocation
3. THE Rough_Cut_State_Machine SHALL enforce a timeout of 30 minutes on the AgentCore_Runtime invocation step
4. IF the AgentCore_Runtime invocation fails or times out, THEN THE Rough_Cut_State_Machine SHALL transition to a failure state with the error details captured

### Requirement 5: Script Analysis

**User Story:** As the Rough_Cut_Agent, I want to analyze the story script and editorial notes, so that the narrative structure is identified for timeline assembly.

#### Acceptance Criteria

1. WHEN the Rough_Cut_Agent receives the story context, THE Script_Analysis_Agent SHALL analyze the story script, description, and editorial notes to identify the narrative structure
2. THE Script_Analysis_Agent SHALL classify the story into broadcast news segments: lead (opening hook, 15-20 seconds), body (main narrative points with supporting elements), and wrap-up (conclusion or call-to-action)
3. THE Script_Analysis_Agent SHALL identify key soundbite candidates from the script, including speaker attributions and estimated durations
4. THE Script_Analysis_Agent SHALL identify interview segments and voice-over sections that require specific source material
5. THE Script_Analysis_Agent SHALL produce a structured analysis document that the Source_Material_Agent and Timeline_Assembly_Agent can consume

### Requirement 6: Source Material Search

**User Story:** As the Rough_Cut_Agent, I want to search transcripts and embeddings to find video segments matching the script structure, so that the timeline uses the most relevant source material.

#### Acceptance Criteria

1. WHEN the script analysis is complete, THE Source_Material_Agent SHALL use the `get_transcript` tool to fetch timed transcripts for each video asset that has `hasTranscript` set to true
2. THE Source_Material_Agent SHALL use the `query_embeddings` tool to search the Vector_Index for video segments semantically similar to each narrative segment identified by the Script_Analysis_Agent
3. THE Source_Material_Agent SHALL rank candidate video segments by relevance to each script segment, considering both transcript keyword matches and embedding similarity scores
4. THE Source_Material_Agent SHALL resolve in/out points for each candidate segment using word-level timing from the Timed_Transcript, aligning to sentence or phrase boundaries
5. IF no matching segments are found for a script section, THEN THE Source_Material_Agent SHALL report the gap to the Timeline_Assembly_Agent with the unmatched script content

### Requirement 7: Timeline Assembly and Creation

**User Story:** As the Rough_Cut_Agent, I want to assemble the final timeline in Mimir with precise in/out points, so that the editor has a structured rough cut to refine.

#### Acceptance Criteria

1. WHEN the source material search is complete, THE Timeline_Assembly_Agent SHALL construct a Sequence_Details object with video and audio tracks containing clips ordered according to the broadcast news structure (lead → body → wrap-up)
2. THE Timeline_Assembly_Agent SHALL use the `create_timeline` tool to create a new Mimir item via POST /api/v1/items with the assembled Sequence_Details, setting the title to include the story name and "Rough Cut"
3. EACH clip in the Sequence_Details SHALL specify `start` (position in the new timeline in milliseconds), `end`, `duration`, `inPoint` (source clip start in milliseconds), `outPoint` (source clip end in milliseconds), and `mimirItemId` (the source Mimir item ID)
4. THE Timeline_Assembly_Agent SHALL place voice-over clips on a separate audio track from interview and natural sound clips
5. THE Timeline_Assembly_Agent SHALL ensure no overlapping clips exist on the same track, with each clip's `start` equal to or greater than the previous clip's `end` on that track
6. IF the Mimir_API item creation call fails, THEN THE Timeline_Assembly_Agent SHALL retry once and report the error if the retry also fails

### Requirement 8: Agent Tool Definitions

**User Story:** As a developer, I want the Rough_Cut_Agent to have well-defined tools for interacting with external APIs, so that the agent can fetch data and create resources without hardcoded logic.

#### Acceptance Criteria

1. THE Rough_Cut_Agent SHALL expose a `get_mimir_item_details` tool that calls GET /api/v1/items/{itemId} on the Mimir_API and returns the item metadata, proxy URL, and transcript URL
2. THE Rough_Cut_Agent SHALL expose a `get_transcript` tool that fetches the timed transcript JSON from the `timedTranscriptUrl` of a Mimir item and returns the word-level timing array
3. THE Rough_Cut_Agent SHALL expose a `query_embeddings` tool that generates a text embedding using the Nova model, queries the Vector_Index with the embedding vector, and returns the top-K results with segment timing metadata
4. THE Rough_Cut_Agent SHALL expose a `create_timeline` tool that calls POST /api/v1/items on the Mimir_API with a Sequence_Details payload to create a new timeline item
5. THE Rough_Cut_Agent SHALL expose an `update_story_status` tool that calls PATCH /stories/{id} on the Saga_API to update the story metadata indicating the rough cut is available
6. ALL agent tools SHALL authenticate API calls using credentials retrieved from AWS Secrets Manager at agent startup

### Requirement 9: Completion and Status Updates

**User Story:** As a Saga editor, I want the story and Mimir item updated when the rough cut is ready, so that I can find and review the generated timeline.

#### Acceptance Criteria

1. WHEN the Timeline_Assembly_Agent successfully creates the timeline item in Mimir, THE Rough_Cut_Agent SHALL call the `update_story_status` tool to update the Saga story metadata with a reference to the generated timeline Mimir item ID
2. THE Rough_Cut_Agent SHALL send a Step Functions `SendTaskSuccess` callback with the timeline item ID and a summary of the generated timeline (number of clips, total duration, track count)
3. WHEN the Rough_Cut_State_Machine receives the task success callback, THE Rough_Cut_State_Machine SHALL transition to a completion state
4. IF the Rough_Cut_Agent encounters an unrecoverable error, THEN THE Rough_Cut_Agent SHALL send a Step Functions `SendTaskFailure` callback with the error details

### Requirement 10: AgentCore Runtime Deployment

**User Story:** As a system operator, I want the Rough_Cut_Agent deployed as an AgentCore Runtime with the Strands SDK, so that the agent is managed, scalable, and invokable from Step Functions.

#### Acceptance Criteria

1. THE CDK stack SHALL deploy the Rough_Cut_Agent as an AgentCore Runtime using the existing AgentCoreRuntime construct pattern with a Python source directory under `agents/rough-cut-agent/`
2. THE CDK stack SHALL configure the AgentCore Runtime with environment variables for the Mimir API key secret ARN, Saga API key secret ARN, Saga API URL secret ARN, Vector Bucket name, and Vector Index name
3. THE CDK stack SHALL grant the AgentCore Runtime execution role permissions to read secrets from Secrets Manager, invoke Bedrock models, query and put vectors in the Vector_Index, and call `states:SendTaskSuccess` and `states:SendTaskFailure`
4. THE CDK stack SHALL store the AgentCore Runtime ARN in SSM Parameter Store at `/fonn-custom-actions/agentcore/rough-cut-agent/runtime-arn`

### Requirement 11: Step Functions Workflow Orchestration

**User Story:** As a system operator, I want the rough cut pipeline orchestrated as a Step Functions state machine, so that the workflow is observable, retryable, and maintainable.

#### Acceptance Criteria

1. THE Rough_Cut_State_Machine SHALL be a Standard type Step Functions state machine with a timeout of 35 minutes
2. THE Rough_Cut_State_Machine SHALL execute the following steps in order: gather story context via Story_Context_Lambda, invoke the Rough_Cut_Agent via AgentCore_Runtime with waitForTaskToken, and transition to a success or failure terminal state
3. THE Rough_Cut_State_Machine SHALL use JSONata query language for state variable management and payload transformation
4. IF the Story_Context_Lambda step fails, THEN THE Rough_Cut_State_Machine SHALL transition to a failure state without invoking the AgentCore_Runtime
5. THE Rough_Cut_State_Machine SHALL include retry configuration with exponential backoff for transient Lambda and AgentCore errors

### Requirement 12: IAM Permissions

**User Story:** As a system operator, I want all components to have least-privilege IAM permissions, so that the pipeline operates securely.

#### Acceptance Criteria

1. THE Story_Context_Lambda SHALL have permission to read the Saga API key secret and the Saga API URL secret from Secrets Manager, and permission to call `s3vectors:QueryVectors` on the Vector_Index and `s3vectors:ListVectors` on the Vector_Index
2. THE Story_Context_Lambda SHALL have permission to read the Mimir API key secret from Secrets Manager for checking transcript availability
3. THE Mimir_Handler SHALL have permission to start executions of the Rough_Cut_State_Machine
4. THE Rough_Cut_State_Machine SHALL have permission to invoke the Story_Context_Lambda and to call `bedrock-agentcore:InvokeAgentRuntime` on the Rough_Cut_Agent runtime
