"""Unit tests for run_script_analysis and _validate_script_analysis.

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

# Set a default AWS region so boto3.client() doesn't fail at import time
os.environ.setdefault("AWS_DEFAULT_REGION", "us-east-1")

# strands
_mock_strands = MagicMock()
sys.modules.setdefault("strands", _mock_strands)
sys.modules.setdefault("strands.models", MagicMock())

# bedrock_agentcore
_mock_agentcore = MagicMock()
sys.modules.setdefault("bedrock_agentcore", _mock_agentcore)
sys.modules.setdefault("bedrock_agentcore.runtime", MagicMock())

# prompts module (sibling file)
_mock_prompts = MagicMock()
_mock_prompts.SCRIPT_ANALYSIS_PROMPT = "You are a Script Analysis Agent..."
sys.modules.setdefault("prompts", _mock_prompts)

# Now import the module under test
from rough_cut_agent import _validate_script_analysis, run_script_analysis

# ---------------------------------------------------------------------------
# Stub external SDKs that are imported at module level so the test can run
# without installing strands-agents, bedrock-agentcore, etc.
# ---------------------------------------------------------------------------

# strands
_mock_strands = MagicMock()
sys.modules.setdefault("strands", _mock_strands)
sys.modules.setdefault("strands.models", MagicMock())

# bedrock_agentcore
_mock_agentcore = MagicMock()
sys.modules.setdefault("bedrock_agentcore", _mock_agentcore)
sys.modules.setdefault("bedrock_agentcore.runtime", MagicMock())

# prompts module (sibling file)
_mock_prompts = MagicMock()
_mock_prompts.SCRIPT_ANALYSIS_PROMPT = "You are a Script Analysis Agent..."
sys.modules.setdefault("prompts", _mock_prompts)

# Now import the module under test
from rough_cut_agent import _validate_script_analysis, run_script_analysis


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _valid_analysis() -> dict:
    """Return a minimal valid ScriptAnalysis dict."""
    return {
        "scriptFormat": "broadcast_script",
        "parsedSections": [
            {
                "sectionType": "pkg_vo",
                "content": "A local fire broke out early this morning.",
                "orderIndex": 0,
                "estimatedDurationMs": 17000,
            },
            {
                "sectionType": "pkg_sot",
                "content": "Fire Chief: We had it under control quickly.",
                "orderIndex": 1,
                "estimatedDurationMs": 4000,
                "timecodeSeconds": 60,
                "speaker": "Fire Chief",
                "quotedText": "We had it under control quickly.",
            },
        ],
        "totalEstimatedDurationMs": 21000,
        "lead": {
            "content": "A local fire broke out early this morning.",
            "hookType": "breaking_news",
            "estimatedDurationMs": 17000,
        },
        "body": {
            "mainPoints": [
                {
                    "content": "Firefighters responded within minutes.",
                    "supportingElements": ["3 trucks deployed"],
                    "narrativeFunction": "establishes response",
                }
            ]
        },
        "wrapUp": {
            "content": "No injuries were reported.",
            "closureType": "resolution",
        },
        "soundbites": [
            {
                "speaker": "Fire Chief",
                "content": "We had it under control quickly.",
                "estimatedDurationMs": 4000,
            }
        ],
        "interviewSegments": [
            {"speaker": "Witness", "topic": "Eyewitness account"}
        ],
        "voiceOverSections": [
            {"content": "Narration over B-roll.", "narrativePosition": "body"}
        ],
    }


# ---------------------------------------------------------------------------
# _validate_script_analysis — happy path
# ---------------------------------------------------------------------------

class TestValidateScriptAnalysis:
    def test_valid_analysis_passes(self):
        _validate_script_analysis(_valid_analysis())  # should not raise

    def test_empty_arrays_are_valid(self):
        data = _valid_analysis()
        data["soundbites"] = []
        data["interviewSegments"] = []
        data["voiceOverSections"] = []
        _validate_script_analysis(data)  # should not raise

    # --- missing top-level keys ---

    def test_missing_lead_raises(self):
        data = _valid_analysis()
        del data["lead"]
        with pytest.raises(ValueError, match="missing required keys"):
            _validate_script_analysis(data)

    def test_missing_body_raises(self):
        data = _valid_analysis()
        del data["body"]
        with pytest.raises(ValueError, match="missing required keys"):
            _validate_script_analysis(data)

    def test_missing_wrapUp_raises(self):
        data = _valid_analysis()
        del data["wrapUp"]
        with pytest.raises(ValueError, match="missing required keys"):
            _validate_script_analysis(data)

    # --- lead sub-field validation ---

    def test_lead_missing_hookType_raises(self):
        data = _valid_analysis()
        del data["lead"]["hookType"]
        with pytest.raises(ValueError, match="lead missing required key"):
            _validate_script_analysis(data)

    def test_lead_not_dict_raises(self):
        data = _valid_analysis()
        data["lead"] = "not a dict"
        with pytest.raises(ValueError, match="lead must be an object"):
            _validate_script_analysis(data)

    # --- body sub-field validation ---

    def test_body_missing_mainPoints_raises(self):
        data = _valid_analysis()
        data["body"] = {"other": "stuff"}
        with pytest.raises(ValueError, match="mainPoints"):
            _validate_script_analysis(data)

    def test_body_mainPoints_not_list_raises(self):
        data = _valid_analysis()
        data["body"]["mainPoints"] = "not a list"
        with pytest.raises(ValueError, match="mainPoints must be an array"):
            _validate_script_analysis(data)

    # --- wrapUp sub-field validation ---

    def test_wrapUp_missing_closureType_raises(self):
        data = _valid_analysis()
        del data["wrapUp"]["closureType"]
        with pytest.raises(ValueError, match="wrapUp missing required key"):
            _validate_script_analysis(data)

    # --- array fields must be lists ---

    def test_soundbites_not_list_raises(self):
        data = _valid_analysis()
        data["soundbites"] = "not a list"
        with pytest.raises(ValueError, match="soundbites must be an array"):
            _validate_script_analysis(data)

    def test_interviewSegments_not_list_raises(self):
        data = _valid_analysis()
        data["interviewSegments"] = 42
        with pytest.raises(ValueError, match="interviewSegments must be an array"):
            _validate_script_analysis(data)

    def test_voiceOverSections_not_list_raises(self):
        data = _valid_analysis()
        data["voiceOverSections"] = {}
        with pytest.raises(ValueError, match="voiceOverSections must be an array"):
            _validate_script_analysis(data)


# ---------------------------------------------------------------------------
# run_script_analysis — integration with mocked Agent
# ---------------------------------------------------------------------------

class TestRunScriptAnalysis:
    """Tests for run_script_analysis with a mocked Strands Agent."""

    def _mock_agent_returning(self, analysis_dict: dict):
        """Return patch objects that make Agent() return *analysis_dict* as JSON."""
        agent_instance = MagicMock()
        agent_instance.return_value = json.dumps(analysis_dict)
        return agent_instance

    @patch("rough_cut_agent.Agent")
    @patch("rough_cut_agent.BedrockModel")
    def test_returns_valid_analysis(self, mock_bedrock_cls, mock_agent_cls):
        valid = _valid_analysis()
        agent_instance = self._mock_agent_returning(valid)
        mock_agent_cls.return_value = agent_instance

        result = run_script_analysis({
            "title": "Fire Story",
            "description": "A fire broke out.",
            "script": "The fire started at dawn.",
            "notes": [{"type": "editorial", "content": "Emphasise response time."}],
        })

        assert result == valid
        # Agent was created with the correct prompt
        mock_agent_cls.assert_called_once()
        call_kwargs = mock_agent_cls.call_args
        assert call_kwargs.kwargs["system_prompt"] is not None

    @patch("rough_cut_agent.Agent")
    @patch("rough_cut_agent.BedrockModel")
    def test_handles_markdown_fenced_json(self, mock_bedrock_cls, mock_agent_cls):
        valid = _valid_analysis()
        fenced = f"```json\n{json.dumps(valid)}\n```"
        agent_instance = MagicMock()
        agent_instance.return_value = fenced
        mock_agent_cls.return_value = agent_instance

        result = run_script_analysis({"title": "T", "description": "", "script": "", "notes": []})
        assert result == valid

    @patch("rough_cut_agent.Agent")
    @patch("rough_cut_agent.BedrockModel")
    def test_raises_on_invalid_json(self, mock_bedrock_cls, mock_agent_cls):
        agent_instance = MagicMock()
        agent_instance.return_value = "this is not json"
        mock_agent_cls.return_value = agent_instance

        with pytest.raises(ValueError, match="invalid JSON"):
            run_script_analysis({"title": "T", "description": "", "script": "", "notes": []})

    @patch("rough_cut_agent.Agent")
    @patch("rough_cut_agent.BedrockModel")
    def test_raises_on_schema_violation(self, mock_bedrock_cls, mock_agent_cls):
        incomplete = {"lead": {"content": "x"}}  # missing many fields
        agent_instance = MagicMock()
        agent_instance.return_value = json.dumps(incomplete)
        mock_agent_cls.return_value = agent_instance

        with pytest.raises(ValueError):
            run_script_analysis({"title": "T", "description": "", "script": "", "notes": []})

    @patch("rough_cut_agent.Agent")
    @patch("rough_cut_agent.BedrockModel")
    def test_empty_notes_handled(self, mock_bedrock_cls, mock_agent_cls):
        valid = _valid_analysis()
        agent_instance = self._mock_agent_returning(valid)
        mock_agent_cls.return_value = agent_instance

        result = run_script_analysis({"title": "T", "description": "D", "script": "S", "notes": []})
        assert result == valid

    @patch("rough_cut_agent.Agent")
    @patch("rough_cut_agent.BedrockModel")
    def test_missing_context_keys_default_to_empty(self, mock_bedrock_cls, mock_agent_cls):
        valid = _valid_analysis()
        agent_instance = self._mock_agent_returning(valid)
        mock_agent_cls.return_value = agent_instance

        # Pass an empty dict — all keys should default gracefully
        result = run_script_analysis({})
        assert result == valid
