"""Rough-cut type profiles.

A "rough cut type" selects how aggressively the agent shapes the package. Each
profile contributes extra directives that are appended to the Script Analysis
and Timeline Assembly system prompts, steering the *kind* of cut produced
without changing the pipeline itself.

The active type arrives on the agent payload as ``roughCutType`` (set by the
Saga custom action route via saga-action-handler). Unknown/missing values fall
back to ``full`` (the original, unconstrained behavior).
"""

DEFAULT_ROUGH_CUT_TYPE = "full"

ROUGH_CUT_PROFILES = {
    # Original behavior — no extra constraints.
    "full": {
        "label": "Full Package",
        "script_directive": "",
        "timeline_directive": "",
    },
    # Stripped-down, VO-only cut for early user feedback:
    # ~4s shots, ~30s total video, ~20s script, natural sound.
    "simple-vo": {
        "label": "Simple VO",
        "script_directive": (
            "\n\n## ROUGH CUT MODE OVERRIDE: SIMPLE VO\n"
            "Produce a STRIPPED-DOWN, VOICE-OVER-ONLY package. These rules OVERRIDE "
            "any conflicting guidance above:\n"
            "- VOICE-OVER ONLY. Do NOT include soundbites or interview segments. "
            "The `soundbites` and `interviewSegments` arrays MUST be empty.\n"
            "- Every entry in `parsedSections` MUST be type `pkg_vo` (voice-over) or "
            "`pkg_nats` (natural sound). Do NOT emit `pkg_sot`, `anchor_qa`, "
            "`reporter_live`, `anchor_intro`, `live_tag`, or `super` sections.\n"
            "- Keep the total voice-over read to ABOUT 20 SECONDS (~50 words). Be concise.\n"
            "- Set `totalEstimatedDurationMs` to about 30000 (30 seconds) or less.\n"
            "- Use short `pkg_nats` beats for texture where natural sound is available.\n"
        ),
        "timeline_directive": (
            "\n\n## ROUGH CUT MODE OVERRIDE: SIMPLE VO\n"
            "Assemble a SHORT, VO-driven timeline with nat-sound bookends. These "
            "rules OVERRIDE any conflicting guidance above:\n"
            "- TARGET STRUCTURE — total timeline ~30 seconds, laid out as:\n"
            "    * HEAD PAD: first ~5 seconds = B-roll with NATURAL SOUND and NO "
            "voice-over (a cold open).\n"
            "    * BODY: middle ~20 seconds = the voice-over read over stable "
            "B-roll. The voice-over audio starts at ~5s and ends at ~25s.\n"
            "    * TAIL PAD: last ~5 seconds = B-roll with NATURAL SOUND and NO "
            "voice-over.\n"
            "  So there is ~5s of pad on the FRONT and ~5s on the BACK, with ~20s "
            "of VO in the middle. Do NOT let the voice-over span the entire "
            "timeline.\n"
            "- Every B-roll shot MUST be SHORT: about 4 seconds, and NEVER longer "
            "than 4 seconds. Trim/split any longer source clip so no single clip "
            "exceeds 4000 ms.\n"
            "- Prefer camera-stable (locked-off) B-roll for every shot.\n"
            "- Put natural sound under the head and tail pads; keep the VO clean in "
            "the body.\n"
            "- Do NOT place interview/SOT clips on the timeline.\n"
        ),
    },
}


def get_profile(rough_cut_type):
    """Return the profile dict for *rough_cut_type*, defaulting to ``full``."""
    if not rough_cut_type:
        rough_cut_type = DEFAULT_ROUGH_CUT_TYPE
    return ROUGH_CUT_PROFILES.get(
        rough_cut_type, ROUGH_CUT_PROFILES[DEFAULT_ROUGH_CUT_TYPE]
    )
