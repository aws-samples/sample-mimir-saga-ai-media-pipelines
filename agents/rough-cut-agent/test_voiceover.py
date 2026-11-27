"""Unit tests for the shared Amazon Polly voice-over helper in tools.py.

Covers engine/voice configuration from the environment, the fallback to neural
Matthew when Polly rejects the engine/voice pair, and request chunking at the
3,000-character SynthesizeSpeech limit.
"""

import io
import os
import sys
from unittest.mock import MagicMock, patch

import pytest

os.environ.setdefault("AWS_DEFAULT_REGION", "us-east-1")
sys.modules.setdefault("strands", MagicMock())
sys.modules.setdefault("strands.models", MagicMock())
sys.modules.setdefault("boto3", MagicMock())

import tools  # noqa: E402


class _ValidationError(Exception):
    response = {"Error": {"Code": "ValidationException"}}


def _polly(side_effect=None):
    client = MagicMock()
    client.synthesize_speech.side_effect = side_effect or (
        lambda **kw: {"AudioStream": io.BytesIO(b"mp3")}
    )
    boto3 = MagicMock()
    boto3.client.return_value = client
    return boto3, client


@pytest.fixture(autouse=True)
def _clear_env(monkeypatch):
    monkeypatch.delenv("POLLY_ENGINE", raising=False)
    monkeypatch.delenv("POLLY_VOICE_ID", raising=False)


def test_defaults_to_generative_stephen():
    assert tools.polly_voice_config() == ("generative", "Stephen")


def test_reads_engine_and_voice_from_env(monkeypatch):
    monkeypatch.setenv("POLLY_ENGINE", "Long-Form")
    monkeypatch.setenv("POLLY_VOICE_ID", "Gregory")
    boto3, client = _polly()
    with patch.object(tools, "boto3", boto3):
        assert tools.synthesize_speech_mp3("Hello.") == b"mp3"
    kwargs = client.synthesize_speech.call_args.kwargs
    assert (kwargs["Engine"], kwargs["VoiceId"], kwargs["OutputFormat"]) == ("long-form", "Gregory", "mp3")


def test_unknown_engine_uses_neural(monkeypatch):
    monkeypatch.setenv("POLLY_ENGINE", "ultra")
    assert tools.polly_voice_config()[0] == "neural"


def test_falls_back_to_neural_matthew_on_validation_error(monkeypatch):
    monkeypatch.setenv("POLLY_VOICE_ID", "Patrick")  # long-form only, no generative variant

    def _synth(**kw):
        if kw["Engine"] == "generative":
            raise _ValidationError("This voice does not support the selected engine")
        return {"AudioStream": io.BytesIO(b"fallback")}

    boto3, client = _polly(_synth)
    with patch.object(tools, "boto3", boto3):
        assert tools.synthesize_speech_mp3("Hello.") == b"fallback"
    last = client.synthesize_speech.call_args.kwargs
    assert (last["Engine"], last["VoiceId"]) == ("neural", "Matthew")


def test_other_errors_are_raised():
    boto3, _ = _polly(RuntimeError("throttled"))
    with patch.object(tools, "boto3", boto3), pytest.raises(RuntimeError):
        tools.synthesize_speech_mp3("Hello.")


def test_long_text_is_split_at_sentences_and_joined():
    sentence = "Crews worked through the night to reopen the highway. "
    text = sentence * 80  # ~4,300 chars
    chunks = tools._chunk_for_polly(text)
    assert len(chunks) == 2
    assert all(len(c) <= 3000 and c.endswith(".") for c in chunks)
    assert " ".join(chunks) == text.strip()

    boto3, client = _polly()
    with patch.object(tools, "boto3", boto3):
        assert tools.synthesize_speech_mp3(text) == b"mp3mp3"
    assert client.synthesize_speech.call_count == 2


def test_run_on_sentence_is_hard_split():
    chunks = tools._chunk_for_polly("word " * 1000)  # 5,000 chars, no sentence break
    assert all(0 < len(c) <= 3000 for c in chunks)
    assert " ".join(chunks).split() == ["word"] * 1000
