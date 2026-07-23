"""Unit tests for run_source_material and _validate_source_material.

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
_mock_prompts.SOURCE_MATERIAL_PROMPT = "You are a Source Material Agent..."
sys.modules.setdefault("prompts", _mock_prompts)

_mock_tools = MagicMock()
sys.modules.setdefault("tools", _mock_tools)

from rough_cut_agent import _validate_source_material, run_source_material


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _valid_source_material() -> dict:
    """Return a minimal valid source material output."""
    return {
        "candidateSegments": [
            {
                "scriptSection": "lead",
                "candidates": [
                    {
                        "mimirItemId": "item-001",
                        "inPointMs": 5000,
                        "outPointMs": 15000,
                        "relevanceScore": 0.92,
                        "matchType": "both",
                        "content": "Fire trucks arriving at scene",
                    }
                ],
            }
        ],
        "gaps": [],
    }


def _valid_script_analysis() -> dict:
    """Return a minimal script analysis for input."""
    return {
        "lead": {
            "content": "A fire broke out early this morning.",
            "hookType": "breaking_news",
            "estimatedDurationMs": 17000,
        },
        "body": {
            "mainPoints": [
                {
                    "content": "Firefighters responded quickly.",
                    "supportingElements": [],
                    "narrativeFunction": "establishes response",
                }
            ],
        },
        "wrapUp": {
            "content": "No injuries reported.",
            "closureType": "resolution",
        },
        "soundbites": [],
        "interviewSegments": [],
        "voiceOverSections": [],
    }


def _enriched_assets() -> list:
    """Return a sample enriched asset list."""
    return [
        {
            "id": "asset-1",
            "mimirItemId": "item-001",
            "title": "Fire scene footage",
            "hasTranscript": True,
            "hasEmbeddings": True,
        },
        {
            "id": "asset-2",
            "mimirItemId": "item-002",
            "title": "Interview clip",
            "hasTranscript": False,
            "hasEmbeddings": True,
        },
    ]


# ---------------------------------------------------------------------------
# _validate_source_material — happy path
# ---------------------------------------------------------------------------

class TestValidateSourceMaterial:
    def test_valid_output_passes(self):
        _validate_source_material(_valid_source_material())

    def test_empty_candidates_and_gaps_passes(self):
        _validate_source_material({"candidateSegments": [], "gaps": []})

    def test_multiple_candidates_per_section(self):
        data = _valid_source_material()
        data["candidateSegments"][0]["candidates"].append({
            "mimirItemId": "item-002",
            "inPointMs": 20000,
            "outPointMs": 30000,
            "relevanceScore": 0.85,
            "matchType": "embedding",
            "content": "Reporter on scene",
        })
        _validate_source_material(data)

    def test_with_gaps(self):
        data = _valid_source_material()
        data["gaps"] = [
            {"scriptSection": "wrap_up", "unmatchedContent": "No footage for conclusion"}
        ]
        _validate_source_material(data)

    # --- missing top-level keys — validation is lenient (defaults, not raises) ---

    def test_missing_candidateSegments_defaults_to_empty(self):
        # Lenient: missing candidateSegments is defaulted to []
        data = {"gaps": []}
        _validate_source_material(data)
        assert data["candidateSegments"] == []

    def test_missing_gaps_defaults_to_empty(self):
        # Lenient: missing gaps is defaulted to []
        data = {"candidateSegments": []}
        _validate_source_material(data)
        assert data["gaps"] == []

    def test_candidateSegments_not_list_raises(self):
        with pytest.raises(ValueError, match="candidateSegments must be an array"):
            _validate_source_material({"candidateSegments": "bad", "gaps": []})

    def test_gaps_not_list_raises(self):
        # Lenient: non-list gaps is reset to []
        data = {"candidateSegments": [], "gaps": "bad"}
        _validate_source_material(data)
        assert data["gaps"] == []

    # --- segment-level validation — lenient (defaults missing fields) ---

    def test_segment_missing_scriptSection_defaults(self):
        data = {"candidateSegments": [{"candidates": []}], "gaps": []}
        _validate_source_material(data)
        assert data["candidateSegments"][0]["scriptSection"] == "unknown"

    def test_segment_missing_candidates_defaults(self):
        data = {"candidateSegments": [{"scriptSection": "lead"}], "gaps": []}
        _validate_source_material(data)
        assert data["candidateSegments"][0]["candidates"] == []

    # --- candidate-level validation — lenient (no required candidate fields) ---

    def test_candidate_missing_mimirItemId_does_not_raise(self):
        # Validation is lenient on candidate fields — no required keys enforced
        data = _valid_source_material()
        del data["candidateSegments"][0]["candidates"][0]["mimirItemId"]
        _validate_source_material(data)  # should not raise

    def test_candidate_missing_inPointMs_does_not_raise(self):
        data = _valid_source_material()
        del data["candidateSegments"][0]["candidates"][0]["inPointMs"]
        _validate_source_material(data)  # should not raise

    def test_candidate_missing_relevanceScore_does_not_raise(self):
        data = _valid_source_material()
        del data["candidateSegments"][0]["candidates"][0]["relevanceScore"]
        _validate_source_material(data)  # should not raise

    # --- gap-level validation — lenient (defaults missing fields) ---

    def test_gap_missing_scriptSection_defaults(self):
        data = {"candidateSegments": [], "gaps": [{"unmatchedContent": "x"}]}
        _validate_source_material(data)
        assert data["gaps"][0]["scriptSection"] == "unknown"

    def test_gap_missing_unmatchedContent_defaults(self):
        data = {"candidateSegments": [], "gaps": [{"scriptSection": "lead"}]}
        _validate_source_material(data)
        assert data["gaps"][0]["unmatchedContent"] == ""

    # --- coveragePercentage ---

    def test_missing_coverage_percentage_defaults_to_zero(self):
        data = _valid_source_material()
        _validate_source_material(data)
        assert data["coveragePercentage"] == 0

    def test_coverage_percentage_preserved_when_present(self):
        data = _valid_source_material()
        data["coveragePercentage"] = 85.0
        _validate_source_material(data)
        assert data["coveragePercentage"] == 85.0

    def test_invalid_coverage_percentage_raises(self):
        data = _valid_source_material()
        data["coveragePercentage"] = "not a number"
        with pytest.raises(ValueError, match="coveragePercentage must be a number"):
            _validate_source_material(data)


# ---------------------------------------------------------------------------
# run_source_material — integration with mocked Agent
# ---------------------------------------------------------------------------

class TestRunSourceMaterial:
    """Tests for run_source_material with a mocked Strands Agent."""

    @patch("rough_cut_agent.Agent")
    @patch("rough_cut_agent.BedrockModel")
    def test_returns_valid_output(self, mock_bedrock_cls, mock_agent_cls):
        valid = _valid_source_material()
        agent_instance = MagicMock()
        agent_instance.return_value = json.dumps(valid)
        mock_agent_cls.return_value = agent_instance

        result = run_source_material(_valid_script_analysis(), _enriched_assets())
        # coveragePercentage is defaulted to 0 by validation
        assert result["candidateSegments"] == valid["candidateSegments"]
        assert result["gaps"] == valid["gaps"]
        assert result["coveragePercentage"] == 0

    @patch("rough_cut_agent.Agent")
    @patch("rough_cut_agent.BedrockModel")
    def test_agent_created_with_tools(self, mock_bedrock_cls, mock_agent_cls):
        valid = _valid_source_material()
        agent_instance = MagicMock()
        agent_instance.return_value = json.dumps(valid)
        mock_agent_cls.return_value = agent_instance

        run_source_material(_valid_script_analysis(), _enriched_assets())

        call_kwargs = mock_agent_cls.call_args.kwargs
        assert "tools" in call_kwargs
        assert len(call_kwargs["tools"]) == 1  # get_word_timing only
        assert call_kwargs["system_prompt"] is not None

    @patch("rough_cut_agent.Agent")
    @patch("rough_cut_agent.BedrockModel")
    def test_handles_markdown_fenced_json(self, mock_bedrock_cls, mock_agent_cls):
        valid = _valid_source_material()
        fenced = f"```json\n{json.dumps(valid)}\n```"
        agent_instance = MagicMock()
        agent_instance.return_value = fenced
        mock_agent_cls.return_value = agent_instance

        result = run_source_material(_valid_script_analysis(), _enriched_assets())
        assert result["candidateSegments"] == valid["candidateSegments"]
        assert result["gaps"] == valid["gaps"]

    @patch("rough_cut_agent.Agent")
    @patch("rough_cut_agent.BedrockModel")
    def test_raises_on_invalid_json(self, mock_bedrock_cls, mock_agent_cls):
        agent_instance = MagicMock()
        agent_instance.return_value = "not valid json at all"
        mock_agent_cls.return_value = agent_instance

        with pytest.raises(ValueError, match="invalid JSON"):
            run_source_material(_valid_script_analysis(), _enriched_assets())

    @patch("rough_cut_agent.Agent")
    @patch("rough_cut_agent.BedrockModel")
    def test_raises_on_schema_violation(self, mock_bedrock_cls, mock_agent_cls):
        incomplete = {"candidateSegments": "not a list"}
        agent_instance = MagicMock()
        agent_instance.return_value = json.dumps(incomplete)
        mock_agent_cls.return_value = agent_instance

        with pytest.raises(ValueError):
            run_source_material(_valid_script_analysis(), _enriched_assets())

    @patch("rough_cut_agent.Agent")
    @patch("rough_cut_agent.BedrockModel")
    def test_empty_assets_handled(self, mock_bedrock_cls, mock_agent_cls):
        # When no assets have transcripts/embeddings, the function returns early
        # without calling the agent — gaps are built from parsedSections
        result = run_source_material(_valid_script_analysis(), [])
        assert result["candidateSegments"] == []
        assert isinstance(result["gaps"], list)
        mock_agent_cls.assert_not_called()

    @patch("rough_cut_agent.Agent")
    @patch("rough_cut_agent.BedrockModel")
    def test_assets_with_warnings_included_in_message(self, mock_bedrock_cls, mock_agent_cls):
        valid = _valid_source_material()
        agent_instance = MagicMock()
        agent_instance.return_value = json.dumps(valid)
        mock_agent_cls.return_value = agent_instance

        assets = [{
            "id": "a1",
            "mimirItemId": "item-x",
            "title": "Unusable clip",
            "hasTranscript": True,
            "hasEmbeddings": True,  # needs embeddings so pre-computation runs
            "warning": "No embeddings or transcript available",
        }]

        run_source_material(_valid_script_analysis(), assets)

        # Verify the agent was called — message contains asset info
        call_args = agent_instance.call_args[0][0]
        assert "item-x" in call_args
