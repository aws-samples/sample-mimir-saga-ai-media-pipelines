"""Targeted tests for the Sinclair VO / VOSOT / AI-VO workflow split.

Covers the acceptance-criteria behaviors:
  1. Standard "Generate VO" does NOT invoke AI voice synthesis; "Generate AI VO"
     does.
  2. The 20s-script / ~30s-video / ~4s-shot targets are configured and passed
     through to timeline assembly.
  3. Shot-duration constraints (3-5s band, hard 5s ceiling) are applied by the
     B-roll filler.
  4. Stability analysis is invoked during the Generate VO timeline rebuild.
  5. Saga instance creation receives the script AND the selected clips.
  6. Partial failures (instance created, clip association failed) are reported
     as ``partial_success`` — never a silent success.

External SDKs (strands, bedrock_agentcore) are stubbed before import so the
tests run without those packages or any network access — matching the pattern
used by the other test modules in this directory.
"""
import json
import os
import sys
from unittest.mock import MagicMock, patch

import pytest

# ---------------------------------------------------------------------------
# External SDKs (strands, bedrock_agentcore) are stubbed with PASSTHROUGH
# decorators by conftest.py before collection, so the @tool functions and the
# @app.entrypoint invoke() remain real, callable functions here.
# ---------------------------------------------------------------------------
os.environ.setdefault("AWS_DEFAULT_REGION", "us-east-1")
os.environ.setdefault("MIMIR_API_KEY_SECRET_ARN", "arn:aws:secretsmanager:us-east-1:123:secret:fake")
os.environ.setdefault("SAGA_API_KEY_SECRET_ARN", "arn:aws:secretsmanager:us-east-1:123:secret:fake")
os.environ.setdefault("SAGA_API_URL_SECRET_ARN", "arn:aws:secretsmanager:us-east-1:123:secret:fake")
os.environ.setdefault("VECTOR_BUCKET_NAME", "fake-bucket")
os.environ.setdefault("VECTOR_INDEX_NAME", "fake-index")

import profiles  # noqa: E402
import tools  # noqa: E402
import rough_cut_agent as rca  # noqa: E402


# ---------------------------------------------------------------------------
# Profile configuration (requirement 2 + workflow flags)
# ---------------------------------------------------------------------------

class TestProfiles:
    def test_vo_profile_never_synthesizes_and_has_no_sot(self):
        p = profiles.get_profile("vo")
        assert p["synthesize_voiceover"] is False
        assert p["include_sot"] is False

    def test_vosot_profile_no_ai_voice_but_includes_sot(self):
        p = profiles.get_profile("vosot")
        assert p["synthesize_voiceover"] is False
        assert p["include_sot"] is True

    def test_ai_vo_profile_synthesizes(self):
        p = profiles.get_profile("ai-vo")
        assert p["synthesize_voiceover"] is True

    def test_package_profile_is_full_rough_cut(self):
        p = profiles.get_profile("package")
        assert p["synthesize_voiceover"] is True
        assert p["include_sot"] is True
        assert p["timeline_suffix"] == "Package"

    def test_simple_vo_and_full_keys_retired(self):
        # simple-vo (dead alias) and the old 'full' key are gone; the full
        # rough cut is now keyed 'package'.
        assert "simple-vo" not in profiles.ROUGH_CUT_PROFILES
        assert "full" not in profiles.ROUGH_CUT_PROFILES

    def test_unknown_type_falls_back_to_default_ai_vo(self):
        assert profiles.DEFAULT_ROUGH_CUT_TYPE == "ai-vo"
        assert profiles.get_profile("nope")["label"] == profiles.get_profile("ai-vo")["label"]

    def test_editorial_duration_defaults(self):
        shot = profiles.get_profile("vo")["shot"]
        assert shot["script_duration_s"] == 20
        assert shot["target_video_duration_s"] == 30
        assert shot["target_shot_duration_s"] == 4
        assert shot["min_shot_duration_s"] == 3
        assert shot["max_shot_duration_s"] == 5

    def test_targets_are_referenced_in_directives(self):
        # The 20s/30s targets should appear in the prompts the agent sends,
        # so they are actually passed through to the model.
        vo = profiles.get_profile("vo")
        assert "20 SECONDS" in vo["script_directive"]
        assert "30 seconds" in vo["timeline_directive"] or "30 SECONDS" in vo["timeline_directive"].upper()
        # Composition guidance covers the shot vocabulary.
        td = vo["timeline_directive"]
        for word in ("WIDE", "MEDIUM", "TIGHT"):
            assert word in td.upper()


# ---------------------------------------------------------------------------
# Shared helpers for the invoke() integration tests
# ---------------------------------------------------------------------------

def _make_payload(rough_cut_type):
    """Minimal payload with a present script so Stage 0 is skipped."""
    return {
        "task_token": "",
        "roughCutType": rough_cut_type,
        "storyContext": {
            "story": {
                "mId": "STR-TEST",
                "mTitle": "Test Story",
                "content": {"document": [{"children": [{"text": "vo line one"}]}]},
                "mSyncProviders": [],
            },
            "assets": [{"mimirItemId": "clip-a", "hasEmbeddings": True}],
            "instances": [],
            "notes": [],
        },
    }


_SCRIPT_ANALYSIS_STUB = {
    "scriptFormat": "broadcast_script",
    "parsedSections": [
        {"sectionType": "pkg_vo", "content": "vo line one", "orderIndex": 0,
         "estimatedDurationMs": 4000},
    ],
    "totalEstimatedDurationMs": 4000,
    "lead": {"content": "x", "hookType": "human_interest", "estimatedDurationMs": 4000},
    "body": {"mainPoints": []},
    "wrapUp": {"content": "x", "closureType": "resolution"},
    "soundbites": [], "interviewSegments": [], "voiceOverSections": [],
}

_TIMELINE_RESULT_STUB = {
    "timelineItemId": "timeline-1",
    "summary": {"clipCount": 1, "totalDurationMs": 30000, "trackCount": 4},
    "sequenceDetails": {
        "tracks": [
            {"id": 1, "name": "V1", "mediaType": "video",
             "clips": [{"mimirItemId": "clip-a", "start": 0, "end": 4000}]},
            {"id": 2, "name": "V2", "mediaType": "video", "clips": []},
            {"id": 3, "name": "A1", "mediaType": "audio", "clips": []},
            {"id": 4, "name": "A2", "mediaType": "audio", "clips": []},
        ]
    },
}


def _run_invoke(rough_cut_type, instance_return=None):
    """Run rca.invoke() with all heavy stages patched out.

    Returns a dict of the mocks so tests can assert on calls.
    """
    if instance_return is None:
        instance_return = json.dumps({
            "instanceId": "INS-1", "status": "success",
            "sectionsWritten": 1, "clipsRequested": 1, "clipsAssociated": 1,
        })

    patches = {
        "run_script_analysis": MagicMock(return_value=dict(_SCRIPT_ANALYSIS_STUB)),
        "run_source_material": MagicMock(return_value={"candidateSegments": [], "gaps": [], "coveragePercentage": 0}),
        "_detect_reporter_vo": MagicMock(return_value={}),
        "_synthesize_voiceovers": MagicMock(return_value={}),
        "run_timeline_assembly": MagicMock(return_value=json.loads(json.dumps(_TIMELINE_RESULT_STUB))),
        "create_or_update_linear_instance": MagicMock(return_value=instance_return),
        "_save_artifact": MagicMock(),
    }
    with patch.multiple("rough_cut_agent", **patches):
        result = rca.invoke(_make_payload(rough_cut_type))
    return result, patches


# ---------------------------------------------------------------------------
# 1. VO does not synthesize; AI VO does (requirement 1)
# ---------------------------------------------------------------------------

class TestVoiceoverGating:
    def test_generate_vo_does_not_synthesize_ai_voice(self):
        result, m = _run_invoke("vo")
        assert "error" not in result
        m["_synthesize_voiceovers"].assert_not_called()
        m["_detect_reporter_vo"].assert_not_called()

    def test_generate_vosot_does_not_synthesize_ai_voice(self):
        _, m = _run_invoke("vosot")
        m["_synthesize_voiceovers"].assert_not_called()

    def test_generate_ai_vo_synthesizes(self):
        _, m = _run_invoke("ai-vo")
        m["_synthesize_voiceovers"].assert_called_once()

    def test_vo_profile_strips_sot_sections(self):
        # Even if script analysis returns SOT/interview sections (source script
        # had soundbites), a VO-only profile must drop them before source
        # material search, so no SOT ever lands on V1.
        analysis_with_sot = dict(_SCRIPT_ANALYSIS_STUB)
        analysis_with_sot["parsedSections"] = [
            {"sectionType": "pkg_vo", "content": "vo one", "orderIndex": 0,
             "estimatedDurationMs": 4000},
            {"sectionType": "pkg_sot", "content": "a quote", "orderIndex": 1,
             "estimatedDurationMs": 6000, "speaker": "X", "quotedText": "a quote"},
            {"sectionType": "pkg_nats", "content": "nat pop", "orderIndex": 2,
             "estimatedDurationMs": 3000},
        ]
        patches = {
            "run_script_analysis": MagicMock(return_value=analysis_with_sot),
            "run_source_material": MagicMock(return_value={"candidateSegments": [], "gaps": [], "coveragePercentage": 0}),
            "_detect_reporter_vo": MagicMock(return_value={}),
            "_synthesize_voiceovers": MagicMock(return_value={}),
            "run_timeline_assembly": MagicMock(return_value=json.loads(json.dumps(_TIMELINE_RESULT_STUB))),
            "create_or_update_linear_instance": MagicMock(return_value=json.dumps({"instanceId": "INS-1", "status": "success"})),
            "_save_artifact": MagicMock(),
        }
        with patch.multiple("rough_cut_agent", **patches):
            rca.invoke(_make_payload("vo"))
        # Inspect the script_analysis handed to source material
        passed = patches["run_source_material"].call_args[0][0]
        types = [s["sectionType"] for s in passed["parsedSections"]]
        assert "pkg_sot" not in types
        assert types == ["pkg_vo", "pkg_nats"]
        assert passed["soundbites"] == []




# ---------------------------------------------------------------------------
# 2. Duration/target passthrough (requirement 2)
# ---------------------------------------------------------------------------

class TestTargetPassthrough:
    def test_shot_config_passed_to_timeline_assembly(self):
        _, m = _run_invoke("vo")
        _, kwargs = m["run_timeline_assembly"].call_args
        shot = kwargs["shot_config"]
        assert shot["script_duration_s"] == 20
        assert shot["target_video_duration_s"] == 30
        assert shot["target_shot_duration_s"] == 4

    def test_vo_profile_directive_passed_to_script_analysis(self):
        _, m = _run_invoke("vo")
        _, kwargs = m["run_script_analysis"].call_args
        assert "VOICE-OVER ONLY" in kwargs["profile_directive"]


# ---------------------------------------------------------------------------
# 5. Instance receives script + selected clips (requirement 4)
# ---------------------------------------------------------------------------

class TestInstanceCreation:
    def test_instance_receives_script_and_clips(self):
        _, m = _run_invoke("vo")
        _, kwargs = m["create_or_update_linear_instance"].call_args
        # Script sections derived from the analysis
        sections = json.loads(kwargs["script_sections_json"])
        assert len(sections) == 1 and sections[0]["text"]
        # Selected rendered clip ids from the timeline video tracks
        clip_ids = json.loads(kwargs["clip_item_ids_json"])
        assert clip_ids == ["clip-a"]

    def test_partial_failure_surfaced_on_result(self):
        partial = json.dumps({
            "instanceId": "INS-1", "status": "partial_success",
            "sectionsWritten": 1, "clipsRequested": 1, "clipsAssociated": 0,
            "clipAssociationError": "asset clip-a: HTTP 500",
        })
        result, _ = _run_invoke("vo", instance_return=partial)
        assert result["summary"]["instance"]["status"] == "partial_success"
        assert result["summary"]["instance"]["clipAssociationError"]


# ---------------------------------------------------------------------------
# 3. Shot-duration constraints in the B-roll filler (requirement 3)
# ---------------------------------------------------------------------------

class TestShotDurationConstraints:
    def _pool(self, n=10, seg_len_s=10.0):
        return [
            {"itemId": f"i{k}", "segmentIndex": k,
             "startTimeSeconds": 0.0, "endTimeSeconds": seg_len_s, "distance": 0.1}
            for k in range(n)
        ]

    def test_no_shot_exceeds_max_ceiling(self):
        filled = rca._fill_spans(
            [(0, 30000)], self._pool(), set(),
            min_clip_ms=3000, target_clip_ms=4000, max_clip_ms=5000,
        )
        assert filled, "expected the span to be filled"
        for clip in filled:
            assert clip["duration"] <= 5000, f"shot {clip} exceeds 5s ceiling"
            assert clip["duration"] > 0

    def test_shots_target_configured_length(self):
        filled = rca._fill_spans(
            [(0, 20000)], self._pool(), set(),
            min_clip_ms=3000, target_clip_ms=4000, max_clip_ms=5000,
        )
        # With a 4s target most shots should be ~4s (allow the closing/absorb
        # shot to reach the 5s ceiling).
        assert all(3000 <= c["duration"] <= 5000 for c in filled)
        assert filled[0]["duration"] == 4000

    def test_span_fully_covered(self):
        filled = rca._fill_spans(
            [(0, 20000)], self._pool(), set(),
            min_clip_ms=3000, target_clip_ms=4000, max_clip_ms=5000,
        )
        covered = sum(c["duration"] for c in filled)
        assert covered == 20000


# ---------------------------------------------------------------------------
# 4. Stability analysis is invoked for Generate VO (requirement 3 stability)
# ---------------------------------------------------------------------------

class TestStabilityInvoked:
    def test_load_stability_cache_called_during_broll_rebuild(self):
        assembly = json.loads(json.dumps(_TIMELINE_RESULT_STUB))
        # Give V1 a VO-led gap to fill so the rebuild reaches the pool step.
        assembly["sequenceDetails"]["tracks"][0]["clips"] = [
            {"mimirItemId": "sot-1", "start": 10000, "end": 14000},
        ]
        enriched = [{"mimirItemId": "clip-a", "hasEmbeddings": True}]
        shot = profiles.get_profile("vo")["shot"]

        fake_vectors = {"vectors": [
            {"metadata": {"itemId": "clip-a", "segmentIndex": 0,
                          "startTimeSeconds": 0, "endTimeSeconds": 10}, "distance": 0.2},
        ]}
        fake_s3vectors = MagicMock()
        fake_s3vectors.query_vectors.return_value = fake_vectors
        fake_bedrock = MagicMock()
        fake_bedrock.invoke_model.return_value = {
            "body": MagicMock(read=lambda: json.dumps({"embeddings": [{"embedding": [0.0] * 8}]}))
        }

        def _client(name, *a, **k):
            return fake_bedrock if name == "bedrock-runtime" else fake_s3vectors

        with patch("rough_cut_agent.boto3.client", side_effect=_client), \
             patch("rough_cut_agent._load_stability_cache", return_value={}) as mock_stab:
            rca._rebuild_broll_tracks(assembly, enriched, _SCRIPT_ANALYSIS_STUB, shot)
            mock_stab.assert_called()


# ---------------------------------------------------------------------------
# 6. create_or_update_linear_instance partial-failure path (requirement 4)
# ---------------------------------------------------------------------------

class _Resp:
    def __init__(self, status_code=200, payload=None, text=""):
        self.status_code = status_code
        self._payload = payload or {}
        self.text = text
        self.ok = 200 <= status_code < 300

    def json(self):
        return self._payload

    def raise_for_status(self):
        if not self.ok:
            raise Exception(f"HTTP {self.status_code}")


class TestCreateInstancePartialFailure:
    def _run(self, asset_status):
        """Create-instance path where asset association returns *asset_status*."""
        def fake_get(url, **kwargs):
            if url.endswith("/instances"):
                return _Resp(200, {"instances": []})  # no existing instance
            return _Resp(200, {"mTitle": "Test Story"})  # story title fetch

        def fake_post(url, **kwargs):
            if url.endswith("/instances"):
                return _Resp(200, {"id": "ORG-INS-NEW"})  # instance created
            if url.endswith("/assets"):
                return _Resp(asset_status, {}, text="boom" if asset_status >= 400 else "")
            return _Resp(200, {})

        def fake_patch(url, **kwargs):
            return _Resp(200, {})

        fake_requests = MagicMock()
        fake_requests.get.side_effect = fake_get
        fake_requests.post.side_effect = fake_post
        fake_requests.patch.side_effect = fake_patch

        with patch.object(tools, "requests", fake_requests), \
             patch.object(tools, "_get_saga_api_url", return_value="https://saga.test"), \
             patch.object(tools, "_saga_auth_headers", return_value={}):
            out = tools.create_or_update_linear_instance(
                story_id="STR-TEST",
                script_sections_json=json.dumps([{"type": "vo", "label": "PKG VO:", "text": "hi"}]),
                clip_item_ids_json=json.dumps(["clip-a"]),
            )
        return json.loads(out)

    def test_success_when_clip_association_succeeds(self):
        res = self._run(asset_status=200)
        assert res["status"] == "success"
        assert res["clipsAssociated"] == 1

    def test_partial_success_when_clip_association_fails(self):
        res = self._run(asset_status=500)
        assert res["status"] == "partial_success"
        assert res["clipsAssociated"] == 0
        assert res["clipAssociationError"]

    def test_conflict_counts_as_associated(self):
        # 409 = asset already on the story (idempotent) → still success.
        res = self._run(asset_status=409)
        assert res["status"] == "success"
        assert res["clipsAssociated"] == 1


# ---------------------------------------------------------------------------
# A1 voice-over track is cleared for no-AI-voice profiles (Cutter 404 fix)
# ---------------------------------------------------------------------------

class _FakeAssemblyAgent:
    """Fake Strands Agent that returns a fixed assembly JSON string."""

    _payload = None

    def __init__(self, *a, **k):
        pass

    def __call__(self, _msg):
        return "```json\n" + _FakeAssemblyAgent._payload + "\n```"


def _assembly_with_a1_vo():
    return json.dumps({
        "summary": {"clipCount": 2, "totalDurationMs": 30000, "trackCount": 4},
        "sequenceDetails": {"tracks": [
            {"id": 1, "name": "V1", "mediaType": "video",
             "clips": [{"mimirItemId": "clip-a", "start": 0, "end": 4000,
                        "duration": 4000, "inPoint": 0, "outPoint": 4000}]},
            {"id": 2, "name": "V2", "mediaType": "video", "clips": []},
            {"id": 3, "name": "A1 - Voice-over", "mediaType": "audio",
             "clips": [{"mimirItemId": "vo_section_0", "start": 0, "end": 4000,
                        "duration": 4000, "inPoint": 0, "outPoint": 4000,
                        "sourceType": "audio-only"}]},
            {"id": 4, "name": "A2", "mediaType": "audio", "clips": []},
        ]}
    })


class TestVoTrackCleared:
    def _run(self, synthesize):
        _FakeAssemblyAgent._payload = _assembly_with_a1_vo()
        with patch("rough_cut_agent.Agent", _FakeAssemblyAgent), \
             patch("rough_cut_agent._get_bedrock_model", return_value=MagicMock()), \
             patch("rough_cut_agent._normalize_primary_sequence"), \
             patch("rough_cut_agent._rebuild_broll_tracks"), \
             patch("rough_cut_agent.create_timeline", return_value=json.dumps({"id": "tl-1"})), \
             patch("rough_cut_agent.update_story_status"), \
             patch("rough_cut_agent.send_task_success"), \
             patch("rough_cut_agent._save_artifact"):
            return rca.run_timeline_assembly(
                script_analysis=dict(_SCRIPT_ANALYSIS_STUB),
                source_material={"candidateSegments": [], "gaps": []},
                enriched_assets=[],
                story_id="STR-TEST",
                story_title="Test",
                task_token="",
                synthesize_voiceover=synthesize,
            )

    def _a1(self, result):
        return next(t for t in result["sequenceDetails"]["tracks"] if t["id"] == 3)

    def test_a1_cleared_when_no_ai_voice(self):
        # The placeholder 'vo_section_0' clip that 404s in Cutter must be removed.
        result = self._run(synthesize=False)
        assert self._a1(result)["clips"] == []

    def test_a1_retained_when_ai_voice(self):
        result = self._run(synthesize=True)
        assert len(self._a1(result)["clips"]) == 1


# ---------------------------------------------------------------------------
# Live-read VO length is hard-capped to the ~30s target (requirement 2)
# ---------------------------------------------------------------------------

class TestVoLengthCap:
    def _empty_anchor_assembly(self):
        return {
            "summary": {},
            "sequenceDetails": {"tracks": [
                {"id": 1, "name": "V1", "mediaType": "video", "clips": []},
                {"id": 2, "name": "V2", "mediaType": "video", "clips": []},
                {"id": 3, "name": "A1 - Voice-over", "mediaType": "audio", "clips": []},
                {"id": 4, "name": "A2", "mediaType": "audio", "clips": []},
            ]},
        }

    def test_v1_cover_capped_to_30s_and_no_overlong_shots(self):
        assembly = self._empty_anchor_assembly()
        enriched = [{"mimirItemId": f"c{i}", "hasEmbeddings": True} for i in range(12)]
        # A long script (71s) must NOT stretch the video beyond the 30s target.
        script = {"parsedSections": [
            {"sectionType": "pkg_vo", "content": "x", "orderIndex": i,
             "estimatedDurationMs": 6000} for i in range(12)
        ]}
        shot = profiles.get_profile("vo")["shot"]

        vectors = {"vectors": [
            {"metadata": {"itemId": f"c{i}", "segmentIndex": 0,
                          "startTimeSeconds": 0, "endTimeSeconds": 10}, "distance": 0.01 * i}
            for i in range(12)
        ]}
        fake_s3vectors = MagicMock()
        fake_s3vectors.query_vectors.return_value = vectors
        fake_bedrock = MagicMock()
        fake_bedrock.invoke_model.return_value = {
            "body": MagicMock(read=lambda: json.dumps({"embeddings": [{"embedding": [0.0] * 8}]}))
        }

        def _client(name, *a, **k):
            return fake_bedrock if name == "bedrock-runtime" else fake_s3vectors

        with patch("rough_cut_agent.boto3.client", side_effect=_client), \
             patch("rough_cut_agent._load_stability_cache", return_value={}):
            rca._rebuild_broll_tracks(assembly, enriched, script, shot)

        v1 = next(t for t in assembly["sequenceDetails"]["tracks"] if t["id"] == 1)
        assert v1["clips"], "V1 should be filled with B-roll cover"
        max_end = max(c["end"] for c in v1["clips"])
        assert max_end <= 30000, f"timeline {max_end}ms exceeds the 30s cap"
        for c in v1["clips"]:
            assert 0 < c["duration"] <= 5000, f"shot {c} violates the 5s ceiling"


# ---------------------------------------------------------------------------
# B-roll eligibility: exclude talking-head / interview footage from VO cover
# ---------------------------------------------------------------------------

class TestBrollEligibility:
    def test_excludes_wordy_clips_keeps_broll(self, monkeypatch):
        monkeypatch.setenv("TRANSCRIPT_STAGING_BUCKET", "staging")
        transcripts = {
            "broll-short": {"fullTranscript": "crowd ambient noise"},          # 3 words -> B-roll
            "interview": {"fullTranscript": " ".join(["word"] * 120)},          # 120 words -> talky
            "standup": {"fullTranscript": " ".join(["reporter"] * 80)},         # 80 words -> talky
        }

        class _FakeS3:
            def get_object(self, Bucket, Key):
                mid = Key.split("/")[1]
                if mid == "no-transcript":
                    raise Exception("NoSuchKey")
                body = json.dumps(transcripts[mid]).encode()
                return {"Body": MagicMock(read=lambda: body)}

        monkeypatch.setattr(rca.boto3, "client", lambda name, *a, **k: _FakeS3())

        assets = [
            {"mimirItemId": "broll-short", "hasEmbeddings": True},
            {"mimirItemId": "interview", "hasEmbeddings": True},
            {"mimirItemId": "standup", "hasEmbeddings": True},
            {"mimirItemId": "no-transcript", "hasEmbeddings": True},
        ]
        eligible = rca._broll_eligible_item_ids(assets, max_words=50)
        assert set(eligible) == {"broll-short", "no-transcript"}
        assert "interview" not in eligible and "standup" not in eligible

    def test_returns_none_without_staging_bucket(self, monkeypatch):
        monkeypatch.delenv("TRANSCRIPT_STAGING_BUCKET", raising=False)
        assert rca._broll_eligible_item_ids([{"mimirItemId": "x", "hasEmbeddings": True}]) is None


# ---------------------------------------------------------------------------
# PKG VO cue sanitization for TTS (P1.3) + nat-sound gain (verify #1)
# ---------------------------------------------------------------------------

class TestTtsSanitize:
    def test_strips_leading_cue_labels(self):
        assert tools.sanitize_for_tts("PKG VO: OWNER SAYS SHE POURED HER HEART IN.") == \
            "OWNER SAYS SHE POURED HER HEART IN."
        assert tools.sanitize_for_tts("SOT: I am proud of what we built.") == \
            "I am proud of what we built."
        assert tools.sanitize_for_tts("NAT SOUND: crowd cheering") == "crowd cheering"

    def test_drops_standalone_cue_lines(self):
        assert tools.sanitize_for_tts("PKG VO") == ""
        assert tools.sanitize_for_tts("STANDUP") == ""

    def test_removes_bracketed_directions(self):
        assert tools.sanitize_for_tts("((---PKG---)) IT'S THE LAST DANCE.") == "IT'S THE LAST DANCE."
        assert tools.sanitize_for_tts("((nats))") == ""
        assert tools.sanitize_for_tts("IN HERSHEY, I'M JASMINE (NAT POP)") == "IN HERSHEY, I'M JASMINE"

    def test_preserves_real_words_that_look_like_cues(self):
        # ALL CAPS narration is normal in broadcast — never strip for case alone.
        assert tools.sanitize_for_tts("TONIGHT: THE COMMUNITY MOURNS A HERO.") == \
            "TONIGHT: THE COMMUNITY MOURNS A HERO."
        # "LIVE" as a real word (no colon) must survive.
        assert tools.sanitize_for_tts("LIVE FROM THE SCENE, THE ROAD IS CLOSED.") == \
            "LIVE FROM THE SCENE, THE ROAD IS CLOSED."

    def test_empty_when_all_cues(self):
        assert tools.sanitize_for_tts("((nats))\nPKG VO") == ""


def _all_gain_denominators(payload):
    """Collect every audio gainMultiplier denominator in a timeline payload."""
    dens = []
    for track in payload.get("audioTracks", []):
        for box in track:
            gm = box.get("gainMultiplier") if isinstance(box, dict) else None
            if gm:
                dens.append(gm.get("denominator"))
    return dens


class TestNatSoundGain:
    def test_constant_is_10_percent(self):
        assert tools.NAT_SOUND_GAIN == (1, 10)

    def test_broll_cover_audio_is_one_tenth_not_one_fifth(self):
        seq = {
            "tracks": [
                {"id": 1, "mediaType": "video", "name": "V1", "clips": [
                    {"mimirItemId": "broll-1", "start": 0, "inPoint": 0, "outPoint": 4000,
                     "brollCover": True},
                ]},
                {"id": 2, "mediaType": "video", "name": "V2", "clips": [
                    {"mimirItemId": "broll-2", "start": 0, "inPoint": 0, "outPoint": 4000},
                ]},
                {"id": 3, "mediaType": "audio", "name": "A1", "clips": []},
                {"id": 4, "mediaType": "audio", "name": "A2", "clips": []},
            ]
        }
        cache = {"broll-1": 60, "broll-2": 60}
        _, _, payload, _ = tools._build_multitrack_timeline_payload(seq, cache)
        dens = _all_gain_denominators(payload)
        assert dens, "expected some audio gains"
        assert 5 not in dens, "nat sound must no longer be 1/5 (20%)"
        assert 10 in dens, "nat sound cover should be 1/10 (10%)"
