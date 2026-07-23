"""Unit tests for run_timeline_assembly and timeline validation helpers.

Tests the validation logic directly and the end-to-end function with a
mocked Strands Agent so no real LLM calls are made.
"""

import json
import os
import sys
import pytest
from unittest.mock import patch, MagicMock

# ---------------------------------------------------------------------------
# Stub external SDKs that are imported at module level so the test can run
# without installing strands-agents, bedrock-agentcore, etc.
# ---------------------------------------------------------------------------

os.environ.setdefault("AWS_DEFAULT_REGION", "us-east-1")

_mock_strands = MagicMock()
sys.modules.setdefault("strands", _mock_strands)
sys.modules.setdefault("strands.models", MagicMock())

_mock_agentcore = MagicMock()
sys.modules.setdefault("bedrock_agentcore", _mock_agentcore)
sys.modules.setdefault("bedrock_agentcore.runtime", MagicMock())

_mock_prompts = MagicMock()
_mock_prompts.SCRIPT_ANALYSIS_PROMPT = "mock"
_mock_prompts.SOURCE_MATERIAL_PROMPT = "mock"
_mock_prompts.TIMELINE_ASSEMBLY_PROMPT = "You are a Timeline Assembly Agent..."
sys.modules.setdefault("prompts", _mock_prompts)

_mock_tools = MagicMock()
sys.modules.setdefault("tools", _mock_tools)

from rough_cut_agent import (
    _validate_clip,
    _validate_no_overlapping_clips,
    _validate_timeline_assembly,
    run_timeline_assembly,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _valid_clip(start=0, end=5000, in_point=1000, out_point=6000, item_id="item-001"):
    """Return a minimal valid clip dict."""
    return {
        "start": start,
        "end": end,
        "duration": end - start,
        "inPoint": in_point,
        "outPoint": out_point,
        "mimirItemId": item_id,
    }


def _valid_assembly() -> dict:
    """Return a minimal valid timeline assembly output with 4 tracks."""
    return {
        "timelineItemId": "timeline-001",
        "summary": {
            "clipCount": 3,
            "totalDurationMs": 25000,
            "trackCount": 4,
        },
        "sequenceDetails": {
            "tracks": [
                {
                    "id": "v1",
                    "name": "V1 - A-roll",
                    "mediaType": "video",
                    "clips": [
                        _valid_clip(0, 10000, 5000, 15000, "item-001"),
                        _valid_clip(10000, 20000, 0, 10000, "item-002"),
                    ],
                },
                {
                    "id": "v2",
                    "name": "V2 - B-roll",
                    "mediaType": "video",
                    "clips": [],
                },
                {
                    "id": "a1",
                    "name": "A1 - Voice-Over",
                    "mediaType": "audio",
                    "clips": [
                        _valid_clip(0, 8000, 0, 8000, "item-003"),
                    ],
                },
                {
                    "id": "a2",
                    "name": "A2 - Interview / Natural Sound",
                    "mediaType": "audio",
                    "clips": [],
                },
            ]
        },
    }


def _valid_script_analysis() -> dict:
    return {
        "lead": {"content": "Opening.", "hookType": "breaking_news", "estimatedDurationMs": 15000},
        "body": {"mainPoints": [{"content": "Main point.", "supportingElements": [], "narrativeFunction": "evidence"}]},
        "wrapUp": {"content": "Closing.", "closureType": "resolution"},
        "soundbites": [],
        "interviewSegments": [],
        "voiceOverSections": [],
    }


def _valid_source_material() -> dict:
    return {
        "candidateSegments": [
            {
                "scriptSection": "lead",
                "candidates": [
                    {"mimirItemId": "item-001", "inPointMs": 5000, "outPointMs": 15000, "relevanceScore": 0.9, "matchType": "both", "content": "Scene footage"},
                ],
            }
        ],
        "gaps": [],
    }


# ---------------------------------------------------------------------------
# _validate_clip
# ---------------------------------------------------------------------------

class TestValidateClip:
    def test_valid_clip_passes(self):
        _validate_clip(_valid_clip(), "test")

    def test_missing_start_raises(self):
        clip = _valid_clip()
        del clip["start"]
        with pytest.raises(ValueError, match="missing required key: start"):
            _validate_clip(clip, "test")

    def test_missing_mimirItemId_raises(self):
        clip = _valid_clip()
        del clip["mimirItemId"]
        with pytest.raises(ValueError, match="missing required key: mimirItemId"):
            _validate_clip(clip, "test")

    def test_negative_start_raises(self):
        clip = _valid_clip(start=-1, end=5000, in_point=0, out_point=5001)
        with pytest.raises(ValueError, match="start.*must be >= 0"):
            _validate_clip(clip, "test")

    def test_negative_inPoint_raises(self):
        clip = _valid_clip()
        clip["inPoint"] = -1
        clip["outPoint"] = clip["duration"] - 1
        with pytest.raises(ValueError, match="inPoint.*must be >= 0"):
            _validate_clip(clip, "test")

    def test_end_not_greater_than_start_raises(self):
        clip = _valid_clip()
        clip["end"] = clip["start"]
        with pytest.raises(ValueError, match="end.*must be > start"):
            _validate_clip(clip, "test")

    def test_duration_mismatch_end_minus_start_auto_corrects(self):
        # Duration mismatch is auto-corrected with a warning, not raised
        clip = _valid_clip()
        clip["duration"] = 9999  # wrong
        _validate_clip(clip, "test")  # should not raise
        assert clip["duration"] == clip["end"] - clip["start"]

    def test_duration_mismatch_outpoint_minus_inpoint_auto_corrects(self):
        clip = _valid_clip(start=0, end=5000, in_point=0, out_point=5000)
        clip["outPoint"] = 6000  # now outPoint - inPoint != duration
        _validate_clip(clip, "test")  # should not raise — outPoint is auto-corrected


# ---------------------------------------------------------------------------
# _validate_no_overlapping_clips
# ---------------------------------------------------------------------------

class TestValidateNoOverlappingClips:
    def test_no_clips_passes(self):
        _validate_no_overlapping_clips([], "track")

    def test_single_clip_passes(self):
        _validate_no_overlapping_clips([_valid_clip()], "track")

    def test_non_overlapping_clips_pass(self):
        clips = [
            _valid_clip(0, 5000, 0, 5000),
            _valid_clip(5000, 10000, 0, 5000),
        ]
        _validate_no_overlapping_clips(clips, "track")

    def test_overlapping_clips_raise(self):
        clips = [
            _valid_clip(0, 6000, 0, 6000),
            _valid_clip(5000, 10000, 0, 5000),
        ]
        with pytest.raises(ValueError, match="overlaps"):
            _validate_no_overlapping_clips(clips, "track")

    def test_out_of_order_clips_sorted_before_check(self):
        clips = [
            _valid_clip(5000, 10000, 0, 5000),
            _valid_clip(0, 5000, 0, 5000),
        ]
        _validate_no_overlapping_clips(clips, "track")  # should pass after sorting


# ---------------------------------------------------------------------------
# _validate_timeline_assembly
# ---------------------------------------------------------------------------

class TestValidateTimelineAssembly:
    def test_valid_assembly_passes(self):
        _validate_timeline_assembly(_valid_assembly())

    def test_empty_tracks_passes(self):
        data = _valid_assembly()
        for track in data["sequenceDetails"]["tracks"]:
            track["clips"] = []
        _validate_timeline_assembly(data)

    def test_missing_timelineItemId_raises(self):
        data = _valid_assembly()
        del data["timelineItemId"]
        with pytest.raises(ValueError, match="missing required keys"):
            _validate_timeline_assembly(data)

    def test_empty_timelineItemId_raises(self):
        data = _valid_assembly()
        data["timelineItemId"] = ""
        with pytest.raises(ValueError, match="non-empty string"):
            _validate_timeline_assembly(data)

    def test_missing_summary_raises(self):
        data = _valid_assembly()
        del data["summary"]
        with pytest.raises(ValueError, match="missing required keys"):
            _validate_timeline_assembly(data)

    def test_summary_missing_clipCount_raises(self):
        data = _valid_assembly()
        del data["summary"]["clipCount"]
        with pytest.raises(ValueError, match="summary missing required keys"):
            _validate_timeline_assembly(data)

    def test_missing_sequenceDetails_raises(self):
        data = _valid_assembly()
        del data["sequenceDetails"]
        with pytest.raises(ValueError, match="missing required keys"):
            _validate_timeline_assembly(data)

    def test_sequenceDetails_missing_tracks_raises(self):
        data = _valid_assembly()
        data["sequenceDetails"] = {}
        with pytest.raises(ValueError, match="tracks array"):
            _validate_timeline_assembly(data)

    def test_track_missing_id_raises(self):
        data = _valid_assembly()
        del data["sequenceDetails"]["tracks"][0]["id"]
        with pytest.raises(ValueError, match="missing required key: id"):
            _validate_timeline_assembly(data)

    def test_track_invalid_mediaType_raises(self):
        data = _valid_assembly()
        data["sequenceDetails"]["tracks"][0]["mediaType"] = "subtitle"
        with pytest.raises(ValueError, match="mediaType must be"):
            _validate_timeline_assembly(data)

    def test_overlapping_clips_on_track_raises(self):
        data = _valid_assembly()
        data["sequenceDetails"]["tracks"][0]["clips"] = [
            _valid_clip(0, 10000, 0, 10000),
            _valid_clip(5000, 15000, 0, 10000),  # overlaps
        ]
        with pytest.raises(ValueError, match="overlaps"):
            _validate_timeline_assembly(data)


# ---------------------------------------------------------------------------
# run_timeline_assembly — integration with mocked Agent
# ---------------------------------------------------------------------------

class TestRunTimelineAssembly:
    """Tests for run_timeline_assembly with a mocked Strands Agent."""

    @patch("rough_cut_agent._save_artifact")
    @patch("rough_cut_agent.update_story_status")
    @patch("rough_cut_agent.create_timeline")
    @patch("rough_cut_agent.send_task_success")
    @patch("rough_cut_agent.send_task_failure")
    @patch("rough_cut_agent.Agent")
    @patch("rough_cut_agent.BedrockModel")
    def test_returns_valid_assembly(self, mock_bedrock_cls, mock_agent_cls, mock_fail, mock_success, mock_create, mock_update, mock_save):
        valid = _valid_assembly()
        agent_instance = MagicMock()
        agent_instance.return_value = json.dumps(valid)
        mock_agent_cls.return_value = agent_instance
        mock_create.return_value = json.dumps({"id": "timeline-001"})

        result = run_timeline_assembly(
            _valid_script_analysis(), _valid_source_material(),
            "story-1", "Fire Story", "token-abc",
        )

        assert result["timelineItemId"] == "timeline-001"
        assert "sequenceDetails" in result
        mock_success.assert_called_once()
        mock_fail.assert_not_called()
        mock_create.assert_called_once()

    @patch("rough_cut_agent._save_artifact")
    @patch("rough_cut_agent.update_story_status")
    @patch("rough_cut_agent.create_timeline")
    @patch("rough_cut_agent.send_task_success")
    @patch("rough_cut_agent.send_task_failure")
    @patch("rough_cut_agent.Agent")
    @patch("rough_cut_agent.BedrockModel")
    def test_agent_created_with_correct_tools(self, mock_bedrock_cls, mock_agent_cls, mock_fail, mock_success, mock_create, mock_update, mock_save):
        valid = _valid_assembly()
        agent_instance = MagicMock()
        agent_instance.return_value = json.dumps(valid)
        mock_agent_cls.return_value = agent_instance
        mock_create.return_value = json.dumps({"id": "timeline-001"})

        run_timeline_assembly(
            _valid_script_analysis(), _valid_source_material(),
            "story-1", "Fire Story", "token-abc",
        )

        call_kwargs = mock_agent_cls.call_args.kwargs
        assert "tools" in call_kwargs
        assert len(call_kwargs["tools"]) == 0  # zero-tool agent — just produces JSON
        assert call_kwargs["system_prompt"] is not None

    @patch("rough_cut_agent._save_artifact")
    @patch("rough_cut_agent.update_story_status")
    @patch("rough_cut_agent.create_timeline")
    @patch("rough_cut_agent.send_task_success")
    @patch("rough_cut_agent.send_task_failure")
    @patch("rough_cut_agent.Agent")
    @patch("rough_cut_agent.BedrockModel")
    def test_handles_markdown_fenced_json(self, mock_bedrock_cls, mock_agent_cls, mock_fail, mock_success, mock_create, mock_update, mock_save):
        valid = _valid_assembly()
        fenced = f"```json\n{json.dumps(valid)}\n```"
        agent_instance = MagicMock()
        agent_instance.return_value = fenced
        mock_agent_cls.return_value = agent_instance
        mock_create.return_value = json.dumps({"id": "timeline-001"})

        result = run_timeline_assembly(
            _valid_script_analysis(), _valid_source_material(),
            "story-1", "Fire Story", "token-abc",
        )
        assert result["timelineItemId"] == "timeline-001"

    @patch("rough_cut_agent._save_artifact")
    @patch("rough_cut_agent.update_story_status")
    @patch("rough_cut_agent.create_timeline")
    @patch("rough_cut_agent.send_task_success")
    @patch("rough_cut_agent.send_task_failure")
    @patch("rough_cut_agent.Agent")
    @patch("rough_cut_agent.BedrockModel")
    def test_raises_on_invalid_json_and_sends_failure(self, mock_bedrock_cls, mock_agent_cls, mock_fail, mock_success, mock_create, mock_update, mock_save):
        agent_instance = MagicMock()
        agent_instance.return_value = "not valid json"
        mock_agent_cls.return_value = agent_instance

        with pytest.raises(ValueError, match="invalid JSON"):
            run_timeline_assembly(
                _valid_script_analysis(), _valid_source_material(),
                "story-1", "Fire Story", "token-abc",
            )

        mock_fail.assert_called_once()
        assert mock_fail.call_args.kwargs["task_token"] == "token-abc"
        assert mock_fail.call_args.kwargs["error"] == "TimelineAssemblyError"
        mock_success.assert_not_called()

    @patch("rough_cut_agent._save_artifact")
    @patch("rough_cut_agent.update_story_status")
    @patch("rough_cut_agent.create_timeline")
    @patch("rough_cut_agent.send_task_success")
    @patch("rough_cut_agent.send_task_failure")
    @patch("rough_cut_agent.Agent")
    @patch("rough_cut_agent.BedrockModel")
    def test_raises_on_missing_sequenceDetails(self, mock_bedrock_cls, mock_agent_cls, mock_fail, mock_success, mock_create, mock_update, mock_save):
        incomplete = {"summary": {"clipCount": 0}}  # missing sequenceDetails
        agent_instance = MagicMock()
        agent_instance.return_value = json.dumps(incomplete)
        mock_agent_cls.return_value = agent_instance

        with pytest.raises(ValueError):
            run_timeline_assembly(
                _valid_script_analysis(), _valid_source_material(),
                "story-1", "Fire Story", "token-abc",
            )

        mock_fail.assert_called_once()
        mock_success.assert_not_called()

    @patch("rough_cut_agent._save_artifact")
    @patch("rough_cut_agent.update_story_status")
    @patch("rough_cut_agent.create_timeline")
    @patch("rough_cut_agent.send_task_success")
    @patch("rough_cut_agent.send_task_failure")
    @patch("rough_cut_agent.Agent")
    @patch("rough_cut_agent.BedrockModel")
    def test_user_message_contains_story_info(self, mock_bedrock_cls, mock_agent_cls, mock_fail, mock_success, mock_create, mock_update, mock_save):
        valid = _valid_assembly()
        agent_instance = MagicMock()
        agent_instance.return_value = json.dumps(valid)
        mock_agent_cls.return_value = agent_instance
        mock_create.return_value = json.dumps({"id": "timeline-001"})

        run_timeline_assembly(
            _valid_script_analysis(), _valid_source_material(),
            "story-42", "Big Fire Story", "token-abc",
        )

        user_msg = agent_instance.call_args[0][0]
        assert "story-42" in user_msg
        assert "Big Fire Story" in user_msg
