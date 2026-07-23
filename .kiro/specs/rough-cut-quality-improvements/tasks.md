# Implementation Plan: Rough Cut Quality Improvements

## Overview

This plan implements quality improvements to the Rough Cut Agent pipeline across six areas: script format detection and broadcast parsing, voice-over audio generation via Amazon Polly, SOT timecode alignment, multi-track timeline assembly, new tools (`generate_voiceover`, `upload_voiceover_to_mimir`), model upgrade support, and CDK infrastructure changes. Tasks are ordered so each builds on the previous, starting with the Script Analysis Agent enhancements and ending with wiring the multi-track timeline assembly together.

## Tasks

- [x] 1. Enhance Script Analysis Agent with format detection and broadcast parsing
  - [x] 1.1 Update `SCRIPT_ANALYSIS_PROMPT` in `agents/rough-cut-agent/prompts.py` to add script format detection and broadcast section parsing
    - Add instructions for classifying content as `broadcast_script` or `story_overview` based on editorial judgment (presence of producible narration text, attributed quotes, narrative flow vs. notes/bullet points)
    - Add instructions for parsing broadcast scripts into an ordered `parsedSections` array with `sectionType` (`anchor_intro`, `reporter_live`, `pkg_vo`, `pkg_sot`, `pkg_nats`, `live_tag`, `anchor_qa`, `super`), `content`, `orderIndex`, `estimatedDurationMs`, and optional `timecodeSeconds`, `speaker`, `quotedText` for SOT sections
    - Add duration estimation rules: VO at ~400ms/word (150 WPM), SOT from explicit timecodes or word count, nats at 3000ms default
    - Add `totalEstimatedDurationMs` sum field
    - Add story overview fallback: construct synthetic `parsedSections` from lead/body/wrapUp when `scriptFormat` is `story_overview`
    - Update the output JSON schema in the prompt to include `scriptFormat`, `parsedSections`, and `totalEstimatedDurationMs` alongside existing fields
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 2.1, 2.2, 2.3, 2.4, 2.5, 10.1, 10.2, 10.3, 10.4_

  - [x] 1.2 Update `_validate_script_analysis` in `agents/rough-cut-agent/rough_cut_agent.py` to validate new fields
    - Add `scriptFormat` to required keys, validate value is `broadcast_script` or `story_overview`
    - Add `parsedSections` validation: must be a list, each entry must have `sectionType`, `content`, `orderIndex`, `estimatedDurationMs`
    - Add `totalEstimatedDurationMs` validation: must be a number
    - Keep existing validation for backward-compatible fields (`lead`, `body`, `wrapUp`, etc.)
    - _Requirements: 1.4, 2.5, 10.2, 10.3_

  - [ ]* 1.3 Write unit tests for `_validate_script_analysis` with new fields
    - Test valid broadcast_script with parsedSections passes validation
    - Test valid story_overview with synthetic parsedSections passes validation
    - Test missing `scriptFormat` raises ValueError
    - Test invalid `sectionType` values
    - Test missing `estimatedDurationMs` on a section
    - _Requirements: 1.4, 2.5, 10.2_

- [x] 2. Checkpoint - Verify Script Analysis changes
  - Ensure all tests pass, ask the user if questions arise.

- [x] 3. Implement new agent tools: `generate_voiceover` and `upload_voiceover_to_mimir`
  - [x] 3.1 Implement `generate_voiceover` tool in `agents/rough-cut-agent/tools.py`
    - Add `@tool` function `generate_voiceover(text: str, story_id: str, section_index: int) -> str`
    - Read `POLLY_VOICE_ID` from env (default `Matthew`) and `TRANSCRIPT_STAGING_BUCKET` from env
    - Call `polly.synthesize_speech(Text=text, OutputFormat='mp3', Engine='neural', VoiceId=voice_id)`
    - Store audio stream to S3 at `voiceover/{story_id}/{section_index}.mp3`
    - Estimate duration from audio byte length: `duration_ms = len(audio_bytes) / (48000 / 8) * 1000`
    - Return JSON with `s3Uri`, `durationMs`, `sectionIndex`
    - On Polly error: log and return `{"error": "...", "sectionIndex": section_index}`
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 9.3, 9.4_

  - [x] 3.2 Implement `upload_voiceover_to_mimir` tool in `agents/rough-cut-agent/tools.py`
    - Add `@tool` function `upload_voiceover_to_mimir(s3_uri: str, story_title: str, section_index: int, parent_item_ids: list[str]) -> str`
    - Call `POST /api/v1/items` with `{"title": "{story_title} - VO {section_index}", "itemType": "audio", "parentItemIds": parent_item_ids}`
    - Return JSON with `mimirItemId` and `title`
    - On error: log and return `{"error": "..."}`
    - _Requirements: 11.1, 11.2, 11.3, 11.4_

  - [ ]* 3.3 Write unit tests for `generate_voiceover` tool
    - Mock boto3 Polly and S3 clients
    - Test successful synthesis returns s3Uri and durationMs
    - Test Polly error returns error JSON without raising
    - Test S3 key follows `voiceover/{story_id}/{section_index}.mp3` pattern
    - Test default voice ID is `Matthew` when env var not set
    - _Requirements: 3.2, 3.3, 3.5, 3.6_

  - [ ]* 3.4 Write unit tests for `upload_voiceover_to_mimir` tool
    - Mock requests to Mimir API
    - Test successful creation returns mimirItemId
    - Test title follows `"{storyTitle} - VO {sectionIndex}"` pattern
    - Test API error returns error JSON without raising
    - _Requirements: 11.1, 11.2, 11.4_

- [x] 4. Checkpoint - Verify new tools
  - Ensure all tests pass, ask the user if questions arise.

- [x] 5. Enhance Source Material Agent with SOT alignment, VO detection, and track tagging
  - [x] 5.1 Update `SOURCE_MATERIAL_PROMPT` in `agents/rough-cut-agent/prompts.py` for SOT timecode alignment, reporter VO detection, track placement, and coverage tracking
    - Add SOT timecode alignment instructions: convert timecodeSeconds to 30s search window, use `get_word_timing` for word-level matching, substring match quotedText, set inPointMs/outPointMs with 500ms pad, expand to full transcript on miss with `matchConfidence: low`
    - Add reporter-provided VO detection instructions: for `pkg_vo` sections, search transcripts for 70%+ word overlap before flagging for Polly, tag `voiceoverSource` as `reporter_provided` or `polly_generated`
    - Add track placement tagging: `trackPlacement` (`v1_aroll` for SOT/interview, `v2_broll` for B-roll), `audioType` (`interview`, `nats`, `none`)
    - Add coverage tracking: `coveragePercentage` field, second pass with `top_k=20` when below 80%
    - Update output JSON schema to include `matchConfidence`, `trackPlacement`, `audioType`, `voiceoverSource`, `coveragePercentage`
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 5.1, 5.2, 5.3, 12.1, 12.2, 12.3, 12.4, 13.1, 13.2, 13.5_

  - [x] 5.2 Update `_validate_source_material` in `agents/rough-cut-agent/rough_cut_agent.py` to validate new fields
    - Add `coveragePercentage` default (0) if missing
    - Validate `trackPlacement` and `audioType` on candidates if present
    - Validate `matchConfidence` on candidates if present
    - Validate `voiceoverSource` on candidates if present
    - _Requirements: 5.2, 12.1, 12.2, 4.5, 13.5_

  - [ ]* 5.3 Write unit tests for updated `_validate_source_material`
    - Test candidates with `trackPlacement`, `audioType`, `matchConfidence`, `voiceoverSource` pass validation
    - Test `coveragePercentage` defaults to 0 when missing
    - _Requirements: 5.2, 12.1, 4.5_

- [x] 6. Extend `create_timeline` tool for multi-track and audio-only sources
  - [x] 6.1 Update `create_timeline` in `agents/rough-cut-agent/tools.py` to support multi-track layout and audio-only source references
    - Process clips from all 4 tracks: V1 (A-roll, id:1), V2 (B-roll, id:2), A1 (voice-over, id:3), A2 (interview/nats, id:4)
    - Support `audio-only` source references for Polly-generated clips: `itemRef` with `type: "audio"`, `nAudioChannels: 1`; `sourceRef` with `type: "audio-only"`
    - Build Cutter payload with multiple `videoTracks` arrays (V1, V2) and place audio clips on appropriate `audioTracks` slots
    - Maintain backward compatibility: if only 3 tracks provided (old format), fall back to existing behavior
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 7.1, 7.2, 7.3_

  - [ ]* 6.2 Write unit tests for extended `create_timeline`
    - Mock Mimir API calls
    - Test 4-track payload generates correct Cutter structure with 2 videoTracks and audio on correct audioTracks
    - Test audio-only source reference creates correct itemRef and sourceRef
    - Test backward compatibility with 3-track input
    - _Requirements: 6.6, 7.1, 7.2, 7.3_

- [x] 7. Checkpoint - Verify Source Material and timeline tool changes
  - Ensure all tests pass, ask the user if questions arise.

- [x] 8. Enhance Timeline Assembly Agent for multi-track assembly and VO handling
  - [x] 8.1 Update `TIMELINE_ASSEMBLY_PROMPT` in `agents/rough-cut-agent/prompts.py` for 4-track layout, VO handling, and placeholder gaps
    - Update track layout to 4 tracks: V1 (A-roll), V2 (B-roll), A1 (voice-over), A2 (interview/nats)
    - Add VO section handling: call `generate_voiceover` then `upload_voiceover_to_mimir` for `polly_generated` sections, use reporter audio for `reporter_provided` sections
    - Add B-roll alignment: align V2 B-roll clips to match corresponding A1 voice-over clip start/end
    - Add placeholder gap insertion for unmatched sections with `estimatedDurationMs`
    - Add `generate_voiceover` and `upload_voiceover_to_mimir` to the tool list in the prompt
    - Update output schema to include `coveragePercentage`, `voiceoverClipCount`, `gapCount` in summary
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.7, 5.4, 5.5, 13.3, 13.4, 13.6_

  - [x] 8.2 Update `_validate_timeline_assembly` in `agents/rough-cut-agent/rough_cut_agent.py` to validate 4-track layout
    - Validate minimum 4 tracks present
    - Validate track mediaTypes: at least 2 video and 2 audio tracks
    - Keep existing clip validation and no-overlap checks
    - _Requirements: 6.1, 6.5_

  - [x] 8.3 Update `run_timeline_assembly` in `agents/rough-cut-agent/rough_cut_agent.py` to pass new tools to the agent
    - Add `generate_voiceover` and `upload_voiceover_to_mimir` to the tools list alongside existing tools
    - Pass voice-over metadata and `voiceoverSource` tags from source material output in the user message
    - _Requirements: 3.6, 6.3, 11.3, 13.3, 13.6_

  - [ ]* 8.4 Write unit tests for updated `_validate_timeline_assembly`
    - Test 4-track timeline passes validation
    - Test timeline with fewer than 4 tracks fails validation
    - Test audio-only clips pass clip validation
    - _Requirements: 6.1, 6.5_

- [x] 9. Implement model upgrade support
  - [x] 9.1 Update `run_source_material` and `run_timeline_assembly` in `agents/rough-cut-agent/rough_cut_agent.py` to support configurable model ID
    - Read `AGENT_MODEL_ID` from environment variable
    - If set and non-empty, use it as `model_id` for `BedrockModel`
    - If model ID contains `claude`, set `max_tokens` to 16000
    - Add model validation: attempt a lightweight Bedrock call to verify accessibility, fall back to `us.amazon.nova-premier-v1:0` on failure with a warning log
    - Default to `us.amazon.nova-premier-v1:0` when env var is empty or not set
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5_

  - [ ]* 9.2 Write unit tests for model configuration logic
    - Test default model is Nova Premier when env var not set
    - Test Claude model ID sets max_tokens to 16000
    - Test fallback to default on inaccessible model
    - _Requirements: 8.1, 8.3, 8.4_

- [x] 10. Update CDK infrastructure for Polly permissions and new environment variables
  - [x] 10.1 Update `lib/agentcore-stack.ts` to add Polly IAM permissions and S3 write access
    - Add `polly:SynthesizeSpeech` permission to the shared AgentCore execution role
    - Add `s3:PutObject` permission to the staging bucket for the `voiceover/` prefix (resource: `arn:aws:s3:::video-embedding-staging-*/*`)
    - _Requirements: 9.1, 9.2_

  - [x] 10.2 Update `lib/agentcore-stack.ts` to add new environment variables to the rough-cut-agent
    - Add `POLLY_VOICE_ID: 'Matthew'` to the rough-cut-agent environment variables
    - Add `AGENT_MODEL_ID: ''` (empty string = default Nova Premier) to the rough-cut-agent environment variables
    - _Requirements: 9.3, 9.4, 8.2_

- [x] 11. Wire orchestration: update `invoke` entrypoint to pass new data through the pipeline
  - [x] 11.1 Update the `invoke` function in `agents/rough-cut-agent/rough_cut_agent.py` to thread new data between stages
    - Pass `parsedSections` and `totalEstimatedDurationMs` from script analysis to source material agent (already passed as full `script_analysis` dict)
    - After source material returns, identify VO sections tagged `polly_generated` and pass voice-over metadata to timeline assembly
    - Ensure `run_source_material` receives the enhanced script analysis with `parsedSections`
    - Ensure `run_timeline_assembly` receives source material with `trackPlacement`, `audioType`, `voiceoverSource` tags
    - _Requirements: 5.1, 5.4, 13.6_

  - [x] 11.2 Import new tools in `agents/rough-cut-agent/rough_cut_agent.py`
    - Add `generate_voiceover` and `upload_voiceover_to_mimir` to the import from `tools`
    - _Requirements: 3.6, 11.1_

- [x] 12. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- The implementation language is Python (agent code) and TypeScript (CDK infrastructure)
- All agent tools use the `@tool` decorator from the Strands SDK
- The existing `create_timeline` tool must maintain backward compatibility with the current 3-track format
