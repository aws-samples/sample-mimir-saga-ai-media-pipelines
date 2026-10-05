"""Targeted tests for the Sinclair VO / VOSOT / AI-VO workflow split.

Covers the acceptance-criteria behaviors:
  1. Standard "Generate VO" does NOT invoke AI voice synthesis; "Generate AI VO"
     does.
  2. The 20s-script / ~30s-video / ~4s-shot targets are configured and passed
     through to timeline assembly.
  3. Shot-duration constraints (3-5s band, hard 5s ceiling) are applied by the
     B-roll filler.
  4. Stability analysis is invoked during the Generate VO timeline rebuild.
  5. Saga instance creation is SCRIPT ONLY (no clips are associated).
  6. VOSOT produces TWO instances ("<story> - VOSOT VO" and
     "<story> - VOSOT SOT"); all other profiles produce a single instance.

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


# A real-looking broadcast read (>= MIN_SCRIPT_WORDS, no placeholder markers).
_SUBSTANTIVE = (
    "The city council approved a new budget today after weeks of debate over "
    "funding for parks, roads, and public safety across the district this year."
)


def _linear_instance(text, title="", inst_id="OTHER-INS-1", assigned=False):
    """Build a minimal LINEAR instance dict as story-context-handler returns."""
    account = {"accountId": "RND-1" if assigned else None}
    return {
        "id": inst_id,
        "title": title,
        "platformInfo": {"platform": "linear", "account": account},
        "content": {"document": [{"children": [{"text": text}]}]},
    }


def _run_invoke(rough_cut_type, instance_return=None, payload=None, synth_return=""):
    """Run rca.invoke() with all heavy stages patched out.

    Returns a dict of the mocks so tests can assert on calls. Pass ``payload``
    to override the default, and ``synth_return`` to stub the context-synthesis
    script.
    """
    if instance_return is None:
        instance_return = json.dumps({
            "instanceId": "INS-1", "status": "success", "sectionsWritten": 1,
        })

    patches = {
        "run_script_analysis": MagicMock(return_value=dict(_SCRIPT_ANALYSIS_STUB)),
        "run_source_material": MagicMock(return_value={"candidateSegments": [], "gaps": [], "coveragePercentage": 0}),
        "_detect_reporter_vo": MagicMock(return_value={}),
        "_synthesize_voiceovers": MagicMock(return_value={}),
        # Stage 0 context helpers — mocked so the workflow tests never hit
        # Bedrock/S3 when a payload has no trusted script.
        "_gather_model_knowledge": MagicMock(return_value=""),
        "_synthesize_script_from_transcripts": MagicMock(return_value=synth_return),
        "run_timeline_assembly": MagicMock(return_value=json.loads(json.dumps(_TIMELINE_RESULT_STUB))),
        "create_or_update_linear_instance": MagicMock(return_value=instance_return),
        "_save_artifact": MagicMock(),
    }
    with patch.multiple("rough_cut_agent", **patches):
        result = rca.invoke(payload if payload is not None else _make_payload(rough_cut_type))
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
            "_gather_model_knowledge": MagicMock(return_value=""),
            "_synthesize_script_from_transcripts": MagicMock(return_value=""),
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
# 5. Instance creation is script-only (no clips); 6. VOSOT → two instances
# ---------------------------------------------------------------------------

class TestInstanceCreation:
    def test_instance_receives_script_only_no_clips(self):
        _, m = _run_invoke("vo")
        _, kwargs = m["create_or_update_linear_instance"].call_args
        # Script sections derived from the analysis
        sections = json.loads(kwargs["script_sections_json"])
        assert len(sections) == 1 and sections[0]["text"]
        # Instances are SCRIPT ONLY — no clip ids are ever passed.
        assert "clip_item_ids_json" not in kwargs
        # A per-action title drives idempotent find-or-create.
        assert kwargs["instance_title"] == "Test Story - VO"

    def test_vo_creates_single_instance(self):
        _, m = _run_invoke("vo")
        assert m["create_or_update_linear_instance"].call_count == 1

    def test_instance_summary_recorded_on_result(self):
        result, _ = _run_invoke("vo")
        instances = result["summary"]["instances"]
        assert len(instances) == 1
        assert instances[0]["status"] == "success"

    def test_vosot_creates_two_titled_instances(self):
        # VOSOT splits into a VO instance and a SOT instance so the anchor can
        # start the soundbite on their own timing. Feed an analysis that has
        # both VO-family and SOT sections so both subsets are non-empty.
        analysis = dict(_SCRIPT_ANALYSIS_STUB)
        analysis["parsedSections"] = [
            {"sectionType": "pkg_vo", "content": "vo one", "orderIndex": 0,
             "estimatedDurationMs": 4000},
            {"sectionType": "pkg_sot", "content": "a quote", "orderIndex": 1,
             "estimatedDurationMs": 6000, "speaker": "X", "quotedText": "a quote"},
        ]
        patches = {
            "run_script_analysis": MagicMock(return_value=analysis),
            "run_source_material": MagicMock(return_value={"candidateSegments": [], "gaps": [], "coveragePercentage": 0}),
            "_detect_reporter_vo": MagicMock(return_value={}),
            "_synthesize_voiceovers": MagicMock(return_value={}),
            "run_timeline_assembly": MagicMock(return_value=json.loads(json.dumps(_TIMELINE_RESULT_STUB))),
            "create_or_update_linear_instance": MagicMock(
                return_value=json.dumps({"instanceId": "INS-1", "status": "success", "sectionsWritten": 1})),
            "_save_artifact": MagicMock(),
        }
        with patch.multiple("rough_cut_agent", **patches):
            rca.invoke(_make_payload("vosot"))

        calls = patches["create_or_update_linear_instance"].call_args_list
        assert len(calls) == 2
        titles = [c.kwargs["instance_title"] for c in calls]
        assert titles == ["Test Story - VOSOT VO", "Test Story - VOSOT SOT"]

        # The VO instance must carry no SOT sections; the SOT instance only SOT.
        vo_sections = json.loads(calls[0].kwargs["script_sections_json"])
        sot_sections = json.loads(calls[1].kwargs["script_sections_json"])
        assert all("SOT" not in (s.get("label") or "") for s in vo_sections)
        assert sot_sections and all("SOT" in (s.get("label") or "") for s in sot_sections)


# ---------------------------------------------------------------------------
# Script-source selection: trust a real reporter script, otherwise generate
# from context (transcripts + content + research). Thin/placeholder and
# agent-generated instances must NOT be used verbatim.
# ---------------------------------------------------------------------------

class TestScriptSourceSelection:
    def _run(self, instances, story_content, synth_return=""):
        payload = _make_payload("vo")
        payload["storyContext"]["instances"] = instances
        payload["storyContext"]["story"]["content"] = {
            "document": [{"children": [{"text": story_content}]}]
        }
        _, patches = _run_invoke("vo", payload=payload, synth_return=synth_return)
        # story_context is the first positional arg to run_script_analysis.
        story_context = patches["run_script_analysis"].call_args[0][0]
        return story_context, patches

    def test_substantive_story_content_still_generates_from_context(self):
        # story.content is a free-form notes/reference field (users paste web
        # articles, source material, raw transcripts). It is NEVER trusted as
        # a verbatim script, even when "substantive" by word count — treating
        # a pasted article as broadcast copy produces off-brand output (the
        # publisher's station name baked into the AI voice). Instead,
        # story.content always feeds context-based generation.
        thin = _linear_instance("Car Racing", title="Car Racing")
        ctx, p = self._run([thin], _SUBSTANTIVE,
                           synth_return="SYNTHESIZED SCRIPT FROM CONTEXT")
        p["_synthesize_script_from_transcripts"].assert_called_once()
        assert ctx["script"] == "SYNTHESIZED SCRIPT FROM CONTEXT"
        # story.content is handed to the synthesizer as context, not script.
        _, kwargs = p["_synthesize_script_from_transcripts"].call_args
        assert kwargs["story_content_text"] == _SUBSTANTIVE

    def test_no_instances_and_substantive_content_generates_from_context(self):
        # Same rule applies with zero instances: substantive story.content
        # routes to synthesis, not verbatim use.
        ctx, p = self._run([], _SUBSTANTIVE,
                           synth_return="SYNTHESIZED SCRIPT FROM CONTEXT")
        p["_synthesize_script_from_transcripts"].assert_called_once()
        assert ctx["script"] == "SYNTHESIZED SCRIPT FROM CONTEXT"

    def test_agent_generated_instance_ignored(self):
        # An instance THIS agent created ("<story> - VO") must never feed back
        # in as the input script. Falls through to context-based generation
        # (which uses story.content as source material, not as script).
        gen = _linear_instance(_SUBSTANTIVE + " generated copy", title="Test Story - VO")
        ctx, p = self._run([gen], _SUBSTANTIVE,
                           synth_return="SYNTHESIZED SCRIPT FROM CONTEXT")
        # Script is synthesized, not pulled verbatim from the agent-generated
        # instance OR from story.content.
        p["_synthesize_script_from_transcripts"].assert_called_once()
        assert ctx["script"] == "SYNTHESIZED SCRIPT FROM CONTEXT"
        # The agent-generated instance's content must not leak through.
        assert "generated copy" not in ctx["script"]
        # story.content is handed to the synthesizer as context, not as script.
        _, kwargs = p["_synthesize_script_from_transcripts"].call_args
        assert kwargs["story_content_text"] == _SUBSTANTIVE

    def test_single_reporter_instance_used(self):
        # One substantive, non-generated instance is the authoritative script,
        # even when story.content is a thin stub.
        reporter = _linear_instance(_SUBSTANTIVE, title="Reporter Draft")
        ctx, p = self._run([reporter], "Car Racing")
        assert ctx["script"] == _SUBSTANTIVE
        p["_synthesize_script_from_transcripts"].assert_not_called()

    def test_multiple_reporter_instances_generate_from_context(self):
        # Ambiguous: two substantive reporter instances → don't guess; generate
        # a script from context instead.
        a = _linear_instance(_SUBSTANTIVE, title="Draft A", inst_id="A-INS-1")
        b = _linear_instance(_SUBSTANTIVE + " variant", title="Draft B", inst_id="B-INS-2")
        ctx, p = self._run([a, b], "Car Racing",
                           synth_return="SYNTHESIZED SCRIPT FROM CONTEXT")
        p["_synthesize_script_from_transcripts"].assert_called_once()
        assert ctx["script"] == "SYNTHESIZED SCRIPT FROM CONTEXT"

    def test_placeholder_content_generates_from_context(self):
        # No instances and a placeholder story.content → generate from context.
        ctx, p = self._run([], "PKG VO: CAR RACING STORY - INSUFFICIENT SCRIPT CONTENT PROVIDED",
                           synth_return="SYNTHESIZED SCRIPT FROM CONTEXT")
        p["_synthesize_script_from_transcripts"].assert_called_once()
        assert ctx["script"] == "SYNTHESIZED SCRIPT FROM CONTEXT"
        # The story content is still handed to the synthesizer as context.
        _, kwargs = p["_synthesize_script_from_transcripts"].call_args
        assert "INSUFFICIENT" in kwargs["story_content_text"]


class TestSubstantiveScriptHelper:
    def test_short_stub_is_not_substantive(self):
        assert rca._is_substantive_script("Car Racing") is False

    def test_empty_is_not_substantive(self):
        assert rca._is_substantive_script("   ") is False

    def test_placeholder_marker_is_not_substantive(self):
        assert rca._is_substantive_script(
            "This story has insufficient script content provided for now indeed"
        ) is False

    def test_real_script_is_substantive(self):
        assert rca._is_substantive_script(_SUBSTANTIVE) is True

    def test_generated_suffixes_cover_all_actions(self):
        sfx = rca._generated_instance_suffixes()
        for expected in (" - vo", " - ai vo", " - vosot", " - vosot vo", " - vosot sot", " - package"):
            assert expected in sfx


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
# Shot-grammar guardrails: no sub-minimum slivers, no same-source jump cuts,
# and no same-source back-to-back placement in the filler.
# ---------------------------------------------------------------------------

class TestShotGrammarGuardrails:
    def _pool(self, n=12, seg_len_s=10.0):
        # n distinct source clips so variety has alternatives to choose from.
        return [
            {"itemId": f"i{k}", "segmentIndex": 0,
             "startTimeSeconds": 0.0, "endTimeSeconds": seg_len_s, "distance": 0.1 + k * 0.001}
            for k in range(n)
        ]

    def test_no_sub_minimum_sliver_at_span_tail(self):
        # A 6s span with 4s target / 5s max / 3s min must NOT become 5s + 1s
        # (a flash frame). It should split into two >= min shots.
        filled = rca._fill_spans([(0, 6000)], self._pool(), set(),
                                 min_clip_ms=3000, target_clip_ms=4000, max_clip_ms=5000)
        assert filled, "expected the span to be filled"
        for c in filled:
            assert c["duration"] >= 3000, f"sub-minimum sliver produced: {[x['duration'] for x in filled]}"
            assert c["duration"] <= 5000
        assert sum(c["duration"] for c in filled) == 6000

    def test_no_sliver_across_a_longer_span(self):
        # 30s / 4s target should never leave a <3s shot anywhere.
        filled = rca._fill_spans([(0, 30000)], self._pool(n=12), set(),
                                 min_clip_ms=3000, target_clip_ms=4000, max_clip_ms=5000)
        assert sum(c["duration"] for c in filled) == 30000
        assert all(3000 <= c["duration"] <= 5000 for c in filled), \
            [c["duration"] for c in filled]

    def test_avoids_same_source_back_to_back(self):
        # Two nearest candidates share a source; the filler must interleave a
        # different source between them (jump-cut prevention).
        pool = [
            {"itemId": "A", "segmentIndex": 0, "startTimeSeconds": 0, "endTimeSeconds": 10, "distance": 0.10},
            {"itemId": "A", "segmentIndex": 1, "startTimeSeconds": 20, "endTimeSeconds": 30, "distance": 0.11},
            {"itemId": "B", "segmentIndex": 0, "startTimeSeconds": 0, "endTimeSeconds": 10, "distance": 0.20},
        ]
        filled = rca._fill_spans([(0, 12000)], pool, set(),
                                 min_clip_ms=3000, target_clip_ms=4000, max_clip_ms=5000)
        ids = [c["mimirItemId"] for c in filled]
        for a, b in zip(ids, ids[1:]):
            assert a != b, f"same-source adjacency not avoided: {ids}"

    def test_prev_item_id_avoids_leading_repeat(self):
        # When the previous span ended on source A, the next span should not
        # open on A if another source can fill it.
        pool = [
            {"itemId": "A", "segmentIndex": 0, "startTimeSeconds": 0, "endTimeSeconds": 10, "distance": 0.10},
            {"itemId": "B", "segmentIndex": 0, "startTimeSeconds": 0, "endTimeSeconds": 10, "distance": 0.20},
        ]
        filled = rca._fill_spans([(0, 4000)], pool, set(),
                                 min_clip_ms=3000, target_clip_ms=4000, max_clip_ms=5000,
                                 prev_item_id="A")
        assert filled[0]["mimirItemId"] == "B"


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
# 6. create_or_update_linear_instance is script-only (no clip association)
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


class TestCreateInstanceScriptOnly:
    def _run(self):
        """Create-instance path (no existing instance) → POST with content."""
        posted = {}

        def fake_get(url, **kwargs):
            if url.endswith("/instances"):
                return _Resp(200, {"instances": []})  # no existing instance
            return _Resp(200, {"mTitle": "Test Story"})  # story title fetch

        def fake_post(url, **kwargs):
            posted["url"] = url
            posted["json"] = kwargs.get("json")
            return _Resp(200, {"id": "ORG-INS-NEW"})

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
                instance_title="Test Story - VO",
            )
        return json.loads(out), posted

    def test_create_returns_success_and_no_clip_fields(self):
        res, posted = self._run()
        assert res["status"] == "success"
        assert res["created"] is True
        assert res["sectionsWritten"] == 1
        # Script-only: the result never reports clip association.
        assert "clipsAssociated" not in res
        assert "clipAssociationError" not in res

    def test_create_posts_only_to_instances_never_assets(self):
        _, posted = self._run()
        # The create POST targets the story's instances endpoint (with inline
        # script content) — never the /assets clip-association endpoint.
        assert posted["url"].endswith("/instances")
        assert "content" in posted["json"]
        assert posted["json"]["title"] == "Test Story - VO"


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


# ---------------------------------------------------------------------------
# Idempotent, title-aware instance find-or-create (P1.1 prerequisite)
# ---------------------------------------------------------------------------

class TestInstanceIdempotency:
    def _inst(self, title, iid="OVkHBAPs-INS-1", account_id=None):
        return {"id": iid, "title": title,
                "platformInfo": {"platform": "linear",
                                 "account": {"accountId": account_id}}}

    def _run(self, existing_instances, instance_title):
        calls = {"patched": [], "created_titles": []}

        def fake_get(url, **k):
            if url.endswith("/instances"):
                return _Resp(200, {"instances": existing_instances})
            return _Resp(200, {"mTitle": "Car Racing"})

        def fake_post(url, **k):
            if url.endswith("/instances"):
                calls["created_titles"].append((k.get("json") or {}).get("title"))
                return _Resp(200, {"id": "OVkHBAPs-INS-NEW"})
            return _Resp(200, {})

        def fake_patch(url, **k):
            calls["patched"].append(url)
            return _Resp(200, {})

        fr = MagicMock()
        fr.get.side_effect = fake_get
        fr.post.side_effect = fake_post
        fr.patch.side_effect = fake_patch
        with patch.object(tools, "requests", fr), \
             patch.object(tools, "_get_saga_api_url", return_value="https://saga.test"), \
             patch.object(tools, "_saga_auth_headers", return_value={}):
            out = json.loads(tools.create_or_update_linear_instance(
                story_id="STR-1",
                script_sections_json=json.dumps([{"type": "vo", "label": "PKG VO:", "text": "hi"}]),
                instance_title=instance_title,
            ))
        return out, calls

    def test_rerun_reuses_same_titled_instance(self):
        # Re-running the same action updates its own instance — no duplicate.
        out, calls = self._run([self._inst("Car Racing - VO")], "Car Racing - VO")
        assert calls["patched"], "should PATCH the existing same-titled instance"
        assert not calls["created_titles"], "should NOT create a duplicate"
        assert out["created"] is False

    def test_does_not_clobber_a_different_actions_instance(self):
        # A VO run must not reuse the AI-VO instance — it creates its own.
        out, calls = self._run([self._inst("Car Racing - AI VO")], "Car Racing - VO")
        assert not calls["patched"]
        assert calls["created_titles"] == ["Car Racing - VO"]
        assert out["created"] is True

    def test_creates_titled_instance_when_none_exist(self):
        out, calls = self._run([], "Car Racing - VOSOT")
        assert calls["created_titles"] == ["Car Racing - VOSOT"]
        assert out["created"] is True



# ---------------------------------------------------------------------------
# Script synthesis prompt — editorial constraints (issue #21)
# ---------------------------------------------------------------------------

class TestSynthesizedScriptPromptConstraints:
    """The AI-VO script generation prompt must carry explicit constraints that
    station / network / channel identifiers appear at most once in the script,
    at the sign-off only. Carl's PSL AI-VO cut said 'CBS12' twice because the
    LLM mimicked a source transcript stand-up ('CBS12 reporter Antoinette...')
    AND invented a 'CBS12 News uncovered...' opener. Without the constraint in
    the prompt the LLM has no reason to limit repetitions.

    The prompt is built inside the function body (not a constant), so these
    tests capture it by stubbing Agent to record its input, then asserting the
    captured prompt string contains the editorial constraint markers.
    """

    def _capture_prompt(self, monkeypatch, shot_config=None):
        """Invoke rca._synthesize_script_from_transcripts with Agent stubbed to
        record the prompt it receives. Returns the captured prompt string.

        *shot_config* exercises the profile-aware length branching (short-form
        vs full package). Default None preserves the legacy (unconstrained)
        prompt shape so the existing identifier tests keep covering it.
        """
        captured = {}

        class _FakeAgent:
            def __init__(self, **kwargs):
                captured["system_prompt"] = kwargs.get("system_prompt", "")
            def __call__(self, prompt):
                captured["user_prompt"] = prompt
                return "SCRIPT OUTPUT"

        monkeypatch.setattr(rca, "Agent", _FakeAgent)
        monkeypatch.setattr(rca, "_get_bedrock_model", lambda: object())
        # No transcripts available — prompt still gets built from title /
        # content so synthesis proceeds (title + content pass the "any
        # material" check).
        rca._synthesize_script_from_transcripts(
            story_title="Any Story",
            story_description="",
            enriched_assets=[],
            story_content_text="Some substantive story context so synthesis runs.",
            shot_config=shot_config,
        )
        return captured

    def test_prompt_restricts_station_identifier_to_signoff(self, monkeypatch):
        prompt = self._capture_prompt(monkeypatch)["user_prompt"]
        p = prompt.lower()
        # The constraint must be present and name the behaviour unambiguously.
        assert "at most once" in p, (
            "Prompt must tell the model to use station identifiers at most once"
        )
        assert "sign-off" in p or "signoff" in p, (
            "Prompt must direct identifier placement to the sign-off"
        )
        # The constraint must specifically name the artefact class.
        assert ("station" in p and "network" in p) or "identifier" in p, (
            "Prompt must call out station/network identifiers specifically"
        )

    def test_prompt_warns_against_opening_with_station_name(self, monkeypatch):
        prompt = self._capture_prompt(monkeypatch)["user_prompt"].lower()
        # Classic failure mode: AI opens with '<CALLSIGN> News uncovered...'.
        # The prompt must explicitly disallow that so the LLM has a rule to
        # cite when composing the opener.
        assert "open" in prompt or "opening" in prompt, (
            "Prompt must mention the opener case so the LLM applies the rule there"
        )

    def test_prompt_tells_model_to_paraphrase_identifier_in_transcripts(self, monkeypatch):
        prompt = self._capture_prompt(monkeypatch)["user_prompt"].lower()
        # Carl's PSL cut's 'CBS12 reporter Antoinette...' came from an input
        # transcript. The prompt must tell the model to paraphrase around
        # identifiers it finds in transcripts, not quote them verbatim.
        assert "paraphrase" in prompt, (
            "Prompt must tell the model to paraphrase around transcript "
            "identifiers rather than quoting them verbatim"
        )


# ---------------------------------------------------------------------------
# Script synthesis — profile-aware length (issue #21 follow-up / issue #13)
# ---------------------------------------------------------------------------
# The script-synthesis prompt now shapes the target length from the active
# profile's shot_config. Without this, the LLM wrote a full package script
# (observed: 188s totalEstimatedDurationMs for a 30s AI-VO target) and the
# downstream timeline-assembly truncated — the result was a cut that dropped
# the back half of the story.

class TestSynthesisLengthByProfile:
    def _capture(self, monkeypatch, shot_config):
        captured = {}

        class _FakeAgent:
            def __init__(self, **kwargs):
                captured["system_prompt"] = kwargs.get("system_prompt", "")
            def __call__(self, prompt):
                captured["user_prompt"] = prompt
                return "SCRIPT OUTPUT"

        monkeypatch.setattr(rca, "Agent", _FakeAgent)
        monkeypatch.setattr(rca, "_get_bedrock_model", lambda: object())
        rca._synthesize_script_from_transcripts(
            story_title="Any Story",
            story_description="",
            enriched_assets=[],
            story_content_text="Some substantive story context so synthesis runs.",
            shot_config=shot_config,
        )
        return captured["user_prompt"]

    def test_short_form_profile_asks_for_short_vo_only_script(self, monkeypatch):
        """AI-VO / VO / VOSOT shot_config (target_video_duration_s <= 30)
        must produce a short-form read, NOT a full package script.
        """
        shot = profiles._shot_config()  # defaults: 20s script / 30s TRT
        prompt = self._capture(monkeypatch, shot).lower()
        # Length target communicated clearly
        assert "short-form" in prompt
        assert "20 seconds" in prompt
        assert "50 words" in prompt
        # Short-form must NOT also ask for anchor intro / SOT / tag
        assert "do not include an anchor" in prompt or "stripped-down" in prompt
        # The full-package wording must NOT appear
        assert "complete broadcast news package" not in prompt
        assert "90 seconds" not in prompt

    def test_package_profile_asks_for_full_package_at_target_trt(self, monkeypatch):
        """Package shot_config (target_video_duration_s > 30s) must produce a
        full package script with the right TRT and the right narration budget.
        """
        shot = profiles._shot_config(script_s=60, video_s=90)
        prompt = self._capture(monkeypatch, shot).lower()
        # Target total runtime surfaces the TRT
        assert "90 seconds" in prompt
        # Voice-over narration budget surfaces the script_duration
        assert "60 seconds" in prompt
        # Word budget derived from script_duration_s * 2.5
        assert "150 words" in prompt
        # Package wording keeps the anchor intro / SOT / tag structure
        assert "anchor introduction" in prompt
        assert "sot" in prompt
        assert "live tag" in prompt or "wrap" in prompt
        # Short-form opt-outs do NOT apply
        assert "stripped-down" not in prompt
        assert "20 seconds" not in prompt

    def test_no_shot_config_falls_back_to_legacy_package_wording(self, monkeypatch):
        """Backward compatibility: callers that pass no shot_config get the
        legacy 'complete broadcast news package script' wording."""
        prompt = self._capture(monkeypatch, shot_config=None).lower()
        assert "complete broadcast news package script" in prompt

    def test_package_profile_shot_config_targets_90s_trt(self):
        """The Package profile's shot_config carries the longer TRT target
        (~1:30 broadcast package convention), distinct from the short-form
        VO family's 30s target. Guards against accidental revert via a
        future refactor.
        """
        package_shot = profiles.get_profile("package")["shot"]
        assert package_shot["target_video_duration_s"] >= 60, (
            "Package profile should target a longer TRT than short-form "
            f"profiles. Got {package_shot['target_video_duration_s']}s."
        )
        assert package_shot["script_duration_s"] >= 40, (
            f"Package script read should be substantially longer than "
            f"short-form; got {package_shot['script_duration_s']}s."
        )
        # Short-form profiles still target 30s
        for name in ("vo", "vosot", "ai-vo"):
            short_shot = profiles.get_profile(name)["shot"]
            assert short_shot["target_video_duration_s"] <= 30, (
                f"{name} profile should stay short-form; "
                f"got {short_shot['target_video_duration_s']}s."
            )
