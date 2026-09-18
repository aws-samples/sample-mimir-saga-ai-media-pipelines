"""Rough-cut type profiles.

A "rough cut type" selects how the agent shapes the package. Each profile
contributes:

* two boolean behavior flags —

  - ``synthesize_voiceover``: whether the agent synthesizes an AI (Polly)
    voice-over for VO sections. This is the ONLY switch that turns AI narration
    on/off, keeping "Generate VO" (anchor reads live) strictly separate from
    "Generate AI VO" (reporter-driven digital/social).
  - ``include_sot``: whether sound-on-tape interview clips are part of the cut.

* a ``shot`` config block (script/video/shot-duration targets) so editorial
  defaults live in one clearly named place instead of being hard-coded in
  prompt prose.

* extra directives appended to the Script Analysis and Timeline Assembly system
  prompts, built FROM the shot config so the numbers never drift out of sync
  with the code that enforces them.

The active type arrives on the agent payload as ``roughCutType`` (set by the
Saga custom-action route via saga-action-handler). Unknown/missing values fall
back to ``full`` (the original, unconstrained behavior).

Editorial defaults are overridable via environment variables so operators can
tune them per deployment without a code change.
"""

import os

DEFAULT_ROUGH_CUT_TYPE = "ai-vo"


def _env_int(name: str, default: int) -> int:
    """Read a non-negative int from the environment, falling back to *default*."""
    try:
        val = int(os.environ.get(name, "").strip())
        return val if val > 0 else default
    except (ValueError, AttributeError):
        return default


# ---------------------------------------------------------------------------
# Editorial defaults (Sinclair) — named constants, env-overridable
# ---------------------------------------------------------------------------
# Standard VO: ~20s script read, ~30s of usable video (the extra ~10s is
# intentional padding for anchor read-speed variation and editorial trimming;
# it need NOT be split symmetrically head/tail). Shots target ~4s and should
# stay within a 3–5s band.
VO_SCRIPT_DURATION_S = _env_int("VO_SCRIPT_DURATION_S", 20)
VO_TARGET_VIDEO_DURATION_S = _env_int("VO_TARGET_VIDEO_DURATION_S", 30)
TARGET_SHOT_DURATION_S = _env_int("TARGET_SHOT_DURATION_S", 4)
MIN_SHOT_DURATION_S = _env_int("MIN_SHOT_DURATION_S", 3)
MAX_SHOT_DURATION_S = _env_int("MAX_SHOT_DURATION_S", 5)


def _shot_config(script_s=None, video_s=None, target_shot_s=None,
                 min_shot_s=None, max_shot_s=None) -> dict:
    """Assemble a shot/duration config block from the editorial defaults."""
    return {
        "script_duration_s": script_s if script_s is not None else VO_SCRIPT_DURATION_S,
        "target_video_duration_s": video_s if video_s is not None else VO_TARGET_VIDEO_DURATION_S,
        "target_shot_duration_s": target_shot_s if target_shot_s is not None else TARGET_SHOT_DURATION_S,
        "min_shot_duration_s": min_shot_s if min_shot_s is not None else MIN_SHOT_DURATION_S,
        "max_shot_duration_s": max_shot_s if max_shot_s is not None else MAX_SHOT_DURATION_S,
    }


# Shared editorial guidance on shot composition. Applied to VO/VOSOT/AI-VO cuts
# so clip selection follows Sinclair's expectations. Kept generic (no customer
# name) and parameterized by the shot config.
def _composition_directive(shot: dict) -> str:
    return (
        "\n\n## EDITORIAL SHOT COMPOSITION\n"
        f"- Target shot length ~{shot['target_shot_duration_s']}s; keep every shot "
        f"within {shot['min_shot_duration_s']}–{shot['max_shot_duration_s']} seconds. "
        f"Do NOT intentionally use shots longer than {shot['max_shot_duration_s']}s "
        "unless there is a clear editorial reason (e.g. an unbroken action beat).\n"
        "- Prefer sequential news coverage that mixes WIDE (establishing), MEDIUM, "
        "and TIGHT (close-up) shots, and favor steady, usable footage.\n"
        "- Support handheld or mildly unstable breaking-news footage gracefully — "
        "do NOT reject all unstable footage; only avoid genuinely unusable (violently "
        "shaky / operator-hunting) frames.\n"
        "- Avoid repetitive coverage (near-duplicate shots back to back) and never use "
        "video that does not support the words in the script.\n"
        "- Keep enough representative coverage that the result is close to air-ready.\n"
    )


def _vo_only_script_directive(shot: dict) -> str:
    """Script-analysis directive for VO-only cuts (no SOT/interview)."""
    return (
        "\n\n## ROUGH CUT MODE OVERRIDE: VOICE-OVER ONLY\n"
        "Produce a STRIPPED-DOWN, VOICE-OVER-ONLY package. These rules OVERRIDE "
        "any conflicting guidance above:\n"
        "- VOICE-OVER ONLY. Do NOT include soundbites or interview segments. "
        "The `soundbites` and `interviewSegments` arrays MUST be empty.\n"
        "- Every entry in `parsedSections` MUST be type `pkg_vo` (voice-over) or "
        "`pkg_nats` (natural sound). Do NOT emit `pkg_sot`, `anchor_qa`, "
        "`reporter_live`, `anchor_intro`, `live_tag`, or `super` sections.\n"
        f"- Keep the total voice-over read to ABOUT {shot['script_duration_s']} SECONDS "
        f"(~{max(1, round(shot['script_duration_s'] * 2.5))} words). Be concise.\n"
        f"- Set `totalEstimatedDurationMs` to about "
        f"{shot['target_video_duration_s'] * 1000} "
        f"({shot['target_video_duration_s']} seconds) or less.\n"
        "- Use short `pkg_nats` beats for texture where natural sound is available.\n"
    )


def _vosot_script_directive(shot: dict) -> str:
    """Script-analysis directive for VO+SOT cuts."""
    return (
        "\n\n## ROUGH CUT MODE OVERRIDE: VO + SOT\n"
        "Produce a VO-driven package that ALSO incorporates appropriate "
        "sound-on-tape (SOT) interview soundbites. These rules OVERRIDE any "
        "conflicting guidance above:\n"
        "- Build the narrative primarily from `pkg_vo` voice-over, but include "
        "`pkg_sot` soundbites where an interviewee's own words carry the story.\n"
        "- Preserve natural sound: use `pkg_nats` beats where natural sound is "
        "available, and keep nat sound under B-roll cover.\n"
        "- Keep soundbites tight — the interviewee's answer only, never the "
        "interviewer's question.\n"
    )


def _vo_timeline_directive(shot: dict, with_sot: bool, synth: bool = True) -> str:
    """Timeline-assembly directive for VO / VOSOT / AI-VO cuts."""
    target_video_ms = shot["target_video_duration_s"] * 1000
    script_ms = shot["script_duration_s"] * 1000
    pad_total_ms = max(0, target_video_ms - script_ms)
    sot_line = (
        "- Interview SOT clips belong on V1 with their audio at full gain; keep "
        "them tight to the interviewee's answer.\n"
        if with_sot
        else "- Do NOT place interview/SOT clips on the timeline.\n"
    )
    # When no AI voice is synthesized, the anchor reads the script live: the A1
    # voice-over track must stay empty (never invent placeholder VO items).
    vo_line = (
        ""
        if synth
        else "- The A1 Voice-over track MUST remain EMPTY. The script is read LIVE "
        "by an anchor; do NOT place any voice-over audio clips or invent VO items.\n"
    )
    return (
        "\n\n## ROUGH CUT MODE OVERRIDE: SHORT VO TIMELINE\n"
        "Assemble a SHORT, VO-driven timeline with natural-sound padding. These "
        "rules OVERRIDE any conflicting guidance above:\n"
        f"- TARGET STRUCTURE — total timeline ~{shot['target_video_duration_s']} "
        f"seconds. The voice-over read is ~{shot['script_duration_s']} seconds; the "
        f"remaining ~{round(pad_total_ms / 1000)} seconds is intentional PADDING of "
        "B-roll with natural sound and NO voice-over, for anchor read-speed "
        "variation and editorial trimming.\n"
        "- Distribute the pad as a cold-open head and a tail (roughly "
        f"{round(pad_total_ms / 2000)}s each is a good starting point, but the split "
        "need NOT be exactly symmetrical). Do NOT let the voice-over span the entire "
        "timeline.\n"
        f"- Every B-roll shot MUST be SHORT: about {shot['target_shot_duration_s']} "
        f"seconds, within {shot['min_shot_duration_s']}–{shot['max_shot_duration_s']} "
        f"seconds. Trim/split any longer source clip so no single clip exceeds "
        f"{shot['max_shot_duration_s'] * 1000} ms.\n"
        "- Prefer steady, usable B-roll; mix wide/medium/tight coverage.\n"
        "- Put natural sound under the head and tail pads; keep the VO clean in the "
        "body.\n"
        + sot_line
        + vo_line
    )


ROUGH_CUT_PROFILES = {
    # Generate Package — the full rough cut: script + B-roll + SOT + AI voice,
    # unconstrained (no VO-only / 30s-cap directives). This is the "Package"
    # custom action (the original full rough-cut behavior).
    "package": {
        "label": "Generate Package",
        "timeline_suffix": "Package",
        "synthesize_voiceover": True,
        "include_sot": True,
        "shot": _shot_config(),
        "script_directive": "",
        "timeline_directive": "",
    },
    # Generate VO — script + supporting B-roll rough cut for LINEAR TV, where an
    # anchor reads the script live. NEVER synthesizes an AI voice.
    "vo": {
        "label": "Generate VO",
        "timeline_suffix": "VO",
        "synthesize_voiceover": False,
        "include_sot": False,
        "shot": _shot_config(),
        "script_directive": _vo_only_script_directive(_shot_config()),
        "timeline_directive": (
            _vo_timeline_directive(_shot_config(), with_sot=False, synth=False)
            + _composition_directive(_shot_config())
        ),
    },
    # Generate VOSOT — VO plus appropriate sound-on-tape interview clips, nat
    # sound preserved. Anchor reads the VO live, so still NO AI voice.
    "vosot": {
        "label": "Generate VOSOT",
        "timeline_suffix": "VOSOT",
        # VOSOT produces TWO linear instances so the anchor can start the SOT on
        # their own timing: "<story> - VOSOT VO" (VO + nat sound) and
        # "<story> - VOSOT SOT" (the soundbite(s)). ("<story> - VO" is reserved
        # for the plain Generate VO action.)
        "split_vo_sot": True,
        "synthesize_voiceover": False,
        "include_sot": True,
        "shot": _shot_config(),
        "script_directive": _vosot_script_directive(_shot_config()),
        "timeline_directive": (
            _vo_timeline_directive(_shot_config(), with_sot=True, synth=False)
            + _composition_directive(_shot_config())
        ),
    },
    # Generate AI VO — reporter-driven digital/social workflow that DOES require
    # synthesized narration. This is the only VO-family profile that turns AI
    # voice on.
    "ai-vo": {
        "label": "Generate AI VO",
        "timeline_suffix": "AI VO",
        "synthesize_voiceover": True,
        "include_sot": False,
        "shot": _shot_config(),
        "script_directive": _vo_only_script_directive(_shot_config()),
        "timeline_directive": (
            _vo_timeline_directive(_shot_config(), with_sot=False)
            + _composition_directive(_shot_config())
        ),
    },
}


def get_profile(rough_cut_type):
    """Return the profile dict for *rough_cut_type*, defaulting to ``ai-vo``."""
    if not rough_cut_type:
        rough_cut_type = DEFAULT_ROUGH_CUT_TYPE
    return ROUGH_CUT_PROFILES.get(
        rough_cut_type, ROUGH_CUT_PROFILES[DEFAULT_ROUGH_CUT_TYPE]
    )
