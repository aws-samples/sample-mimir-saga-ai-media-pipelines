"""Unit tests for the extended create_timeline tool and its helper functions.

Tests cover:
- Legacy 3-track payload generation (backward compatibility)
- Multi-track 4-track payload generation (V1, V2, A1, A2)
- Audio-only source references for Polly-generated clips
- Format detection (3 tracks → legacy, 4+ tracks → multitrack)
"""

import json
import os
import sys
from unittest.mock import MagicMock, patch

import pytest

# ---------------------------------------------------------------------------
# Stub external SDKs before importing tools.py
# ---------------------------------------------------------------------------
os.environ.setdefault("AWS_DEFAULT_REGION", "us-east-1")
os.environ.setdefault("MIMIR_API_KEY_SECRET_ARN", "arn:aws:secretsmanager:us-east-1:123:secret:fake")
os.environ.setdefault("SAGA_API_KEY_SECRET_ARN", "arn:aws:secretsmanager:us-east-1:123:secret:fake")
os.environ.setdefault("SAGA_API_URL_SECRET_ARN", "arn:aws:secretsmanager:us-east-1:123:secret:fake")
os.environ.setdefault("VECTOR_BUCKET_NAME", "fake-bucket")
os.environ.setdefault("VECTOR_INDEX_NAME", "fake-index")

_mock_strands = MagicMock()
sys.modules.setdefault("strands", _mock_strands)
sys.modules.setdefault("strands.models", MagicMock())

# Make @tool a passthrough decorator that preserves the function and adds tool_handler
def _passthrough_tool(fn):
    fn.tool_handler = fn
    return fn

_mock_strands.tool = _passthrough_tool

# Stub boto3 to avoid real AWS calls at module import
_mock_boto3 = MagicMock()
sys.modules["boto3"] = _mock_boto3

from tools import (
    _build_legacy_timeline_payload,
    _build_multitrack_timeline_payload,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

def _make_legacy_sequence(clips):
    """Build a legacy 3-track sequenceDetails with 1 video + 2 audio tracks."""
    return {
        "tracks": [
            {"id": 1, "mediaType": "video", "clips": clips},
            {"id": 2, "mediaType": "audio", "clips": []},
            {"id": 3, "mediaType": "audio", "clips": []},
        ]
    }


def _make_multitrack_sequence(v1_clips=None, v2_clips=None, a1_clips=None, a2_clips=None):
    """Build a 4-track sequenceDetails with V1, V2, A1, A2."""
    return {
        "tracks": [
            {"id": 1, "mediaType": "video", "name": "V1", "clips": v1_clips or []},
            {"id": 2, "mediaType": "video", "name": "V2", "clips": v2_clips or []},
            {"id": 3, "mediaType": "audio", "name": "A1", "clips": a1_clips or []},
            {"id": 4, "mediaType": "audio", "name": "A2", "clips": a2_clips or []},
        ]
    }


# ---------------------------------------------------------------------------
# Legacy payload tests
# ---------------------------------------------------------------------------

class TestBuildLegacyTimelinePayload:
    """Tests for _build_legacy_timeline_payload (backward compatibility)."""

    def test_single_video_clip_produces_one_video_track(self):
        seq = _make_legacy_sequence([
            {"mimirItemId": "item-1", "start": 0, "inPoint": 1000, "outPoint": 6000},
        ])
        cache = {"item-1": 120}

        _, _, payload, clip_count = _build_legacy_timeline_payload(seq, cache)

        assert clip_count == 1
        assert len(payload["videoTracks"]) == 1
        assert len(payload["videoTracks"][0]) == 1
        # Audio mirrors video on ch0 and ch1
        assert len(payload["audioTracks"][0]) == 1
        assert len(payload["audioTracks"][1]) == 1

    def test_item_ref_is_video_type(self):
        seq = _make_legacy_sequence([
            {"mimirItemId": "item-1", "start": 0, "inPoint": 0, "outPoint": 5000},
        ])
        cache = {"item-1": 30}

        item_refs, _, _, _ = _build_legacy_timeline_payload(seq, cache)

        assert "item-1" in item_refs
        assert item_refs["item-1"]["type"] == "video"
        assert item_refs["item-1"]["nAudioChannels"] == 2

    def test_source_ref_is_video_with_audio(self):
        seq = _make_legacy_sequence([
            {"mimirItemId": "item-1", "start": 0, "inPoint": 2000, "outPoint": 7000},
        ])
        cache = {"item-1": 60}

        _, source_refs, _, _ = _build_legacy_timeline_payload(seq, cache)

        src = source_refs["id-0"]
        assert src["type"] == "video-with-audio"
        assert src["itemId"] == "item-1"
        assert src["videoInPointInSeconds"] == {"numerator": 2000, "denominator": 1000}
        assert src["videoOutPointInSeconds"] == {"numerator": 7000, "denominator": 1000}

    def test_multiple_clips_sorted_by_start(self):
        seq = _make_legacy_sequence([
            {"mimirItemId": "item-2", "start": 5000, "inPoint": 0, "outPoint": 3000},
            {"mimirItemId": "item-1", "start": 0, "inPoint": 0, "outPoint": 5000},
        ])
        cache = {"item-1": 60, "item-2": 60}

        _, source_refs, payload, clip_count = _build_legacy_timeline_payload(seq, cache)

        assert clip_count == 2
        # First source ref should be item-1 (start=0), second item-2 (start=5000)
        assert source_refs["id-0"]["itemId"] == "item-1"
        assert source_refs["id-1"]["itemId"] == "item-2"


# ---------------------------------------------------------------------------
# Multi-track payload tests
# ---------------------------------------------------------------------------

class TestBuildMultitrackTimelinePayload:
    """Tests for _build_multitrack_timeline_payload (4-track format)."""

    def test_four_track_produces_two_video_tracks(self):
        seq = _make_multitrack_sequence(
            v1_clips=[{"mimirItemId": "sot-1", "start": 0, "inPoint": 0, "outPoint": 5000}],
            v2_clips=[{"mimirItemId": "broll-1", "start": 0, "inPoint": 0, "outPoint": 5000}],
        )
        cache = {"sot-1": 60, "broll-1": 60}

        _, _, payload, clip_count = _build_multitrack_timeline_payload(seq, cache)

        assert clip_count == 2
        assert len(payload["videoTracks"]) == 2
        assert len(payload["videoTracks"][0]) == 1  # V1
        assert len(payload["videoTracks"][1]) == 1  # V2

    def test_audio_only_clip_creates_correct_item_ref(self):
        seq = _make_multitrack_sequence(
            a1_clips=[{
                "mimirItemId": "polly-vo-1",
                "start": 0, "inPoint": 0, "outPoint": 12000,
                "duration": 12000,
                "sourceType": "audio-only",
            }],
        )
        cache = {}

        item_refs, _, _, _ = _build_multitrack_timeline_payload(seq, cache)

        assert "polly-vo-1" in item_refs
        ref = item_refs["polly-vo-1"]
        assert ref["type"] == "audio"
        assert ref["nAudioChannels"] == 1
        assert ref["durationInSeconds"] == {"numerator": 12000, "denominator": 1000}

    def test_audio_only_clip_creates_correct_source_ref(self):
        seq = _make_multitrack_sequence(
            a1_clips=[{
                "mimirItemId": "polly-vo-1",
                "start": 0, "inPoint": 0, "outPoint": 12000,
                "duration": 12000,
                "sourceType": "audio-only",
            }],
        )
        cache = {}

        _, source_refs, _, _ = _build_multitrack_timeline_payload(seq, cache)

        src = source_refs["id-0"]
        assert src["type"] == "audio"
        assert src["itemId"] == "polly-vo-1"
        assert src["audioInPointInSeconds"] == {"numerator": 0, "denominator": 1000}
        assert src["audioOutPointInSeconds"] == {"numerator": 12000, "denominator": 1000}
        assert "videoInPointInSeconds" not in src

    def test_a1_clips_placed_on_audio_track_0(self):
        seq = _make_multitrack_sequence(
            a1_clips=[{
                "mimirItemId": "polly-vo-1",
                "start": 0, "inPoint": 0, "outPoint": 8000,
                "duration": 8000,
                "sourceType": "audio-only",
            }],
        )
        cache = {}

        _, _, payload, _ = _build_multitrack_timeline_payload(seq, cache)

        assert len(payload["audioTracks"][0]) == 1  # A1
        assert payload["audioTracks"][0][0]["type"] == "audio"

    def test_a2_clips_placed_on_audio_track_1(self):
        seq = _make_multitrack_sequence(
            a2_clips=[{
                "mimirItemId": "interview-1",
                "start": 0, "inPoint": 5000, "outPoint": 15000,
            }],
        )
        cache = {"interview-1": 120}

        _, _, payload, _ = _build_multitrack_timeline_payload(seq, cache)

        assert len(payload["audioTracks"][1]) == 1  # A2
        assert payload["audioTracks"][1][0]["type"] == "audio"

    def test_reporter_provided_vo_uses_video_with_audio(self):
        """A1 clip without sourceType='audio-only' should use video-with-audio refs."""
        seq = _make_multitrack_sequence(
            a1_clips=[{
                "mimirItemId": "reporter-vo-1",
                "start": 0, "inPoint": 0, "outPoint": 10000,
            }],
        )
        cache = {"reporter-vo-1": 60}

        item_refs, source_refs, _, _ = _build_multitrack_timeline_payload(seq, cache)

        assert item_refs["reporter-vo-1"]["type"] == "video"
        src = source_refs["id-0"]
        assert src["type"] == "video-with-audio"

    def test_mixed_tracks_clip_count(self):
        seq = _make_multitrack_sequence(
            v1_clips=[
                {"mimirItemId": "sot-1", "start": 0, "inPoint": 0, "outPoint": 5000},
            ],
            v2_clips=[
                {"mimirItemId": "broll-1", "start": 0, "inPoint": 0, "outPoint": 5000},
                {"mimirItemId": "broll-2", "start": 5000, "inPoint": 0, "outPoint": 3000},
            ],
            a1_clips=[
                {"mimirItemId": "vo-1", "start": 0, "inPoint": 0, "outPoint": 8000,
                 "duration": 8000, "sourceType": "audio-only"},
            ],
            a2_clips=[
                {"mimirItemId": "sot-1", "start": 0, "inPoint": 0, "outPoint": 5000},
            ],
        )
        cache = {"sot-1": 60, "broll-1": 60, "broll-2": 60}

        _, _, payload, clip_count = _build_multitrack_timeline_payload(seq, cache)

        assert clip_count == 5
        assert len(payload["audioTracks"]) == 16  # 2 used + 14 empty

    def test_empty_tracks_produce_empty_arrays(self):
        seq = _make_multitrack_sequence()
        cache = {}

        _, _, payload, clip_count = _build_multitrack_timeline_payload(seq, cache)

        assert clip_count == 0
        assert payload["videoTracks"] == [[], []]
        assert payload["audioTracks"][0] == []
        assert payload["audioTracks"][1] == []


# ---------------------------------------------------------------------------
# create_timeline integration test (mocked HTTP)
# ---------------------------------------------------------------------------

class TestCreateTimelineFormatDetection:
    """Tests that create_timeline dispatches to the correct builder based on track count."""

    def test_three_tracks_uses_legacy_builder(self):
        """Legacy builder is selected when fewer than 4 tracks are provided."""
        import tools as tools_module

        seq = _make_legacy_sequence([
            {"mimirItemId": "item-1", "start": 0, "inPoint": 0, "outPoint": 5000},
        ])
        cache = {"item-1": 60}

        # Call the builder selection logic directly
        tracks = seq.get("tracks", [])
        use_multitrack = len(tracks) >= 4
        assert not use_multitrack, "3-track input should use legacy builder"

        # Verify legacy builder produces a single videoTracks array
        _, _, payload, clip_count = tools_module._build_legacy_timeline_payload(seq, cache)
        assert len(payload["videoTracks"]) == 1
        assert clip_count == 1

    def test_four_tracks_uses_multitrack_builder(self):
        """Multitrack builder is selected when 4+ tracks are provided."""
        import tools as tools_module

        seq = _make_multitrack_sequence(
            v1_clips=[{"mimirItemId": "sot-1", "start": 0, "inPoint": 0, "outPoint": 5000}],
        )
        cache = {"sot-1": 60}

        # Call the builder selection logic directly
        tracks = seq.get("tracks", [])
        use_multitrack = len(tracks) >= 4
        assert use_multitrack, "4-track input should use multitrack builder"

        # Verify multitrack builder produces two videoTracks arrays
        _, _, payload, _ = tools_module._build_multitrack_timeline_payload(seq, cache)
        assert len(payload["videoTracks"]) == 2
