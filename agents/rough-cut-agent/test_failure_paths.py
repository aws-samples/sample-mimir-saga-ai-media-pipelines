"""Failure paths: every run gets a Step Functions callback, and a transient
error on the model check does not switch models.

No AWS or model calls: the Step Functions and Bedrock clients are mocked.
"""

import os
import sys
from unittest.mock import MagicMock, patch

import botocore.exceptions

os.environ.setdefault("AWS_DEFAULT_REGION", "us-east-1")
sys.modules.setdefault("prompts", MagicMock())

import rough_cut_agent as rca  # noqa: E402


def _client_error(code):
    return botocore.exceptions.ClientError({"Error": {"Code": code, "Message": "x"}}, "Converse")


class TestFailureCallback:
    def test_error_outside_a_stage_sends_task_failure(self):
        sfn = MagicMock()
        with patch.object(rca, "stepfunctions", sfn), \
                patch.object(rca, "get_profile", side_effect=KeyError("profiles")):
            result = rca.invoke({"task_token": "tok-outer", "storyContext": {"story": {"mId": "S"}}})
        assert result["status"] == "error"
        sfn.send_task_failure.assert_called_once()
        kwargs = sfn.send_task_failure.call_args.kwargs
        assert kwargs["taskToken"] == "tok-outer"
        assert kwargs["error"] == "RoughCutAgentError"
        assert "KeyError" in kwargs["cause"]

    def test_stage_failure_is_not_reported_twice(self):
        sfn = MagicMock()
        with patch.object(rca, "stepfunctions", sfn):
            # Missing story: invoke() sends PayloadValidationError itself.
            rca.invoke({"task_token": "tok-stage", "storyContext": {}})
        assert sfn.send_task_failure.call_count == 1
        assert sfn.send_task_failure.call_args.kwargs["error"] == "PayloadValidationError"


class TestModelCheck:
    def _model_for(self, exc, monkeypatch):
        monkeypatch.setenv("AGENT_MODEL_ID", "us.anthropic.claude-sonnet-4-6")
        client = MagicMock()
        client.converse.side_effect = exc
        with patch.object(rca.boto3, "client", return_value=client), \
                patch.object(rca, "BedrockModel") as model_cls:
            rca._get_bedrock_model()
        return model_cls.call_args.kwargs

    def test_throttling_keeps_the_configured_model(self, monkeypatch):
        kwargs = self._model_for(_client_error("ThrottlingException"), monkeypatch)
        assert kwargs["model_id"] == "us.anthropic.claude-sonnet-4-6"
        assert kwargs["max_tokens"] == rca._CLAUDE_MAX_TOKENS

    def test_read_timeout_keeps_the_configured_model(self, monkeypatch):
        kwargs = self._model_for(botocore.exceptions.ReadTimeoutError(endpoint_url="https://x"), monkeypatch)
        assert kwargs["model_id"] == "us.anthropic.claude-sonnet-4-6"

    def test_retired_model_falls_back(self, monkeypatch):
        kwargs = self._model_for(_client_error("ResourceNotFoundException"), monkeypatch)
        assert kwargs["model_id"] == rca._DEFAULT_MODEL_ID
