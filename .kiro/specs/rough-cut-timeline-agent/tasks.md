# Implementation Plan: Rough Cut Timeline Agent

## Overview

Incrementally build the rough cut timeline generation pipeline: start with the new Lambda and mimir-handler routing, then the Step Functions state machine, then the multi-agent system on AgentCore Runtime, and finally wire everything together with CDK infrastructure and IAM permissions. Each task builds on the previous, with checkpoints to validate along the way.

## Tasks

- [x] 1. Create the story-context-handler Lambda
  - [x] 1.1 Scaffold `lambda/story-context-handler/index.js` with Secrets Manager caching, Saga API calls (GET /stories/{id}, /assets, /instances, /notes), and error formatting that includes endpoint path and HTTP status code
    - Implement `getSecretValue` helper with caching for Saga API key, Saga API URL, and Mimir API key
    - Call all four Saga endpoints and aggregate results into a `StoryContext` object
    - On any Saga API non-2xx response, return error with endpoint path and status code in the message
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6_

  - [x] 1.2 Add asset readiness evaluation to story-context-handler
    - For each video asset, query S3 Vector Index (`QueryVectors` with `itemId` metadata filter) to set `hasEmbeddings`
    - For each video asset, call Mimir API `GET /api/v1/items/{itemId}` to check `timedTranscriptUrl` and set `hasTranscript`
    - Assets with both flags false get a warning message
    - Return enriched asset list with same length as input
    - _Requirements: 3.1, 3.2, 3.3, 3.4_

  - [ ]* 1.3 Write property test for Saga API error formatting (Property 4)
    - **Property 4: Saga API error responses include endpoint path and HTTP status code**
    - Generate random HTTP status codes (400-599) and endpoint paths, verify error messages contain both
    - Use `fast-check` for JavaScript property tests
    - **Validates: Requirements 2.6**

  - [ ]* 1.4 Write property test for asset enrichment (Property 5)
    - **Property 5: Asset enrichment produces correct boolean flags**
    - Generate random asset lists with varying embedding/transcript availability, verify enriched output flags match and warning is set when both are false
    - Use `fast-check` for JavaScript property tests
    - **Validates: Requirements 3.1, 3.2, 3.3, 3.4**

- [x] 2. Add rough-cut case to mimir-handler Lambda
  - [x] 2.1 Add `rough-cut` case to the switch statement in `lambda/mimir-handler/index.js`
    - Set `stateMachineArn = process.env.ROUGH_CUT_STATE_MACHINE_ARN`
    - If items array is empty, return 200 with "No items found to process for rough-cut" message
    - No item type filtering needed (story context comes from actionData)
    - Pass all required fields: items, userToken, actionData, userId, userEmail, mimirApiKey
    - _Requirements: 1.2, 1.3, 1.4, 1.5_

  - [ ]* 2.2 Write property test for handler routing (Property 1)
    - **Property 1: Handler routes rough-cut action and passes complete payload**
    - Generate random valid request bodies, verify handler calls StartExecution with all required fields present
    - Use `fast-check` for JavaScript property tests
    - **Validates: Requirements 1.2, 1.3**

  - [ ]* 2.3 Write property test for invalid request rejection (Property 2)
    - **Property 2: Invalid requests are rejected without starting state machine**
    - Generate random invalid API keys and empty items arrays, verify no StartExecution call is made
    - Use `fast-check` for JavaScript property tests
    - **Validates: Requirements 1.5**

- [x] 3. Checkpoint - Validate Lambda functions
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. Create the Rough Cut Agent on AgentCore Runtime
  - [x] 4.1 Scaffold `agents/rough-cut-agent/` with Dockerfile, requirements.txt, and main agent entry point
    - Create `agents/rough-cut-agent/Dockerfile` following the `xml-processor-agent` Dockerfile pattern (uv, python3.13-bookworm-slim)
    - Create `agents/rough-cut-agent/requirements.txt` with strands-agents, bedrock-agentcore, strands-agents-tools, boto3
    - Create `agents/rough-cut-agent/rough_cut_agent.py` with `BedrockAgentCoreApp` entrypoint, health check, and Step Functions callback setup
    - _Requirements: 10.1_

  - [x] 4.2 Implement agent tools: `get_mimir_item_details`, `get_transcript`, `query_embeddings`, `create_timeline`, `update_story_status`
    - Create `agents/rough-cut-agent/tools.py` with all five `@tool` decorated functions
    - `get_mimir_item_details(mimir_item_id)`: GET /api/v1/items/{id} with `x-mimir-cognito-id-token` auth header
    - `get_transcript(mimir_item_id)`: Fetch item details first, then GET the `timedTranscriptUrl`
    - `query_embeddings(text, top_k=10)`: Generate embedding via Bedrock Nova model, query S3 Vector Index, return results with timing metadata
    - `create_timeline(title, sequence_details_json, parent_item_ids)`: POST /api/v1/items with sequenceDetails payload
    - `update_story_status(story_id, timeline_item_id)`: PATCH /stories/{id} on Saga API with `x-api-key` auth
    - All tools retrieve credentials from environment variables (secret ARNs) at module load
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6_

  - [ ]* 4.3 Write property test for authentication headers (Property 3)
    - **Property 3: All outgoing API calls include correct authentication headers**
    - Mock HTTP calls and verify Saga API calls use `x-api-key` and Mimir API calls use `x-mimir-cognito-id-token: Bearer {key}`
    - Use `hypothesis` for Python property tests
    - **Validates: Requirements 2.5, 8.6**

  - [ ]* 4.4 Write property test for embedding query bounds (Property 13)
    - **Property 13: Embedding query returns bounded results with timing metadata**
    - Generate random top_k values and mock embedding results, verify result count <= top_k and all results have `startTimeSeconds` and `endTimeSeconds`
    - Use `hypothesis` for Python property tests
    - **Validates: Requirements 8.3**

- [x] 5. Implement the Script Analysis Agent
  - [x] 5.1 Create `agents/rough-cut-agent/prompts.py` with the script analysis system prompt
    - Define broadcast news structure analysis prompt (lead, body, wrap-up) following the pattern in `editor-agent/agents/script-processing-agent/prompts/story_structuring.py`
    - Include soundbite identification, interview segment detection, and voice-over section mapping
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5_

  - [x] 5.2 Implement the Script Analysis Agent as a graph node in `rough_cut_agent.py`
    - Create a function that takes story context (title, description, script, notes) and returns a `ScriptAnalysis` structured output
    - Use Strands Agent with the script analysis prompt and BedrockModel
    - Parse and validate the output conforms to the ScriptAnalysis schema (lead, body, wrapUp, soundbites, interviewSegments, voiceOverSections)
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5_

  - [ ]* 5.3 Write property test for script analysis schema (Property 6)
    - **Property 6: Script analysis output conforms to schema**
    - Generate random valid story context inputs, verify output contains required fields (lead with content/hookType/estimatedDurationMs, body with mainPoints, wrapUp with content/closureType)
    - Use `hypothesis` for Python property tests
    - **Validates: Requirements 5.2, 5.5**

- [x] 6. Implement the Source Material Agent
  - [x] 6.1 Implement the Source Material Agent as a graph node in `rough_cut_agent.py`
    - Takes script analysis and enriched asset list as input
    - For each asset with `hasTranscript=true`, calls `get_transcript` tool
    - For each narrative segment, calls `query_embeddings` to find semantically similar video segments
    - Ranks candidates by combined transcript keyword match and embedding similarity
    - Resolves in/out points using word-level timing from timed transcripts
    - Reports gaps where no matching segments found
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5_

  - [ ]* 6.2 Write property test for transcript tool invocation (Property 7)
    - **Property 7: Transcript tool invoked only for transcript-ready assets**
    - Generate random enriched asset lists, verify `get_transcript` called only for assets with `hasTranscript=true`
    - Use `hypothesis` for Python property tests
    - **Validates: Requirements 6.1**

  - [ ]* 6.3 Write property test for candidate segment sorting (Property 8)
    - **Property 8: Candidate segments are sorted by relevance score descending**
    - Generate random candidate segment lists with scores, verify sorted descending
    - Use `hypothesis` for Python property tests
    - **Validates: Requirements 6.3**

  - [ ]* 6.4 Write property test for in/out point bounds (Property 9)
    - **Property 9: Resolved in/out points fall within source clip bounds**
    - Generate random timed transcript data and target phrases, verify resolved in/out points are within source duration bounds
    - Use `hypothesis` for Python property tests
    - **Validates: Requirements 6.4**

- [x] 7. Implement the Timeline Assembly Agent
  - [x] 7.1 Implement the Timeline Assembly Agent as a graph node in `rough_cut_agent.py`
    - Takes script analysis and ranked candidate segments as input
    - Constructs `sequenceDetails` with video track (clips ordered lead → body → wrap-up) and separate audio tracks for voice-over vs interview/natural sound
    - Each clip specifies `start`, `end`, `duration`, `inPoint`, `outPoint`, `mimirItemId`
    - Validates no overlapping clips on same track
    - Calls `create_timeline` tool to create Mimir item with title `"{story_title} - Rough Cut"`
    - Calls `update_story_status` tool to update Saga story
    - Sends `SendTaskSuccess` callback with timeline item ID and summary (clipCount, totalDurationMs, trackCount)
    - On failure, sends `SendTaskFailure` with error details
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 9.1, 9.2, 9.3, 9.4_

  - [ ]* 7.2 Write property test for timeline clip validity (Property 10)
    - **Property 10: Timeline clips are structurally valid with no overlaps**
    - Generate random clip lists, verify all invariants: `duration === end - start`, `duration === outPoint - inPoint`, `start >= 0`, `inPoint >= 0`, no overlapping clips on same track
    - Use `hypothesis` for Python property tests
    - **Validates: Requirements 7.3, 7.5**

  - [ ]* 7.3 Write property test for narrative order (Property 11)
    - **Property 11: Timeline clips follow narrative order**
    - Generate random clips tagged with narrative positions, verify lead clips have lower start values than body, which have lower than wrap_up on the video track
    - Use `hypothesis` for Python property tests
    - **Validates: Requirements 7.1**

  - [ ]* 7.4 Write property test for track separation (Property 12)
    - **Property 12: Voice-over clips are on a separate track from interview clips**
    - Generate random clip lists with mixed voice-over and interview types, verify no track contains both types
    - Use `hypothesis` for Python property tests
    - **Validates: Requirements 7.4**

  - [ ]* 7.5 Write property test for Step Functions callbacks (Property 14)
    - **Property 14: Step Functions callbacks contain required fields**
    - Generate random success/failure payloads, verify success contains `timelineItemId` and `summary` with `clipCount`/`totalDurationMs`/`trackCount`, failure contains `error` and `cause`
    - Use `hypothesis` for Python property tests
    - **Validates: Requirements 9.2, 9.4**

- [x] 8. Wire the multi-agent graph together
  - [x] 8.1 Compose the three agents into a Strands `GraphBuilder` pipeline in `rough_cut_agent.py`
    - Wire Script Analysis Agent → Source Material Agent → Timeline Assembly Agent as graph nodes
    - Pass story context to Script Analysis, pass analysis + assets to Source Material, pass analysis + candidates to Timeline Assembly
    - Handle the `waitForTaskToken` pattern: extract task token from payload, pass to Timeline Assembly for callback
    - Handle errors at each stage with `SendTaskFailure` callback
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 5.1, 6.1, 7.1, 9.2, 9.4_

- [x] 9. Checkpoint - Validate agent implementation
  - Ensure all tests pass, ask the user if questions arise.

- [x] 10. Add CDK infrastructure for the Rough Cut State Machine and Lambda
  - [x] 10.1 Add story-context-handler Lambda and Rough Cut State Machine to `lib/infrastructure-stack.ts`
    - Add `story-context-handler` Lambda with Node.js 22.x, 30s timeout, environment variables for Saga API key secret ARN, Saga API URL secret ARN, Mimir API key secret ARN, Vector Bucket name, Vector Index name
    - Add `RoughCutTimeline` Standard state machine with JSONata query language, 35-minute timeout
    - State machine steps: GatherStoryContext (Lambda invoke) → InvokeRoughCutAgent (AgentCore Runtime with waitForTaskToken, 30min timeout) → HandleSuccess/HandleFailure
    - Add retry configuration with exponential backoff (2s interval, 3 max attempts, 2x backoff) for transient Lambda errors
    - Add `/actions/rough-cut` resource on existing API Gateway, integrated with mimir-handler
    - Add `ROUGH_CUT_STATE_MACHINE_ARN` environment variable to mimir-handler
    - Grant mimir-handler permission to start the new state machine
    - _Requirements: 1.1, 11.1, 11.2, 11.3, 11.4, 11.5_

  - [x] 10.2 Configure IAM permissions for story-context-handler and state machine
    - story-context-handler: read Saga API key/URL secrets, read Mimir API key secret, `s3vectors:QueryVectors` and `s3vectors:ListVectors` on vector index
    - State machine role: invoke story-context-handler, `bedrock-agentcore:InvokeAgentRuntime` on rough-cut-agent runtime
    - _Requirements: 12.1, 12.2, 12.3, 12.4_

- [x] 11. Add rough-cut-agent to AgentCore stack
  - [x] 11.1 Add `rough-cut-agent` to the `MultiAgentCore` agents array in `lib/agentcore-stack.ts`
    - Add agent config with `name: 'rough-cut-agent'`, `sourceCodePath: './agents/rough-cut-agent'`, `enableLongTermMemory: true`
    - Add CfnOutput for the rough-cut-agent runtime ARN
    - Store runtime ARN in SSM at `/fonn-custom-actions/agentcore/rough-cut-agent/runtime-arn`
    - _Requirements: 10.1, 10.2, 10.4_

  - [x] 11.2 Configure AgentCore Runtime environment variables and IAM permissions
    - Environment variables: Mimir API key secret ARN, Saga API key secret ARN, Saga API URL secret ARN, Vector Bucket name, Vector Index name
    - IAM: read secrets from Secrets Manager, invoke Bedrock models, `s3vectors:QueryVectors`/`s3vectors:PutVectors` on vector index, `states:SendTaskSuccess`/`states:SendTaskFailure`
    - _Requirements: 10.2, 10.3_

- [x] 12. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document
- Lambda code is JavaScript (Node.js 22.x, CommonJS), agent code is Python (Strands SDK), CDK is TypeScript
- The Step Functions state machine uses JSONata query language (not JSONPath)
- AgentCore Runtime is invoked directly from Step Functions (no Lambda wrapper)
