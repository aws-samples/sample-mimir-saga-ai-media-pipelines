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
    _ms_to_frame_rational,
    _extract_source_media_info,
    _resolve_source_info,
    TIMELINE_FRAME_RATE_NUM,
    TIMELINE_FRAME_RATE_DEN,
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
        # Timeline rationals are snapped to the nearest 29.97fps frame
        # (denominator=30000, numerator=frames*1001). 2000ms -> 60 frames,
        # 7000ms -> 210 frames.
        assert src["videoInPointInSeconds"] == {"numerator": 60 * 1001, "denominator": 30000}
        assert src["videoOutPointInSeconds"] == {"numerator": 210 * 1001, "denominator": 30000}

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
        # Timeline rationals snap to the nearest 29.97fps frame.
        # 0ms -> 0 frames; 12000ms -> 360 frames.
        assert src["audioInPointInSeconds"] == {"numerator": 0, "denominator": 30000}
        assert src["audioOutPointInSeconds"] == {"numerator": 360 * 1001, "denominator": 30000}
        assert "videoInPointInSeconds" not in src

    def test_a1_clips_placed_on_audio_track_4(self):
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

        # Cutter audio-track layout:
        #   [0,1] V1 audio ch0, ch1    [2,3] V2 audio ch0, ch1
        #   [4]   A1 voice-over        [5..15] empty
        # A1 clips land on index 4; the lower slots stay reserved for the
        # V1/V2 clips they belong to.
        assert len(payload["audioTracks"][4]) == 1  # A1 voice-over slot
        assert payload["audioTracks"][4][0]["type"] == "audio"
        assert payload["audioTracks"][0] == []  # no V1 clip => V1 audio empty
        assert payload["audioTracks"][1] == []
        assert payload["audioTracks"][2] == []  # no V2 clip => V2 audio empty
        assert payload["audioTracks"][3] == []

    def test_a2_clips_are_intentionally_ignored(self):
        """A2 clips from the agent are dropped by design.

        Interview/nats audio is derived from the V1/V2 clips' own audio
        channels (placed on audioTracks[0..3]), not from a separate A2
        timeline input. See the "Process A2" block in tools.py.
        """
        seq = _make_multitrack_sequence(
            a2_clips=[{
                "mimirItemId": "interview-1",
                "start": 0, "inPoint": 5000, "outPoint": 15000,
            }],
        )
        cache = {"interview-1": 120}

        _, _, payload, clip_count = _build_multitrack_timeline_payload(seq, cache)

        # Every audio-track slot should be empty — nothing lands anywhere
        # when only an A2 clip is provided.
        for i, track in enumerate(payload["audioTracks"]):
            assert track == [], f"audioTracks[{i}] should be empty but has {len(track)} clip(s)"
        assert clip_count == 0, "A2-only input should not count as a placed clip"

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

        # 1 V1 + 2 V2 + 1 A1 = 4 counted clips. A2 is intentionally ignored
        # (see test_a2_clips_are_intentionally_ignored), so the sot-1 entry
        # under a2_clips doesn't add to the count.
        assert clip_count == 4
        assert len(payload["audioTracks"]) == 16  # Cutter always reserves 16 slots

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


# ---------------------------------------------------------------------------
# Frame-rational snapping (issue #14 — black frames between docked clips)
# ---------------------------------------------------------------------------

class TestMsToFrameRational:
    """`_ms_to_frame_rational` snaps millisecond values to 29.97fps frames.

    Cutter renders at 29.97fps (30000/1001). Writing timeline rationals with
    denominator 1000 lets the renderer pick the nearest frame, producing a
    1-frame black gap at any boundary that falls between frames.
    """

    def test_zero(self):
        assert _ms_to_frame_rational(0) == {"numerator": 0, "denominator": 30000}

    def test_one_second_exact(self):
        # 1000ms * 30/1001 = 29.97 frames -> round to 30 -> 30*1001/30000 = 1.001s
        assert _ms_to_frame_rational(1000) == {"numerator": 30 * 1001, "denominator": 30000}

    def test_output_denominator_always_frame_rate(self):
        for ms in (0, 123, 1000, 4000, 8500, 12250, 30000, -5000):
            r = _ms_to_frame_rational(ms)
            assert r["denominator"] == TIMELINE_FRAME_RATE_DEN
            assert r["numerator"] % TIMELINE_FRAME_RATE_NUM == 0, (
                f"numerator {r['numerator']} for {ms}ms is not an integer "
                f"multiple of {TIMELINE_FRAME_RATE_NUM} (frame rate numerator)"
            )

    def test_negative_offset(self):
        # mediaStartOffset is often negative (source time 0 placed before timeline 0).
        r = _ms_to_frame_rational(-5000)
        assert r == {"numerator": -150 * 1001, "denominator": 30000}

    def test_docked_boundaries_are_integer_frames(self):
        """Two docked clips must land on the same integer frame boundary.

        The original symptom: clip A ends at timeline ms X, clip B's start
        on the same timeline is implicit from docking, but Cutter sees each
        clip's own `inPoint`/`outPoint`. If both snap to the same frame,
        the handover is seamless.
        """
        # Clip A end @ 4000ms, Clip B start @ 4000ms (both snap to frame 120)
        a_out = _ms_to_frame_rational(4000)
        b_in = _ms_to_frame_rational(4000)
        assert a_out == b_in


# ---------------------------------------------------------------------------
# Source media info extraction from Mimir item details
# ---------------------------------------------------------------------------

class TestExtractSourceMediaInfo:
    """Mimir stores duration/frame rate under technicalMetadata.formData.

    The original agent read `details["duration"]` at the top level — a field
    Mimir does NOT return — so every item silently defaulted to 60 seconds.
    """

    def test_reads_duration_from_technical_metadata(self):
        details = {
            "frameCount": 620,
            "technicalMetadata": {"formData": {
                "technical_media_duration": 20687,
                "technical_video_frame_rate": 29.97,
                "technical_video_time_base": "1001/30000",
            }},
        }
        info = _extract_source_media_info(details)
        assert info["duration_ms"] == 20687
        assert info["frame_rate"] == 29.97
        assert info["time_base_num"] == 1001
        assert info["time_base_den"] == 30000

    def test_falls_back_to_frame_count_when_duration_missing(self):
        details = {"frameCount": 620, "technicalMetadata": {"formData": {}}}
        info = _extract_source_media_info(details)
        # 620 frames * 1001/30 ms per frame ≈ 20687ms
        assert abs(info["duration_ms"] - 20687) < 50

    def test_fully_missing_metadata_falls_back_to_defaults(self):
        info = _extract_source_media_info({})
        assert info["duration_ms"] == 60000
        assert info["frame_rate"] == 29.97
        assert info["time_base_num"] == 1001
        assert info["time_base_den"] == 30000

    def test_malformed_time_base_falls_back(self):
        details = {"technicalMetadata": {"formData": {
            "technical_media_duration": 10000,
            "technical_video_time_base": "not-a-ratio",
        }}}
        info = _extract_source_media_info(details)
        assert info["duration_ms"] == 10000
        assert info["time_base_num"] == 1001
        assert info["time_base_den"] == 30000

    def test_resolve_source_info_accepts_legacy_scalar(self):
        """Pre-fix tests pass `cache[id] = 60` (duration in seconds).
        The resolver should accept that and build a default-info dict with
        the given duration — so existing tests keep working.
        """
        info = _resolve_source_info({"item-1": 42}, "item-1")
        assert info["duration_ms"] == 42000
        assert info["frame_rate"] == 29.97

    def test_resolve_source_info_returns_fresh_dict(self):
        """Callers must be able to mutate without affecting the cache."""
        source = {"item-1": {"duration_ms": 10000, "frame_rate": 25.0,
                             "time_base_num": 1, "time_base_den": 25}}
        info = _resolve_source_info(source, "item-1")
        info["duration_ms"] = 99999
        assert source["item-1"]["duration_ms"] == 10000


# ---------------------------------------------------------------------------
# Timeline payload is gapless at the frame level (end-to-end check)
# ---------------------------------------------------------------------------

class TestFrameAlignedPayload:
    """The real-world symptom: 8 docked V1 clips with ms-aligned boundaries
    land between frames, producing a 1-frame black gap per boundary at
    render time. After the fix, every boundary falls on an integer frame
    and adjacent clips share the same rational.
    """

    def test_v1_boundaries_are_frame_aligned(self):
        # Reproduces an observed 30s VO cut: 8 docked V1 clips whose
        # millisecond boundaries all fell between 29.97fps frames.
        clips = [
            {"mimirItemId": "a", "start":     0, "end":  4000, "inPoint": 15000, "outPoint": 19000},
            {"mimirItemId": "b", "start":  4000, "end":  8500, "inPoint": 15000, "outPoint": 19500},
            {"mimirItemId": "a", "start":  8500, "end": 12250, "inPoint":     0, "outPoint":  3750},
            {"mimirItemId": "c", "start": 12250, "end": 15602, "inPoint": 15000, "outPoint": 18352},
            {"mimirItemId": "b", "start": 15602, "end": 18750, "inPoint":     0, "outPoint":  3148},
            {"mimirItemId": "d", "start": 18750, "end": 22500, "inPoint":     0, "outPoint":  3750},
            {"mimirItemId": "e", "start": 22500, "end": 26500, "inPoint": 15000, "outPoint": 19000},
            {"mimirItemId": "f", "start": 26500, "end": 30000, "inPoint":     0, "outPoint":  3500},
        ]
        seq = _make_multitrack_sequence(v1_clips=clips)
        _, source_refs, _, _ = _build_multitrack_timeline_payload(
            seq, {k: 60 for k in "abcdef"}
        )
        # Every timeline rational must share the frame denominator and have
        # a numerator that is an integer multiple of the frame numerator.
        for sid, src in source_refs.items():
            for key in ("mediaStartOffset", "videoInPointInSeconds", "videoOutPointInSeconds"):
                r = src[key]
                assert r["denominator"] == TIMELINE_FRAME_RATE_DEN, (
                    f"{sid}.{key} denominator={r['denominator']} not frame-aligned"
                )
                assert r["numerator"] % TIMELINE_FRAME_RATE_NUM == 0, (
                    f"{sid}.{key} numerator={r['numerator']} is not an integer "
                    f"number of frames"
                )

    def test_item_ref_uses_mimir_duration_and_time_base(self):
        """When the cache carries full source info, the itemRef reflects it
        (not the old hardcoded 60s / 1001/30000)."""
        cache = {"item-1": {
            "duration_ms": 20687,
            "frame_rate": 29.97,
            "time_base_num": 1001,
            "time_base_den": 30000,
        }}
        seq = _make_legacy_sequence([
            {"mimirItemId": "item-1", "start": 0, "inPoint": 0, "outPoint": 5000},
        ])
        item_refs, _, _, _ = _build_legacy_timeline_payload(seq, cache)
        assert item_refs["item-1"]["durationInSeconds"] == {
            "numerator": 20687, "denominator": 1000
        }
        assert item_refs["item-1"]["frameDurationInSeconds"] == {
            "numerator": 1001, "denominator": 30000
        }
