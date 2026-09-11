from bedrock_agentcore.runtime import BedrockAgentCoreApp
from strands import Agent
from strands.models import BedrockModel
from prompts import SCRIPT_ANALYSIS_PROMPT, SOURCE_MATERIAL_PROMPT, TIMELINE_ASSEMBLY_PROMPT
from profiles import get_profile, DEFAULT_ROUGH_CUT_TYPE
from tools import get_transcript, get_generated_transcript, query_embeddings, get_mimir_item_details, create_timeline, update_story_status, get_word_timing, generate_voiceover, upload_voiceover_to_mimir, create_or_update_linear_instance, _build_linear_instance_slate, sanitize_for_tts
import json
import logging
import os
import re
import sys
import boto3

# Configure logging so the agent's own INFO logs reach stdout (and therefore the
# AgentCore CloudWatch runtime logs). Without an explicit handler, the root
# logger only emits WARNING+ via Python's lastResort handler, which silently
# dropped every INFO diagnostic (stage progress, "Loaded stability maps",
# "B-roll candidate pool: N stable segments", etc.) — making runs impossible to
# audit even though the code was executing.
logger = logging.getLogger()
logger.setLevel(logging.INFO)
if not logger.handlers:
    _log_handler = logging.StreamHandler(sys.stdout)
    _log_handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s %(message)s"))
    logger.addHandler(_log_handler)

app = BedrockAgentCoreApp()

# Initialize Step Functions client for callbacks
stepfunctions = boto3.client('stepfunctions')


def send_task_success(task_token: str, timeline_item_id: str, summary: dict):
    """Send success callback to Step Functions with timeline results."""
    try:
        output = {
            "timelineItemId": timeline_item_id,
            "summary": summary,
        }
        stepfunctions.send_task_success(
            taskToken=task_token,
            output=json.dumps(output),
        )
        logger.info(f"SendTaskSuccess sent for timeline item {timeline_item_id}")
    except Exception as e:
        logger.error(f"Failed to send task success: {e}")
        raise


def send_task_failure(task_token: str, error: str, cause: str):
    """Send failure callback to Step Functions with error details."""
    try:
        stepfunctions.send_task_failure(
            taskToken=task_token,
            error=error,
            cause=cause,
        )
        logger.info(f"SendTaskFailure sent: {error}")
    except Exception as e:
        logger.error(f"Failed to send task failure: {e}")


# ---------------------------------------------------------------------------
# Script Analysis Agent (Graph Node — Task 5.2)
# ---------------------------------------------------------------------------

# Required top-level keys in the ScriptAnalysis output
_SCRIPT_ANALYSIS_REQUIRED_KEYS = {
    "lead", "body", "wrapUp", "soundbites", "interviewSegments", "voiceOverSections",
    "scriptFormat", "parsedSections", "totalEstimatedDurationMs",
}

# Valid values for scriptFormat
_VALID_SCRIPT_FORMATS = {"broadcast_script", "story_overview"}

# Valid section types for parsedSections entries
_VALID_SECTION_TYPES = {
    "anchor_intro", "reporter_live", "pkg_vo", "pkg_sot", "pkg_nats",
    "live_tag", "anchor_qa", "super",
}

# Required keys in each parsedSections entry
_PARSED_SECTION_REQUIRED_KEYS = {"sectionType", "content", "orderIndex", "estimatedDurationMs"}


def _validate_script_analysis(data: dict) -> None:
    """Validate that *data* conforms to the ScriptAnalysis schema.

    Raises ``ValueError`` when required fields are missing or have the wrong
    shape.  Only structural checks are performed — content quality is left to
    the LLM.
    """
    missing = _SCRIPT_ANALYSIS_REQUIRED_KEYS - set(data.keys())
    if missing:
        raise ValueError(f"ScriptAnalysis missing required keys: {missing}")

    # scriptFormat
    script_format = data["scriptFormat"]
    if script_format not in _VALID_SCRIPT_FORMATS:
        raise ValueError(
            f"scriptFormat must be one of {_VALID_SCRIPT_FORMATS}, got: {script_format!r}"
        )

    # parsedSections
    parsed_sections = data["parsedSections"]
    if not isinstance(parsed_sections, list):
        raise ValueError("parsedSections must be an array")
    for i, section in enumerate(parsed_sections):
        if not isinstance(section, dict):
            raise ValueError(f"parsedSections[{i}] must be an object")
        section_missing = _PARSED_SECTION_REQUIRED_KEYS - set(section.keys())
        if section_missing:
            raise ValueError(
                f"parsedSections[{i}] missing required keys: {section_missing}"
            )
        if section["sectionType"] not in _VALID_SECTION_TYPES:
            raise ValueError(
                f"parsedSections[{i}].sectionType must be one of "
                f"{_VALID_SECTION_TYPES}, got: {section['sectionType']!r}"
            )
        if not isinstance(section["estimatedDurationMs"], (int, float)):
            raise ValueError(
                f"parsedSections[{i}].estimatedDurationMs must be a number"
            )

    # totalEstimatedDurationMs
    if not isinstance(data["totalEstimatedDurationMs"], (int, float)):
        raise ValueError("totalEstimatedDurationMs must be a number")

    # lead
    lead = data["lead"]
    if not isinstance(lead, dict):
        raise ValueError("lead must be an object")
    for key in ("content", "hookType", "estimatedDurationMs"):
        if key not in lead:
            raise ValueError(f"lead missing required key: {key}")

    # body
    body = data["body"]
    if not isinstance(body, dict) or "mainPoints" not in body:
        raise ValueError("body must be an object with a mainPoints array")
    if not isinstance(body["mainPoints"], list):
        raise ValueError("body.mainPoints must be an array")

    # wrapUp
    wrap_up = data["wrapUp"]
    if not isinstance(wrap_up, dict):
        raise ValueError("wrapUp must be an object")
    for key in ("content", "closureType"):
        if key not in wrap_up:
            raise ValueError(f"wrapUp missing required key: {key}")

    # Arrays
    for key in ("soundbites", "interviewSegments", "voiceOverSections"):
        if not isinstance(data[key], list):
            raise ValueError(f"{key} must be an array")


def run_script_analysis(story_context: dict, profile_directive: str = "") -> dict:
    """Analyze a story script and return a structured ScriptAnalysis dict.

    This function creates a Strands Agent with the SCRIPT_ANALYSIS_PROMPT,
    sends the story context as a user message, parses the JSON response, and
    validates it against the ScriptAnalysis schema.

    Args:
        story_context: Dict with keys ``title``, ``description``, ``script``,
            ``research`` (optional research section text), and ``notes``
            (list of note dicts).

    Returns:
        A dict conforming to the ScriptAnalysis schema (lead, body, wrapUp,
        soundbites, interviewSegments, voiceOverSections).

    Raises:
        ValueError: If the agent output cannot be parsed or fails validation.

    Requirements: 5.1, 5.2, 5.3, 5.4, 5.5
    """
    title = story_context.get("title", "")
    description = story_context.get("description", "")
    script = story_context.get("script", "")
    research = story_context.get("research", "")
    model_knowledge = story_context.get("model_knowledge", "")
    notes = story_context.get("notes", [])

    # Format editorial notes into a readable block.
    # Notes from story-research-handler have title + description fields.
    # Legacy notes may have type + content fields — handle both.
    notes_text = ""
    if notes:
        note_lines = []
        for note in notes:
            note_title = note.get("title", note.get("type", "note"))
            note_content = note.get("description", note.get("content", ""))
            if note_content:
                note_lines.append(f"- [{note_title}] {note_content}")
        notes_text = "\n".join(note_lines)

    # Build the user message with all available story context
    research_section = (
        f"## Research / Background\n{research}\n\n"
        if research
        else ""
    )
    knowledge_section = (
        f"## Background Knowledge (from AI)\n{model_knowledge}\n\n"
        if model_knowledge
        else ""
    )
    user_message = (
        f"## Story Title\n{title}\n\n"
        f"## Story Description\n{description}\n\n"
        f"{research_section}"
        f"{knowledge_section}"
        f"## Script\n{script}\n\n"
        f"## Editorial Notes\n{notes_text if notes_text else 'No editorial notes provided.'}"
    )

    logger.info(f"Running Script Analysis Agent for story: {title}")

    # Create a dedicated agent for script analysis
    # Use SCRIPT_ANALYSIS_MODEL_ID if set, otherwise fall back to AGENT_MODEL_ID
    bedrock_model = _get_bedrock_model(env_key="SCRIPT_ANALYSIS_MODEL_ID")

    agent = Agent(
        model=bedrock_model,
        system_prompt=SCRIPT_ANALYSIS_PROMPT + (profile_directive or ""),
    )

    # Invoke the agent
    result = agent(user_message)

    # Extract the text response from the agent result
    response_text = str(result)

    # Parse JSON from the response — the prompt asks for raw JSON but the
    # model may occasionally wrap it in markdown fences.
    json_match = re.search(r"```(?:json)?\s*([\s\S]*?)```", response_text)
    if json_match:
        json_str = json_match.group(1).strip()
    else:
        json_str = response_text.strip()

    try:
        analysis = json.loads(json_str)
    except json.JSONDecodeError as exc:
        raise ValueError(
            f"Script Analysis Agent returned invalid JSON: {exc}"
        ) from exc

    # Validate the parsed output
    _validate_script_analysis(analysis)

    logger.info("Script analysis completed and validated successfully")
    return analysis


# ---------------------------------------------------------------------------
# Source Material Agent (Graph Node — Task 6.1)
# ---------------------------------------------------------------------------


_VALID_TRACK_PLACEMENTS = {"v1_aroll", "v2_broll"}
_VALID_AUDIO_TYPES = {"interview", "nats", "none"}
_VALID_MATCH_CONFIDENCES = {"high", "medium", "low"}
_VALID_VOICEOVER_SOURCES = {"reporter_provided", "polly_generated"}


def _validate_source_material(data: dict) -> None:
    """Validate that *data* conforms to the Source Material output schema.

    Lenient validation — defaults missing fields instead of raising.
    """
    if "candidateSegments" not in data:
        data["candidateSegments"] = []
    if not isinstance(data["candidateSegments"], list):
        raise ValueError("candidateSegments must be an array")

    for i, segment in enumerate(data["candidateSegments"]):
        if "scriptSection" not in segment:
            segment["scriptSection"] = "unknown"
        if "candidates" not in segment or not isinstance(segment.get("candidates"), list):
            segment["candidates"] = []

        for j, candidate in enumerate(segment["candidates"]):
            cpath = f"candidateSegments[{i}].candidates[{j}]"

            if "trackPlacement" in candidate:
                if candidate["trackPlacement"] not in _VALID_TRACK_PLACEMENTS:
                    raise ValueError(
                        f"{cpath}.trackPlacement must be one of "
                        f"{_VALID_TRACK_PLACEMENTS}, got: {candidate['trackPlacement']!r}"
                    )

            if "audioType" in candidate:
                if candidate["audioType"] not in _VALID_AUDIO_TYPES:
                    raise ValueError(
                        f"{cpath}.audioType must be one of "
                        f"{_VALID_AUDIO_TYPES}, got: {candidate['audioType']!r}"
                    )

            if "matchConfidence" in candidate:
                if candidate["matchConfidence"] not in _VALID_MATCH_CONFIDENCES:
                    raise ValueError(
                        f"{cpath}.matchConfidence must be one of "
                        f"{_VALID_MATCH_CONFIDENCES}, got: {candidate['matchConfidence']!r}"
                    )

            if "voiceoverSource" in candidate:
                if candidate["voiceoverSource"] is not None and candidate["voiceoverSource"] not in _VALID_VOICEOVER_SOURCES:
                    raise ValueError(
                        f"{cpath}.voiceoverSource must be one of "
                        f"{_VALID_VOICEOVER_SOURCES}, got: {candidate['voiceoverSource']!r}"
                    )

    # coveragePercentage — default to 0 if missing, validate type if present
    if "coveragePercentage" not in data:
        data["coveragePercentage"] = 0
    elif not isinstance(data["coveragePercentage"], (int, float)):
        raise ValueError("coveragePercentage must be a number")

    if "gaps" not in data:
        data["gaps"] = []
    if not isinstance(data["gaps"], list):
        data["gaps"] = []

    for i, gap in enumerate(data["gaps"]):
        if "scriptSection" not in gap:
            gap["scriptSection"] = "unknown"
        if "unmatchedContent" not in gap:
            gap["unmatchedContent"] = ""


# ---------------------------------------------------------------------------
# Configurable Bedrock Model Helper
# ---------------------------------------------------------------------------

_DEFAULT_MODEL_ID = "us.amazon.nova-premier-v1:0"
_DEFAULT_MAX_TOKENS = 10000
_CLAUDE_MAX_TOKENS = 16000


def _get_bedrock_model(env_key: str = "AGENT_MODEL_ID") -> BedrockModel:
    """Return a BedrockModel configured from an environment variable.

    Args:
        env_key: Environment variable name to read the model ID from.
            Defaults to ``AGENT_MODEL_ID``. Falls back to ``AGENT_MODEL_ID``
            if the specified key is empty.

    Logic:
    1. Read the model ID from ``os.environ[env_key]``, falling back to
       ``AGENT_MODEL_ID`` if empty.
    2. If empty or not set → return BedrockModel with the default Nova Premier.
    3. If set and contains "claude" (case-insensitive) → set max_tokens to 16000.
    4. Attempt a lightweight Bedrock validation call to verify the model is
       accessible.
    5. On failure → log a warning and fall back to the default model.

    The returned model always uses ``temperature=0.3`` and ``streaming=False``.
    """
    model_id = os.environ.get(env_key, "").strip()
    if not model_id and env_key != "AGENT_MODEL_ID":
        model_id = os.environ.get("AGENT_MODEL_ID", "").strip()

    if not model_id:
        logger.info(f"AGENT_MODEL_ID not set, using default model: {_DEFAULT_MODEL_ID}")
        return BedrockModel(
            model_id=_DEFAULT_MODEL_ID,
            temperature=0.3,
            streaming=False,
            max_tokens=_DEFAULT_MAX_TOKENS,
        )

    # Determine max_tokens based on model family
    max_tokens = _DEFAULT_MAX_TOKENS
    if "claude" in model_id.lower():
        max_tokens = _CLAUDE_MAX_TOKENS
        logger.info(f"Claude model detected, setting max_tokens to {_CLAUDE_MAX_TOKENS}")

    # Validate model accessibility with a lightweight Bedrock call
    try:
        bedrock_client = boto3.client("bedrock-runtime")
        bedrock_client.converse(
            modelId=model_id,
            messages=[{"role": "user", "content": [{"text": "hi"}]}],
            inferenceConfig={"maxTokens": 1},
        )
        logger.info(f"Model {model_id} validated successfully")
    except Exception as e:
        logger.warning(
            f"Model {model_id} is not accessible ({e}), "
            f"falling back to default: {_DEFAULT_MODEL_ID}"
        )
        model_id = _DEFAULT_MODEL_ID
        max_tokens = _DEFAULT_MAX_TOKENS

    return BedrockModel(
        model_id=model_id,
        temperature=0.3,
        streaming=False,
        max_tokens=max_tokens,
    )


def _load_stability_cache(enriched_assets: list, staging_bucket: str,
                          raw: bool = False) -> dict:
    """Loads per-clip camera-stability maps written at ingest by the
    stability-analysis handler (stability/{itemId}/segments.json).

    Default: returns {itemId: [{startMs, endMs, label: usable|unusable}, ...]}.
    With ``raw=True``: returns the full stability JSON per clip (including the
    per-second metrics), so callers can re-derive spans with stricter rules
    (e.g. stable-only for B-roll). Clips without a stability file are simply
    absent — consumers treat that as "no stability data, don't filter".
    """
    cache = {}
    if not staging_bucket:
        return cache
    s3c = boto3.client("s3")
    for asset in enriched_assets:
        mid = asset.get("mimirItemId", "")
        if not mid:
            continue
        try:
            resp = s3c.get_object(Bucket=staging_bucket, Key=f"stability/{mid}/segments.json")
            data = json.loads(resp["Body"].read())
            if raw:
                cache[mid] = data
            elif data.get("segments"):
                cache[mid] = data["segments"]
        except Exception:
            pass
    logger.info(f"Loaded stability maps for {len(cache)} clips")
    return cache


def _stability_trim(item_id: str, start_s: float, end_s: float,
                    stability_cache: dict, min_clip_s: float = 2.0):
    """Constrains a candidate window to camera-stable footage.

    Intersects [start_s, end_s] with the clip's usable segments and returns the
    LARGEST usable sub-window as (start_s, end_s), or None when the window is
    entirely (or almost entirely) shaky/hunting footage. Windows for clips
    without stability data pass through unchanged.
    """
    segments = stability_cache.get(item_id)
    if not segments:
        return (start_s, end_s)

    win_start_ms = start_s * 1000
    win_end_ms = end_s * 1000
    best = None
    for seg in segments:
        if seg.get("label") != "usable":
            continue
        lo = max(win_start_ms, seg["startMs"])
        hi = min(win_end_ms, seg["endMs"])
        if hi - lo > (best[1] - best[0] if best else 0):
            best = (lo, hi)

    if not best or (best[1] - best[0]) < min_clip_s * 1000:
        return None
    return (best[0] / 1000.0, best[1] / 1000.0)


# Interrogative openers used (with a trailing "?") to detect an interviewer's
# question in a transcript sentence, so it can be excluded from a soundbite.
_INTERROGATIVE_OPENERS = (
    "what", "how", "why", "when", "where", "who", "which", "whose",
    "can you", "could you", "do you", "did you", "would you", "will you",
    "are you", "were you", "have you", "has ", "is there", "tell me",
    "talk about", "talk to me", "walk me through", "describe", "explain",
)


def _is_question(text: str) -> bool:
    """Heuristic: is this transcript sentence an interviewer's question?

    True when it ends with '?' or opens with a common interrogative. Used to
    exclude the reporter's question from the start/end of an interview soundbite.
    Works on any transcript source (Mimir or AWS Transcribe) since both carry
    sentence punctuation.
    """
    t = (text or "").strip().lower()
    if not t:
        return False
    if t.endswith("?"):
        return True
    return any(t.startswith(opener) for opener in _INTERROGATIVE_OPENERS)


def _precompute_candidates(parsed_sections: list, enriched_assets: list, top_k: int = 5) -> dict:
    """Pre-compute embedding candidates for all parsed sections outside the agent loop.

    Runs one embedding query per section in Python, returning the top-k
    candidates per section. For pkg_vo sections, also runs a separate query
    filtered to B-roll assets (short transcripts) to ensure cover footage
    is surfaced even when interview clips rank higher semantically.

    Args:
        parsed_sections: List of parsed section dicts from script analysis.
        enriched_assets: List of enriched asset dicts with mimirItemId.
        top_k: Number of candidates to return per section.

    Returns:
        Dict mapping section key → list of candidate dicts with itemId,
        distance, startTimeSeconds, endTimeSeconds.
    """
    item_ids = [a["mimirItemId"] for a in enriched_assets if a.get("hasEmbeddings")]
    if not item_ids:
        logger.warning("No assets with embeddings — skipping pre-computation")
        return {}

    vector_bucket = os.environ.get("VECTOR_BUCKET_NAME", "")
    index_name = os.environ.get("VECTOR_INDEX_NAME", "")
    if not vector_bucket or not index_name:
        logger.warning("Vector bucket/index not configured — skipping pre-computation")
        return {}

    s3vectors = boto3.client("s3vectors")
    bedrock = boto3.client("bedrock-runtime")

    # Classify assets by transcript length to identify likely B-roll
    # B-roll clips tend to have short/no transcripts (< 100 words)
    broll_item_ids = []
    staging_bucket = os.environ.get("TRANSCRIPT_STAGING_BUCKET", "")
    if staging_bucket:
        s3 = boto3.client("s3")
        for asset in enriched_assets:
            mid = asset.get("mimirItemId", "")
            if not mid or not asset.get("hasEmbeddings"):
                continue
            try:
                key = f"transcripts/{mid}/transcript.json"
                resp = s3.get_object(Bucket=staging_bucket, Key=key)
                data = json.loads(resp["Body"].read())
                word_count = len(data.get("fullTranscript", "").split())
                if word_count < 50:
                    broll_item_ids.append(mid)
            except Exception:
                # No transcript = likely B-roll
                broll_item_ids.append(mid)

        logger.info(f"Classified {len(broll_item_ids)} assets as likely B-roll (< 50 transcript words)")

    # Pre-load transcripts for SOT matching (transcript text search)
    transcript_cache = {}  # itemId -> transcript dict
    if staging_bucket:
        s3_tx = boto3.client("s3")
        for asset in enriched_assets:
            mid = asset.get("mimirItemId", "")
            if not mid or not asset.get("hasEmbeddings"):
                continue
            try:
                key = f"transcripts/{mid}/transcript.json"
                resp = s3_tx.get_object(Bucket=staging_bucket, Key=key)
                transcript_cache[mid] = json.loads(resp["Body"].read())
            except Exception:
                pass
        logger.info(f"Loaded {len(transcript_cache)} transcripts for SOT matching")

    # Camera-stability maps: used to keep shaky/hunting footage out of B-roll
    # picks. These live in the durable media-analysis bucket (STABILITY_BUCKET),
    # not the transient staging bucket, so they persist beyond staging's expiry.
    stability_bucket = os.environ.get("STABILITY_BUCKET") or staging_bucket
    stability_cache = _load_stability_cache(enriched_assets, stability_bucket)

    candidates_by_section = {}

    for section in parsed_sections:
        section_key = f"{section['sectionType']}_{section['orderIndex']}"
        text = section.get("content", "")
        if not text.strip():
            continue

        try:
            # Generate embedding
            embed_resp = bedrock.invoke_model(
                modelId="amazon.nova-2-multimodal-embeddings-v1:0",
                contentType="application/json",
                accept="application/json",
                body=json.dumps({
                    "taskType": "SINGLE_EMBEDDING",
                    "singleEmbeddingParams": {
                        "embeddingPurpose": "VIDEO_RETRIEVAL",
                        "embeddingDimension": 1024,
                        "text": {"truncationMode": "END", "value": text},
                    },
                }),
            )
            embed_body = json.loads(embed_resp["body"].read())
            query_vector = embed_body["embeddings"][0]["embedding"]

            # Query vector index — all assets
            query_resp = s3vectors.query_vectors(
                vectorBucketName=vector_bucket,
                indexName=index_name,
                queryVector={"float32": query_vector},
                topK=top_k,
                returnMetadata=True,
                returnDistance=True,
                filter={"itemId": {"$in": item_ids}},
            )

            candidates = []
            for v in query_resp.get("vectors", []):
                meta = v.get("metadata", {})
                cand_item = meta.get("itemId")
                start_s = meta.get("startTimeSeconds")
                end_s = meta.get("endTimeSeconds")
                # Constrain the segment to camera-stable footage; drop segments
                # that are entirely operator hunting/reframing.
                if start_s is not None and end_s is not None:
                    trimmed = _stability_trim(cand_item, start_s, end_s, stability_cache)
                    if trimmed is None:
                        continue
                    start_s, end_s = trimmed
                candidates.append({
                    "itemId": cand_item,
                    "distance": round(v.get("distance", 1.0), 4),
                    "startTimeSeconds": start_s,
                    "endTimeSeconds": end_s,
                    "segmentIndex": meta.get("segmentIndex"),
                })

            # Transcript text search: for any section with substantial text,
            # search clip transcripts for word overlap. This catches SOT
            # soundbites, reporter standups, anchor reads — any section where
            # the script text matches spoken words in a clip.
            if transcript_cache and len(text.split()) > 10:
                search_text = section.get("quotedText", "").lower().strip() if section.get("sectionType") == "pkg_sot" else text.lower().strip()
                if search_text:
                    tx_candidates = []
                    search_words = set(search_text.split())
                    for mid, tx in transcript_cache.items():
                        full_text = tx.get("fullTranscript", "").lower()
                        tx_words = set(full_text.split())
                        overlap = len(search_words & tx_words)
                        overlap_pct = overlap / max(len(search_words), 1)
                        if overlap_pct < 0.5:
                            continue
                        # Find the best matching window using sentences
                        best_start = None
                        best_end = None
                        best_score = 0
                        best_window_i = 0
                        best_window_j = 0
                        sentences = tx.get("sentences", [])
                        for i, sent in enumerate(sentences):
                            window_text = ""
                            window_start = sent.get("startTime", 0)
                            window_end = sent.get("endTime", 0)
                            for j in range(i, min(i + 10, len(sentences))):
                                s_text = sentences[j].get("text", "")
                                window_text += " " + s_text
                                window_end = sentences[j].get("endTime", window_end)
                                w_words = set(window_text.lower().split())
                                score = len(search_words & w_words) / max(len(search_words), 1)
                                if score > best_score:
                                    best_score = score
                                    best_start = window_start
                                    best_end = window_end
                                    best_window_i = i
                                    best_window_j = j
                                if score > 0.8:
                                    break
                        if best_score > 0.5 and best_start is not None:
                            # Tighten in-point: skip leading sentences that are
                            # the interviewer's QUESTION (interrogative or
                            # ?-terminated) or that don't contain the script's
                            # answer words (false starts, slate counts,
                            # "ready when you are"). This stops soundbites from
                            # opening on the reporter's question before the answer.
                            answer_start_idx = best_window_i
                            for k in range(best_window_i, best_window_j + 1):
                                sent_text = sentences[k].get("text", "")
                                sent_words = set(sent_text.lower().split())
                                if _is_question(sent_text):
                                    continue
                                if len(search_words & sent_words) >= 2:
                                    best_start = sentences[k].get("startTime", best_start)
                                    answer_start_idx = k
                                    break

                            # Trim out-point: drop trailing sentences that are
                            # follow-up questions so the soundbite ends on the
                            # interviewee's last answer word, not the next question.
                            end_idx = best_window_j
                            while end_idx > answer_start_idx and _is_question(sentences[end_idx].get("text", "")):
                                end_idx -= 1
                            best_end = sentences[end_idx].get("endTime", best_end)

                            tx_candidates.append({
                                "itemId": mid,
                                "distance": round(1.0 - best_score, 4),
                                "startTimeSeconds": best_start,
                                "endTimeSeconds": best_end,
                                "matchType": "transcript_text",
                                "matchConfidence": "high" if best_score > 0.7 else "low",
                            })
                    if tx_candidates:
                        tx_candidates.sort(key=lambda c: c["distance"])
                        candidates = tx_candidates + candidates
                        logger.info(f"Found {len(tx_candidates)} transcript matches for {section_key}")

            # For pkg_vo and pkg_sot sections, also query B-roll assets specifically
            # so cover footage gets surfaced even when interviews rank higher
            if section.get("sectionType") in ("pkg_vo", "pkg_sot") and broll_item_ids:
                try:
                    broll_resp = s3vectors.query_vectors(
                        vectorBucketName=vector_bucket,
                        indexName=index_name,
                        queryVector={"float32": query_vector},
                        topK=3,
                        returnMetadata=True,
                        returnDistance=True,
                        filter={"itemId": {"$in": broll_item_ids}},
                    )
                    # Add B-roll candidates, tagged so the agent knows
                    existing_keys = {(c["itemId"], c.get("segmentIndex")) for c in candidates}
                    for v in broll_resp.get("vectors", []):
                        meta = v.get("metadata", {})
                        key = (meta.get("itemId"), meta.get("segmentIndex"))
                        if key not in existing_keys:
                            candidates.append({
                                "itemId": meta.get("itemId"),
                                "distance": round(v.get("distance", 1.0), 4),
                                "startTimeSeconds": meta.get("startTimeSeconds"),
                                "endTimeSeconds": meta.get("endTimeSeconds"),
                                "segmentIndex": meta.get("segmentIndex"),
                                "assetType": "broll",
                            })
                except Exception as e:
                    logger.warning(f"B-roll query failed for {section_key}: {e}")

            # For pkg_vo and pkg_sot sections, put B-roll candidates first so the agent
            # prefers them for V2 track placement
            if section.get("sectionType") in ("pkg_vo", "pkg_sot"):
                broll_cands = [c for c in candidates if c.get("assetType") == "broll"]
                other_cands = [c for c in candidates if c.get("assetType") != "broll"]
                candidates = broll_cands + other_cands

            candidates_by_section[section_key] = candidates
            logger.info(f"Pre-computed {len(candidates)} candidates for section {section_key}")

        except Exception as e:
            logger.warning(f"Failed to pre-compute candidates for section {section_key}: {e}")
            candidates_by_section[section_key] = []

    return candidates_by_section


def run_source_material(script_analysis: dict, enriched_assets: list) -> dict:
    """Search source material and return ranked candidate segments.

    Pre-computes embedding candidates for all parsed sections in Python,
    then passes the ranked candidates directly to a lean agent that only
    needs to do SOT word-timing alignment and produce the final JSON.
    This avoids the agent looping on transcript fetches and embedding queries.

    Args:
        script_analysis: The structured ScriptAnalysis dict produced by
            ``run_script_analysis``.
        enriched_assets: List of enriched asset dicts, each containing at
            least ``mimirItemId``, ``hasTranscript``, and ``hasEmbeddings``.

    Returns:
        A dict with ``candidateSegments`` and ``gaps`` conforming to the
        Source Material output schema.

    Raises:
        ValueError: If the agent output cannot be parsed or fails validation.
    """
    # Check if any assets are searchable — if none, skip the agent call
    has_searchable = any(
        a.get("hasTranscript") or a.get("hasEmbeddings")
        for a in enriched_assets
    )
    if not has_searchable:
        logger.warning("No assets with transcripts or embeddings — returning all gaps")
        gaps = []
        for section in script_analysis.get("parsedSections", []):
            gaps.append({
                "scriptSection": f"{section['sectionType']}_{section['orderIndex']}",
                "unmatchedContent": section.get("content", ""),
            })
        return {"candidateSegments": [], "gaps": gaps, "coveragePercentage": 0}

    parsed_sections = script_analysis.get("parsedSections", [])

    # Pre-compute embedding candidates outside the agent loop
    logger.info(f"Pre-computing embedding candidates for {len(parsed_sections)} sections")
    precomputed = _precompute_candidates(parsed_sections, enriched_assets, top_k=5)

    # Build asset metadata summary for the agent (no full transcripts)
    asset_lines = []
    for asset in enriched_assets:
        item_id = asset.get("mimirItemId", "unknown")
        title = asset.get("title", "untitled")
        line = f"- {title} (mimirItemId: {item_id}, hasTranscript: {asset.get('hasTranscript', False)})"
        if asset.get("generatedTranscriptS3Uri"):
            line += " [has generated transcript]"
        asset_lines.append(line)
    assets_text = "\n".join(asset_lines)

    user_message = (
        f"## Parsed Script Sections\n```json\n{json.dumps(parsed_sections, indent=2)}\n```\n\n"
        f"## Assets\n{assets_text}\n\n"
        f"## Pre-Computed Embedding Candidates\n"
        f"These are the top embedding matches per section (lower distance = more relevant):\n"
        f"```json\n{json.dumps(precomputed, indent=2)}\n```"
    )

    logger.info(f"Running Source Material Agent with {len(enriched_assets)} assets, {len(precomputed)} sections pre-computed")

    bedrock_model = _get_bedrock_model()

    agent = Agent(
        model=bedrock_model,
        system_prompt=SOURCE_MATERIAL_PROMPT,
        tools=[get_word_timing],
    )

    result = agent(user_message)

    response_text = str(result)

    # Parse JSON — try all json blocks, prefer the last valid one
    json_blocks = re.findall(r"```(?:json)?\s*([\s\S]*?)```", response_text)
    if not json_blocks:
        xml_match = re.search(r"<json>\s*([\s\S]*?)</json>", response_text)
        if xml_match:
            json_blocks = [xml_match.group(1)]
        else:
            brace_match = re.search(r"\{[\s\S]*\}", response_text)
            json_blocks = [brace_match.group(0)] if brace_match else [response_text]

    source_material = None
    last_error = None
    for block in reversed(json_blocks):
        try:
            candidate = json.loads(block.strip())
            if isinstance(candidate, dict) and "candidateSegments" in candidate:
                source_material = candidate
                break
        except json.JSONDecodeError as exc:
            last_error = exc
            continue

    if source_material is None:
        # Fall back to trying the last block raw
        try:
            source_material = json.loads(json_blocks[-1].strip())
        except json.JSONDecodeError as exc:
            raise ValueError(
                f"Source Material Agent returned invalid JSON: {last_error or exc}"
            ) from exc

    _validate_source_material(source_material)

    # Post-process: inject B-roll candidates for pkg_vo sections from pre-computed data.
    # The agent may not have selected B-roll clips, so we ensure they're available
    # for the Timeline Assembly Agent to use on V2.
    for seg in source_material.get("candidateSegments", []):
        section_key = seg.get("scriptSection", "")
        if not section_key.startswith("pkg_vo") and not section_key.startswith("pkg_sot"):
            continue
        precomputed_cands = precomputed.get(section_key, [])
        broll_cands = [c for c in precomputed_cands if c.get("assetType") == "broll"]
        if broll_cands:
            # Add a B-roll candidate to the segment if not already present
            broll_item_ids = {c.get("itemId") for c in broll_cands}
            existing_ids = {c.get("mimirItemId") for c in seg.get("candidates", [])}
            for bc in broll_cands:
                if bc.get("itemId") not in existing_ids:
                    seg["candidates"].append({
                        "mimirItemId": bc["itemId"],
                        "inPointMs": int((bc.get("startTimeSeconds") or 0) * 1000),
                        "outPointMs": int((bc.get("endTimeSeconds") or 0) * 1000),
                        "relevanceScore": round(1.0 - bc.get("distance", 1.0), 4),
                        "matchType": "embedding",
                        "content": "B-roll cover footage",
                        "trackPlacement": "v2_broll",
                        "audioType": "none",
                        "voiceoverSource": seg["candidates"][0].get("voiceoverSource") if seg.get("candidates") else "polly_generated",
                        "assetType": "broll",
                    })
            logger.info(f"Injected {len(broll_cands)} B-roll candidates into {section_key}")

    logger.info(
        f"Source material search complete: "
        f"{len(source_material['candidateSegments'])} sections matched, "
        f"{len(source_material['gaps'])} gaps"
    )
    return source_material


# ---------------------------------------------------------------------------
# Timeline Assembly Agent (Graph Node — Task 7.1)
# ---------------------------------------------------------------------------

_TIMELINE_REQUIRED_KEYS = {"timelineItemId", "summary", "sequenceDetails"}
_SUMMARY_REQUIRED_KEYS = {"clipCount", "totalDurationMs", "trackCount"}


def _validate_clip(clip: dict, clip_path: str) -> None:
    """Validate a single clip has required fields and fix minor inconsistencies.

    Auto-corrects duration to match end-start and outPoint-inPoint.
    """
    for key in ("start", "end", "duration", "inPoint", "outPoint", "mimirItemId"):
        if key not in clip:
            raise ValueError(f"{clip_path} missing required key: {key}")

    start = clip["start"]
    end = clip["end"]
    in_point = clip["inPoint"]
    out_point = clip["outPoint"]

    if start < 0:
        raise ValueError(f"{clip_path}: start ({start}) must be >= 0")
    if in_point < 0:
        raise ValueError(f"{clip_path}: inPoint ({in_point}) must be >= 0")
    if end <= start:
        raise ValueError(f"{clip_path}: end ({end}) must be > start ({start})")
    if out_point <= in_point:
        raise ValueError(f"{clip_path}: outPoint ({out_point}) must be > inPoint ({in_point})")

    # Auto-correct duration to match end - start
    correct_duration = end - start
    if clip["duration"] != correct_duration:
        logger.warning(f"{clip_path}: auto-correcting duration from {clip['duration']} to {correct_duration}")
        clip["duration"] = correct_duration

    # Auto-correct outPoint to match inPoint + duration if needed
    expected_out = in_point + correct_duration
    if out_point != expected_out:
        logger.warning(f"{clip_path}: auto-correcting outPoint from {out_point} to {expected_out}")
        clip["outPoint"] = expected_out


def _validate_no_overlapping_clips(clips: list, track_path: str) -> None:
    """Validate that clips on a track do not overlap.

    Clips are sorted by ``start`` and checked pairwise.

    Args:
        clips: List of clip dicts (must already have valid start/end).
        track_path: Human-readable path for error messages.

    Raises:
        ValueError: If any two clips overlap.
    """
    if len(clips) < 2:
        return
    sorted_clips = sorted(clips, key=lambda c: c["start"])
    for i in range(len(sorted_clips) - 1):
        if sorted_clips[i]["end"] > sorted_clips[i + 1]["start"]:
            raise ValueError(
                f"{track_path}: clip {i} (end={sorted_clips[i]['end']}) overlaps "
                f"with clip {i + 1} (start={sorted_clips[i + 1]['start']})"
            )


def _validate_timeline_assembly(data: dict) -> None:
    """Validate that *data* conforms to the Timeline Assembly output schema.

    Checks required top-level keys, summary fields, track structure (minimum
    4 tracks with at least 2 video and 2 audio), clip fields, clip invariants,
    and no-overlap constraint.

    Raises:
        ValueError: When required fields are missing or invariants are violated.
    """
    missing = _TIMELINE_REQUIRED_KEYS - set(data.keys())
    if missing:
        raise ValueError(f"Timeline assembly output missing required keys: {missing}")

    # timelineItemId
    if not isinstance(data["timelineItemId"], str) or not data["timelineItemId"]:
        raise ValueError("timelineItemId must be a non-empty string")

    # summary
    summary = data["summary"]
    if not isinstance(summary, dict):
        raise ValueError("summary must be an object")
    missing_summary = _SUMMARY_REQUIRED_KEYS - set(summary.keys())
    if missing_summary:
        raise ValueError(f"summary missing required keys: {missing_summary}")

    # sequenceDetails
    seq = data["sequenceDetails"]
    if not isinstance(seq, dict) or "tracks" not in seq:
        raise ValueError("sequenceDetails must be an object with a tracks array")
    if not isinstance(seq["tracks"], list):
        raise ValueError("sequenceDetails.tracks must be an array")

    tracks = seq["tracks"]

    # Validate minimum 4 tracks (V1, V2, A1, A2)
    if len(tracks) < 4:
        raise ValueError(
            f"Timeline must have at least 4 tracks (2 video + 2 audio), "
            f"got {len(tracks)}"
        )

    # Validate at least 2 video and 2 audio tracks
    video_count = 0
    audio_count = 0

    for t_idx, track in enumerate(tracks):
        track_path = f"tracks[{t_idx}]"
        for key in ("id", "name", "mediaType", "clips"):
            if key not in track:
                raise ValueError(f"{track_path} missing required key: {key}")
        if track["mediaType"] not in ("video", "audio"):
            raise ValueError(f"{track_path}: mediaType must be 'video' or 'audio'")
        if not isinstance(track["clips"], list):
            raise ValueError(f"{track_path}.clips must be an array")

        if track["mediaType"] == "video":
            video_count += 1
        else:
            audio_count += 1

        # Validate clips — audio-only clips (sourceType "audio-only") get
        # lenient validation since they may not carry all video-clip fields.
        for c_idx, clip in enumerate(track["clips"]):
            clip_path = f"{track_path}.clips[{c_idx}]"
            is_audio_only = clip.get("sourceType") == "audio-only"

            if is_audio_only:
                # Lenient validation for audio-only clips: require start,
                # end, duration, and mimirItemId but tolerate missing
                # inPoint / outPoint.
                for key in ("start", "end", "duration", "mimirItemId"):
                    if key not in clip:
                        raise ValueError(f"{clip_path} missing required key: {key}")
                if clip["start"] < 0:
                    raise ValueError(f"{clip_path}: start ({clip['start']}) must be >= 0")
                if clip["end"] <= clip["start"]:
                    raise ValueError(
                        f"{clip_path}: end ({clip['end']}) must be > start ({clip['start']})"
                    )
                # Auto-correct duration
                correct_duration = clip["end"] - clip["start"]
                if clip["duration"] != correct_duration:
                    logger.warning(
                        f"{clip_path}: auto-correcting duration from "
                        f"{clip['duration']} to {correct_duration}"
                    )
                    clip["duration"] = correct_duration
            else:
                _validate_clip(clip, clip_path)

        _validate_no_overlapping_clips(track["clips"], track_path)

    if video_count < 2:
        raise ValueError(
            f"Timeline must have at least 2 video tracks, got {video_count}"
        )
    if audio_count < 2:
        raise ValueError(
            f"Timeline must have at least 2 audio tracks, got {audio_count}"
        )


def _detect_reporter_vo(script_analysis: dict, enriched_assets: list) -> dict:
    """Detect reporter-provided voice-over by checking word overlap in Python.

    For each pkg_vo section, reads generated transcripts from S3 and computes
    word overlap using a sliding sentence window. Only considers clips under
    3 minutes (reporter standups/tracks) — long interview clips are excluded
    to avoid false positives from topic-word overlap.

    Args:
        script_analysis: ScriptAnalysis dict with parsedSections.
        enriched_assets: List of enriched asset dicts.

    Returns:
        Dict mapping str(orderIndex) → {voiceoverSource, mimirItemId (if reporter)}
    """
    bucket = os.environ.get("TRANSCRIPT_STAGING_BUCKET", "")
    if not bucket:
        logger.warning("TRANSCRIPT_STAGING_BUCKET not set — skipping VO detection")
        return {}

    s3 = boto3.client("s3")
    vo_tags = {}

    # Cache transcripts (full parsed objects, not just text)
    transcript_cache = {}

    # Pre-load transcripts and filter to short clips (< 3 min = likely reporter tracks)
    MAX_REPORTER_CLIP_DURATION = 300  # seconds (5 min — standups with retakes)
    for asset in enriched_assets:
        item_id = asset.get("mimirItemId", "")
        if not item_id:
            continue
        if not asset.get("generatedTranscriptS3Uri") and not asset.get("hasTranscript"):
            continue
        key = f"transcripts/{item_id}/transcript.json"
        try:
            resp = s3.get_object(Bucket=bucket, Key=key)
            tx = json.loads(resp["Body"].read().decode("utf-8"))
            # Check clip duration from last sentence
            sentences = tx.get("sentences", [])
            if sentences:
                duration = sentences[-1].get("endTime", 0)
                if duration > MAX_REPORTER_CLIP_DURATION:
                    continue  # Skip long clips (interviews)
            transcript_cache[item_id] = tx
        except Exception:
            pass

    logger.info(f"VO detection: {len(transcript_cache)} candidate clips (< {MAX_REPORTER_CLIP_DURATION}s)")

    for section in script_analysis.get("parsedSections", []):
        if section.get("sectionType") != "pkg_vo":
            continue

        order_index = section.get("orderIndex", 0)
        vo_text = section.get("content", "").strip()
        if not vo_text:
            continue

        vo_words = set(vo_text.lower().split())
        if not vo_words:
            continue

        best_overlap = 0.0
        best_asset_id = None
        best_start = None
        best_end = None

        for item_id, tx in transcript_cache.items():
            sentences = tx.get("sentences", [])
            if not sentences:
                continue

            # Sliding sentence window to find the best matching segment
            for i, sent in enumerate(sentences):
                window_text = ""
                window_start = sent.get("startTime", 0)
                window_end = sent.get("endTime", 0)
                for j in range(i, min(i + 10, len(sentences))):
                    window_text += " " + sentences[j].get("text", "")
                    window_end = sentences[j].get("endTime", window_end)
                    w_words = set(window_text.lower().split())
                    score = len(vo_words & w_words) / len(vo_words)
                    if score > best_overlap:
                        best_overlap = score
                        best_asset_id = item_id
                        best_start = window_start
                        best_end = window_end
                    if score > 0.85:
                        break
                if best_overlap > 0.85:
                    break

        if best_overlap >= 0.70 and best_asset_id:
            vo_tags[str(order_index)] = {
                "voiceoverSource": "reporter_provided",
                "mimirItemId": best_asset_id,
                "overlapPercentage": round(best_overlap * 100, 1),
                "inPointSeconds": round(best_start, 2) if best_start else 0,
                "outPointSeconds": round(best_end, 2) if best_end else 0,
            }
            logger.info(
                f"VO section {order_index}: reporter_provided from {best_asset_id} "
                f"({best_overlap:.0%} overlap, {best_start:.1f}s-{best_end:.1f}s)"
            )
        else:
            vo_tags[str(order_index)] = {
                "voiceoverSource": "polly_generated",
            }
            logger.info(
                f"VO section {order_index}: polly_generated "
                f"(best overlap: {best_overlap:.0%})"
            )

    return vo_tags


def _synthesize_voiceovers(
    script_analysis: dict,
    source_material: dict,
    story_id: str,
    story_title: str,
    parent_item_ids: list,
    vo_tags: dict = None,
    folder_id: str = None,
) -> dict:
    """Synthesize Polly voice-overs for polly_generated VO sections in Python.

    Only synthesizes sections tagged polly_generated by _detect_reporter_vo.
    Sections tagged reporter_provided are skipped.

    Args:
        script_analysis: ScriptAnalysis dict with parsedSections.
        source_material: Source material dict with candidateSegments.
        story_id: Story ID for S3 key organisation.
        story_title: Story title for Mimir item naming.
        parent_item_ids: Parent Mimir item IDs for the audio items.
        vo_tags: Dict from _detect_reporter_vo mapping orderIndex → tag info.

    Returns:
        Dict mapping str(orderIndex) → {mimirItemId, durationMs, s3Uri, sectionIndex, voiceoverSource}
    """
    bucket = os.environ.get("TRANSCRIPT_STAGING_BUCKET", "")
    voice_id = os.environ.get("POLLY_VOICE_ID", "Matthew")
    mimir_api_key = None

    if vo_tags is None:
        vo_tags = {}

    vo_clips = {}

    for section in script_analysis.get("parsedSections", []):
        if section.get("sectionType") != "pkg_vo":
            continue

        order_index = section.get("orderIndex", 0)
        section_key = f"pkg_vo_{order_index}"
        tag_info = vo_tags.get(str(order_index), {"voiceoverSource": "polly_generated"})

        # If reporter-provided, pass through the tag info without Polly synthesis
        if tag_info.get("voiceoverSource") == "reporter_provided":
            vo_clips[str(order_index)] = {
                "mimirItemId": tag_info.get("mimirItemId", ""),
                "durationMs": section.get("estimatedDurationMs", 5000),
                "sectionIndex": order_index,
                "sectionKey": section_key,
                "voiceoverSource": "reporter_provided",
            }
            logger.info(f"VO section {section_key}: using reporter-provided audio from {tag_info.get('mimirItemId')}")
            continue

        text = section.get("content", "").strip()
        if not text:
            continue

        # Strip newsroom production cues/slugs (e.g. "PKG VO:", "((nats))") from
        # the text sent to Polly ONLY. The full script — cues included — is
        # still written to the SAGA instance for producers/anchors to read.
        spoken_text = sanitize_for_tts(text)
        if not spoken_text:
            logger.info(f"VO section {section_key}: only production cues, nothing to synthesize — skipping")
            continue

        logger.info(f"Synthesizing Polly VO for section {section_key}")

        try:
            # 1. Call Polly
            polly = boto3.client("polly")
            polly_resp = polly.synthesize_speech(
                Text=spoken_text,
                OutputFormat="mp3",
                Engine="neural",
                VoiceId=voice_id,
            )
            audio_bytes = polly_resp["AudioStream"].read()

            # 2. Upload to S3
            if not bucket:
                logger.warning("TRANSCRIPT_STAGING_BUCKET not set — skipping VO upload")
                continue

            s3_key = f"voiceover/{story_id}/{order_index}.mp3"
            s3 = boto3.client("s3")
            s3.put_object(Bucket=bucket, Key=s3_key, Body=audio_bytes, ContentType="audio/mpeg")
            s3_uri = f"s3://{bucket}/{s3_key}"
            duration_ms = round(len(audio_bytes) / (48000 / 8) * 1000)

            # 3. Create Mimir audio item
            if mimir_api_key is None:
                from tools import _get_mimir_api_key
                mimir_api_key = _get_mimir_api_key()

            import requests as _requests
            mimir_base = os.environ.get("MIMIR_API_BASE", "https://us.mjoll.no")
            item_title = f"{story_title} - VO {order_index}"
            create_payload = {
                "title": item_title,
                "itemType": "audio",
                "parentItemIds": parent_item_ids,
            }
            if folder_id:
                create_payload["folderParents"] = [folder_id]
            resp = _requests.post(
                f"{mimir_base}/api/v1/items",
                headers={
                    "Accept": "application/json",
                    "Content-Type": "application/json",
                    "x-mimir-cognito-id-token": f"Bearer {mimir_api_key}",
                },
                json=create_payload,
                timeout=30,
            )
            resp.raise_for_status()
            mimir_item_id = resp.json()["id"]

            # 4. Upload the actual MP3 file to Mimir via signed URL
            import uuid as _uuid
            lock_owner_id = str(_uuid.uuid4())
            try:
                # Create upload lock and get signed URL
                upload_resp = _requests.put(
                    f"{mimir_base}/api/v1/items/{mimir_item_id}/upload",
                    headers={
                        "Accept": "application/json",
                        "Content-Type": "application/json",
                        "x-mimir-cognito-id-token": f"Bearer {mimir_api_key}",
                    },
                    json={
                        "lockOwnerInstanceId": lock_owner_id,
                        "fileName": f"vo_{order_index}.mp3",
                    },
                    timeout=30,
                )
                upload_resp.raise_for_status()
                upload_data = upload_resp.json()
                signed_url = upload_data.get("uploadSignedUrl", "")

                if signed_url:
                    # Upload the MP3 bytes to the signed URL
                    put_resp = _requests.put(
                        signed_url,
                        data=audio_bytes,
                        headers={"Content-Type": "audio/mpeg"},
                        timeout=60,
                    )
                    put_resp.raise_for_status()
                    logger.info(f"Uploaded VO audio to Mimir item {mimir_item_id}")

                    # Release the upload lock
                    _requests.delete(
                        f"{mimir_base}/api/v1/items/{mimir_item_id}/upload",
                        headers={
                            "Accept": "application/json",
                            "Content-Type": "application/json",
                            "x-mimir-cognito-id-token": f"Bearer {mimir_api_key}",
                        },
                        json={"lockOwnerInstanceId": lock_owner_id},
                        timeout=30,
                    )
                else:
                    logger.warning(f"No signed URL returned for VO item {mimir_item_id}")
            except Exception as upload_err:
                logger.warning(f"Failed to upload VO media to Mimir item {mimir_item_id}: {upload_err}")

            vo_clips[str(order_index)] = {
                "mimirItemId": mimir_item_id,
                "durationMs": duration_ms,
                "s3Uri": s3_uri,
                "sectionIndex": order_index,
                "sectionKey": section_key,
                "voiceoverSource": "polly_generated",
            }
            logger.info(f"VO section {section_key}: synthesized {duration_ms}ms, Mimir item {mimir_item_id}")

        except Exception as e:
            logger.error(f"Failed to synthesize VO for section {section_key}: {e}")
            # Non-fatal — continue with remaining sections

    logger.info(f"Synthesized {len(vo_clips)} VO clips in Python")
    return vo_clips


def _save_artifact(story_id: str, stage: str, data: dict, run_id: str = "") -> None:
    """Save a pipeline artifact to S3 for debugging and analysis."""
    bucket = os.environ.get("TRANSCRIPT_STAGING_BUCKET", "")
    if not bucket:
        return
    try:
        s3 = boto3.client("s3")
        key = f"rough-cut-artifacts/{story_id}/{run_id}/{stage}.json"
        s3.put_object(
            Bucket=bucket, Key=key,
            Body=json.dumps(data, indent=2),
            ContentType="application/json",
        )
        logger.info(f"Saved artifact: s3://{bucket}/{key}")
    except Exception as e:
        logger.warning(f"Failed to save artifact {stage}: {e}")


def _normalize_primary_sequence(assembly: dict, script_analysis: dict,
                                source_material: dict, vo_clips: dict) -> None:
    """Deterministically re-layout the narrative clips (V1 A-roll + A1 VO).

    The assembly agent computes clip start/end positions with LLM arithmetic,
    which can drift mid-timeline — placing VO narration on top of interview
    soundbites (cross-track audio overlap) or even swapping section order.
    The narrative is strictly sequential (script sections in order, exactly one
    narrative clip per section), so positions are recomputed in Python:

    1. Build the expected section order from parsedSections.
    2. Match each placed V1/A1 clip to its section by identity (VO clips via
       vo_clips[orderIndex].mimirItemId; SOT/anchor clips via the section's
       source-material candidates).
    3. Walk sections in order, packing matched clips back-to-back; each clip
       keeps its own duration (outPoint - inPoint, or the VO durationMs).

    Unmatched clips (if any) are appended afterwards in their original start
    order. Modifies the assembly in place. V2 B-roll is rebuilt afterwards by
    _rebuild_v2_broll against the corrected V1/A1 range.
    """
    seq = assembly.get("sequenceDetails", {})
    tracks_by_id = {t.get("id"): t for t in seq.get("tracks", [])}
    v1_clips = (tracks_by_id.get(1) or {}).get("clips", [])
    a1_clips = (tracks_by_id.get(3) or {}).get("clips", [])
    primary = list(v1_clips) + list(a1_clips)
    if not primary:
        return

    def clip_duration(c):
        dur = c.get("duration") or 0
        if dur <= 0:
            dur = max(0, (c.get("outPoint") or 0) - (c.get("inPoint") or 0))
        return dur

    # Identity lookup: section key -> acceptable mimirItemIds
    vo_items = {}  # orderIndex(str) -> mimirItemId
    for k, v in (vo_clips or {}).items():
        if isinstance(v, dict) and v.get("mimirItemId"):
            vo_items[str(k)] = v["mimirItemId"]
    section_candidates = {}  # scriptSection key -> set of mimirItemIds
    for seg in (source_material or {}).get("candidateSegments", []):
        key = seg.get("scriptSection", "")
        ids = {c.get("mimirItemId") for c in seg.get("candidates", []) if c.get("mimirItemId")}
        if key and ids:
            section_candidates[key] = ids

    unplaced = sorted(primary, key=lambda c: (c.get("start", 0), c.get("end", 0)))

    def take(match_fn):
        for i, c in enumerate(unplaced):
            if match_fn(c):
                return unplaced.pop(i)
        return None

    ordered = []
    sections = sorted(script_analysis.get("parsedSections", []),
                      key=lambda s: s.get("orderIndex", 0))
    for section in sections:
        stype = section.get("sectionType", "")
        okey = str(section.get("orderIndex", ""))
        clip = None
        if stype == "pkg_vo" and okey in vo_items:
            clip = take(lambda c: c.get("mimirItemId") == vo_items[okey])
        elif stype in ("pkg_sot", "anchor_intro", "reporter_live", "live_tag", "anchor_qa"):
            ids = section_candidates.get(f"{stype}_{okey}", set())
            if ids:
                clip = take(lambda c: c.get("mimirItemId") in ids)
        if clip is not None:
            ordered.append(clip)

    if unplaced:
        logger.warning(f"Sequence normalization: {len(unplaced)} narrative clip(s) "
                       f"did not match a script section — appending in start order")
        ordered.extend(unplaced)

    # Re-pack back-to-back; positions no longer depend on LLM arithmetic.
    pos = 0
    moved = 0
    for c in ordered:
        dur = clip_duration(c)
        if c.get("start") != pos:
            moved += 1
        c["start"] = pos
        c["end"] = pos + dur
        c["duration"] = dur
        pos += dur
    logger.info(f"Sequence normalization: {len(ordered)} narrative clips packed, "
                f"{moved} repositioned, total {pos}ms")


def _normalize_primary_sequence(assembly: dict, script_analysis: dict,
                                source_material: dict, vo_clips: dict) -> None:
    """Deterministically re-layout the narrative clips (V1 A-roll + VO track).

    The assembly agent computes clip start/end positions with LLM arithmetic,
    which can drift mid-timeline — placing generated VO narration (rendered on
    A5) on top of interview soundbites (V1 audio, rendered on A1+A2), or even
    swapping section order. The narrative is strictly sequential (one narrative
    clip per script section, in section order), so positions are recomputed in
    Python:

    1. Build the expected section order from parsedSections.
    2. Match each placed V1/VO clip to its section by identity (VO clips via
       vo_clips[orderIndex].mimirItemId; SOT/anchor clips via the section's
       source-material candidates).
    3. Walk sections in order, packing matched clips back-to-back; each clip
       keeps its own duration (outPoint - inPoint, or the VO durationMs).

    Unmatched clips (if any) are appended afterwards in their original start
    order. Modifies the assembly in place. Runs BEFORE _rebuild_v2_broll so the
    B-roll rebuild sees the corrected V1/VO range.
    """
    seq = assembly.get("sequenceDetails", {})
    tracks_by_id = {t.get("id"): t for t in seq.get("tracks", [])}
    v1_clips = (tracks_by_id.get(1) or {}).get("clips", [])
    vo_track_clips = (tracks_by_id.get(3) or {}).get("clips", [])
    primary = list(v1_clips) + list(vo_track_clips)
    if not primary:
        return

    def clip_duration(c):
        dur = c.get("duration") or 0
        if dur <= 0:
            dur = max(0, (c.get("outPoint") or 0) - (c.get("inPoint") or 0))
        return dur

    # Identity lookups: which mimirItemIds belong to which script section
    vo_items = {}  # orderIndex(str) -> mimirItemId
    for k, v in (vo_clips or {}).items():
        if isinstance(v, dict) and v.get("mimirItemId"):
            vo_items[str(k)] = v["mimirItemId"]
    section_candidates = {}  # scriptSection key -> set of mimirItemIds
    for seg in (source_material or {}).get("candidateSegments", []):
        key = seg.get("scriptSection", "")
        ids = {c.get("mimirItemId") for c in seg.get("candidates", []) if c.get("mimirItemId")}
        if key and ids:
            section_candidates[key] = ids

    unplaced = sorted(primary, key=lambda c: (c.get("start", 0), c.get("end", 0)))

    def take(match_fn):
        for i, c in enumerate(unplaced):
            if match_fn(c):
                return unplaced.pop(i)
        return None

    ordered = []
    sections = sorted(script_analysis.get("parsedSections", []),
                      key=lambda s: s.get("orderIndex", 0))
    for section in sections:
        stype = section.get("sectionType", "")
        okey = str(section.get("orderIndex", ""))
        clip = None
        if stype == "pkg_vo" and okey in vo_items:
            vo_id = vo_items[okey]
            clip = take(lambda c: c.get("mimirItemId") == vo_id)
        elif stype in ("pkg_sot", "anchor_intro", "reporter_live", "live_tag", "anchor_qa"):
            ids = section_candidates.get(f"{stype}_{okey}", set())
            if ids:
                clip = take(lambda c: c.get("mimirItemId") in ids)
        if clip is not None:
            ordered.append(clip)

    if unplaced:
        logger.warning(f"Sequence normalization: {len(unplaced)} narrative clip(s) "
                       f"did not match a script section — appending in start order")
        ordered.extend(unplaced)

    # Re-pack back-to-back; positions no longer depend on LLM arithmetic.
    pos = 0
    moved = 0
    for c in ordered:
        dur = clip_duration(c)
        if c.get("start") != pos:
            moved += 1
        c["start"] = pos
        c["end"] = pos + dur
        c["duration"] = dur
        pos += dur
    logger.info(f"Sequence normalization: {len(ordered)} narrative clips packed, "
                f"{moved} repositioned, total {pos}ms")


def _stable_only_segments(stability_data: dict, min_span_ms: int = 3000,
                          max_mag: float = 0.3) -> list:
    """Derives strictly locked-off usable spans from per-second metrics.

    B-roll cover should be truly static shots. The 'stable' label alone is not
    strict enough: slow COHERENT handheld drift (mag 0.3-1.0 with consistent
    direction) is classified stable — it escapes both the "move" rule (needs
    mag >= 1.0) and the "jiggle" rule (needs incoherence) — yet reads as shaky
    cover on screen. So a second is B-roll-usable only when it is labeled
    'stable' AND its motion magnitude is below ``max_mag`` (near-zero motion).

    Consecutive usable seconds are merged; spans shorter than ``min_span_ms``
    are discarded (slivers make useless B-roll). Returns segments in the same
    {startMs, endMs, label} shape _stability_trim expects.
    """
    seconds = stability_data.get("seconds") or []
    if not seconds:
        return stability_data.get("segments") or []
    duration_ms = stability_data.get("durationMs") or 0
    segments = []
    for r in sorted(seconds, key=lambda r: r.get("sec", 0)):
        start = r["sec"] * 1000
        end = min((r["sec"] + 1) * 1000, duration_ms or (r["sec"] + 1) * 1000)
        locked = r.get("label") == "stable" and (r.get("mag") or 0) < max_mag
        label = "usable" if locked else "unusable"
        if segments and segments[-1]["label"] == label:
            segments[-1]["endMs"] = end
        else:
            segments.append({"startMs": start, "endMs": end, "label": label})
    return [s for s in segments
            if s["label"] == "unusable" or (s["endMs"] - s["startMs"]) >= min_span_ms]


def _fill_spans(spans: list, candidate_pool: list, used_segments: set,
                broll_cover: bool = False, min_clip_ms: int = 3000,
                target_clip_ms: int = 6000, max_clip_ms: int = None) -> list:
    """Fills each (start, end) span with clips from the candidate pool.

    Picks unused candidates (deduped on itemId+segmentIndex across both video
    tracks via the shared ``used_segments`` set), targeting ``target_clip_ms``
    clips and avoiding clips shorter than ``min_clip_ms`` (short slivers read as
    jumpy) — except when a smaller remainder must be filled to keep a V1 span
    complete, since a V1 remainder would be an (unsupported) gap on a video
    track.

    ``max_clip_ms`` (when set) is a hard ceiling on any single shot's on-screen
    duration, so editorial "shots stay within N seconds" rules are enforced in
    code rather than left to the LLM. Defaults preserve the original ~6s target
    with no ceiling (legacy "full" behavior).

    When ``broll_cover`` is True the clips are flagged so the payload builder
    emits their audio at reduced gain (nat sound under voice-over).
    """
    TARGET_CLIP_MS = target_clip_ms
    filled = []
    for span_start, span_end in spans:
        position = span_start
        while position < span_end:
            remaining = span_end - position

            def unused():
                for c in candidate_pool:
                    if (c["itemId"], c["segmentIndex"]) not in used_segments:
                        yield c, int((c["endTimeSeconds"] - c["startTimeSeconds"]) * 1000)

            # Closing move: when one clip can finish the span (remainder within
            # target + min), prefer the most relevant candidate long enough to
            # cover it exactly — avoids manufacturing short tail clips. Skipped
            # when the remainder would exceed the max shot ceiling, so we never
            # emit an over-length shot just to close a span.
            best, clip_dur = None, 0
            if remaining <= TARGET_CLIP_MS + min_clip_ms and (
                max_clip_ms is None or remaining <= max_clip_ms
            ):
                for c, cand_dur in unused():
                    if cand_dur >= remaining:
                        best, clip_dur = c, remaining
                        break
            # Normal pick: longest-viable candidate at target length. If the
            # tail this leaves is under min_clip_ms, absorb as much as the
            # source allows rather than shortening below the minimum.
            if best is None:
                for c, cand_dur in unused():
                    if cand_dur >= min(min_clip_ms, remaining):
                        best = c
                        source_dur = cand_dur
                        clip_dur = min(TARGET_CLIP_MS, remaining, source_dur)
                        tail = remaining - clip_dur
                        if 0 < tail < min_clip_ms:
                            clip_dur = min(remaining, source_dur)
                        # Enforce the hard shot ceiling (never over-length),
                        # even if that re-introduces a small tail to fill next.
                        if max_clip_ms is not None:
                            clip_dur = min(clip_dur, max_clip_ms)
                        break
            if not best:
                logger.warning(f"B-roll pool exhausted; span covered only to {position}ms of {span_end}ms")
                break
            used_segments.add((best["itemId"], best["segmentIndex"]))

            src_start_ms = int(best["startTimeSeconds"] * 1000)
            src_end_ms = int(best["endTimeSeconds"] * 1000)
            clip_dur = min(clip_dur, src_end_ms - src_start_ms, remaining)
            if clip_dur <= 0:
                continue

            clip = {
                "start": position,
                "end": position + clip_dur,
                "duration": clip_dur,
                "inPoint": src_start_ms,
                "outPoint": src_start_ms + clip_dur,
                "mimirItemId": best["itemId"],
            }
            if broll_cover:
                clip["brollCover"] = True
            filled.append(clip)
            position += clip_dur
    return filled


def _broll_eligible_item_ids(enriched_assets, max_words=50):
    """Return the item IDs that are true B-roll cover — clips with little or no
    speech — excluding interview / standup / soundbite footage whose audio (and
    on-camera talking head) doesn't belong under a live-read voice-over.

    Classification uses the generated transcript word count in the staging
    bucket: a clip with fewer than *max_words* words (or no transcript at all)
    is cover-eligible; anything wordier is treated as a talking-head/interview
    clip and excluded. Returns None when transcripts can't be read (no staging
    bucket), signalling the caller to fall back to all clips.
    """
    staging = os.environ.get("TRANSCRIPT_STAGING_BUCKET", "")
    if not staging:
        return None
    s3 = boto3.client("s3")
    eligible = []
    for a in enriched_assets:
        mid = a.get("mimirItemId", "")
        if not mid or not a.get("hasEmbeddings"):
            continue
        try:
            resp = s3.get_object(Bucket=staging, Key=f"transcripts/{mid}/transcript.json")
            word_count = len(json.loads(resp["Body"].read()).get("fullTranscript", "").split())
            if word_count < max_words:
                eligible.append(mid)
        except Exception:
            # No transcript on file → almost certainly B-roll cover.
            eligible.append(mid)
    return eligible


def _query_broll_candidates(bedrock, s3vectors_client, vector_bucket, index_name,
                            item_ids, query_text, strict_cache, usable_cache,
                            min_shot_s, top_k=12):
    """Embedding-query the vector index for *query_text* and return a
    stability-trimmed candidate pool sorted by relevance (nearest first).

    Tries the strict locked-off stability map first; if that yields nothing for
    this query, falls back to the looser usable-labeled map, then to no filter —
    so a section always gets *some* cover rather than a gap.
    Pool items: {itemId, segmentIndex, startTimeSeconds, endTimeSeconds, distance}.
    """
    text = (query_text or "").strip() or "B-roll cover footage"
    try:
        embed_resp = bedrock.invoke_model(
            modelId="amazon.nova-2-multimodal-embeddings-v1:0",
            contentType="application/json", accept="application/json",
            body=json.dumps({
                "taskType": "SINGLE_EMBEDDING",
                "singleEmbeddingParams": {
                    "embeddingPurpose": "VIDEO_RETRIEVAL",
                    "embeddingDimension": 1024,
                    "text": {"truncationMode": "END", "value": text[:2000]},
                },
            }),
        )
        qv = json.loads(embed_resp["body"].read())["embeddings"][0]["embedding"]
        resp = s3vectors_client.query_vectors(
            vectorBucketName=vector_bucket, indexName=index_name,
            queryVector={"float32": qv}, topK=top_k,
            returnMetadata=True, returnDistance=True,
            filter={"itemId": {"$in": item_ids}})
    except Exception as e:
        logger.warning(f"Per-section B-roll query failed: {e}")
        return []

    def _build(cache):
        pool = []
        for v in resp.get("vectors", []):
            m = v.get("metadata", {})
            cid = m.get("itemId")
            tr = _stability_trim(cid, m.get("startTimeSeconds", 0),
                                 m.get("endTimeSeconds", 15), cache,
                                 min_clip_s=float(min_shot_s))
            if tr is None:
                continue
            pool.append({
                "itemId": cid, "segmentIndex": m.get("segmentIndex"),
                "startTimeSeconds": tr[0], "endTimeSeconds": tr[1],
                "distance": v.get("distance", 1.0),
            })
        return pool

    return _build(strict_cache) or _build(usable_cache) or _build({})


def _fill_v1_per_section(script_analysis, total_ms, enriched_assets, shot_config):
    """Place B-roll cover ALIGNED to each VO section across *total_ms*.

    Each pkg_vo/pkg_nats section gets a time slice proportional to its estimated
    duration; that slice is filled with the section's OWN best-matching stable
    clips (a per-section embedding query), so cover footage tracks the script
    line-by-line instead of by whole-story relevance. A shared used-set prevents
    repeating a clip across sections (avoids repetitive coverage), and a
    global-relevance fallback pool keeps V1 gapless when a section's own matches
    run short.

    Returns a list of V1 clip dicts, or None to signal the caller to fall back
    to the global fill (missing vector config / assets / sections).
    """
    sections = [s for s in sorted(script_analysis.get("parsedSections", []),
                                  key=lambda x: x.get("orderIndex", 0))
                if s.get("sectionType") in ("pkg_vo", "pkg_nats")]
    if not sections:
        return None
    vector_bucket = os.environ.get("VECTOR_BUCKET_NAME", "")
    index_name = os.environ.get("VECTOR_INDEX_NAME", "")
    if not vector_bucket or not index_name:
        return None
    all_item_ids = [a["mimirItemId"] for a in enriched_assets if a.get("hasEmbeddings")]
    if not all_item_ids:
        return None

    # Restrict cover to true B-roll (low/no speech) so a live-read VO never gets
    # an interview/standup "talking head" as cover. Fall back to all clips when
    # classification is unavailable or leaves too few options.
    broll_ids = _broll_eligible_item_ids(enriched_assets)
    if broll_ids is not None and len(broll_ids) >= 3:
        item_ids = broll_ids
        logger.info(
            f"VO cover pool restricted to {len(item_ids)}/{len(all_item_ids)} "
            f"B-roll-eligible clips (excluding interview/standup footage)")
    else:
        item_ids = all_item_ids
        if broll_ids is not None:
            logger.info(
                f"Only {len(broll_ids)} B-roll-eligible clip(s) (<3) — using all "
                f"{len(all_item_ids)} clips for VO cover")

    bedrock = boto3.client("bedrock-runtime")
    s3vectors_client = boto3.client("s3vectors")

    raw_stab = _load_stability_cache(
        enriched_assets,
        os.environ.get("STABILITY_BUCKET") or os.environ.get("TRANSCRIPT_STAGING_BUCKET", ""),
        raw=True)
    strict_cache = {mid: _stable_only_segments(d) for mid, d in raw_stab.items()}
    usable_cache = {mid: (d.get("segments") or []) for mid, d in raw_stab.items()}

    shot = shot_config or {}
    min_shot_s = shot.get("min_shot_duration_s", 3)
    target_clip_ms = int(shot.get("target_shot_duration_s", 4) * 1000)
    min_clip_ms = int(min_shot_s * 1000)
    max_clip_ms = int(shot["max_shot_duration_s"] * 1000) if shot.get("max_shot_duration_s") else None

    # Whole-script relevance pool as a gap-filling fallback for any slice whose
    # own section matches run short.
    global_pool = _query_broll_candidates(
        bedrock, s3vectors_client, vector_bucket, index_name, item_ids,
        " ".join(s.get("content", "") for s in sections),
        strict_cache, usable_cache, min_shot_s, top_k=50)

    weights = [max(1, int(s.get("estimatedDurationMs", 4000) or 4000)) for s in sections]
    wsum = sum(weights) or 1

    used = set()
    fillers = []
    pos = 0
    for i, sec in enumerate(sections):
        # Last section absorbs any rounding remainder so V1 reaches total_ms.
        slice_end = total_ms if i == len(sections) - 1 else min(
            total_ms, pos + int(round(total_ms * weights[i] / wsum)))
        if slice_end <= pos:
            continue
        sec_pool = _query_broll_candidates(
            bedrock, s3vectors_client, vector_bucket, index_name, item_ids,
            sec.get("content", ""), strict_cache, usable_cache, min_shot_s, top_k=12)
        # Prefer this section's matches; append global candidates (deduped) so a
        # short section pool still fills its slice without leaving a V1 gap.
        sec_keys = {(c["itemId"], c["segmentIndex"]) for c in sec_pool}
        combined = sec_pool + [c for c in global_pool
                               if (c["itemId"], c["segmentIndex"]) not in sec_keys]
        seg = _fill_spans([(pos, slice_end)], combined, used, broll_cover=True,
                          min_clip_ms=min_clip_ms, target_clip_ms=target_clip_ms,
                          max_clip_ms=max_clip_ms)
        logger.info(
            f"Per-section cover: {sec.get('sectionType')}_{sec.get('orderIndex')} "
            f"[{pos}-{slice_end}ms] -> {len(seg)} clip(s) "
            f"({len(sec_pool)} section-specific matches)"
        )
        fillers.extend(seg)
        pos = slice_end
    return fillers


def _rebuild_broll_tracks(assembly: dict, enriched_assets: list, script_analysis: dict,
                          shot_config: dict = None) -> None:
    """Rebuild B-roll placement across V1 and V2 (broadcast track layout).

    Cutter constraint: V1 must be GAPLESS (a leading gap snaps the track to
    timeline 0; mid-track gaps written via the API cannot be adjusted in the
    editor). V2 may have gaps.

    Layout produced:
    - V1 = continuous program track: interview SOTs at their normalized
      positions, with every VO-led span (leading, between SOTs, and trailing
      through the end of the narrative) filled with B-roll cover. V1 B-roll
      audio plays at reduced gain (nat sound under the VO).
    - V2 = cutaway cover over the SOT ranges only ("cover to cut to" for the
      editor), with gaps elsewhere.

    Candidates come from the vector index (deduped on itemId+segmentIndex
    across both tracks, camera-stability trimmed). Modifies the assembly in
    place.
    """
    vector_bucket = os.environ.get("VECTOR_BUCKET_NAME", "")
    index_name = os.environ.get("VECTOR_INDEX_NAME", "")
    if not vector_bucket or not index_name:
        logger.warning("Vector bucket/index not configured — skipping B-roll rebuild")
        return

    seq = assembly.get("sequenceDetails", {})
    tracks_by_id = {t.get("id"): t for t in seq.get("tracks", [])}
    v1_track = tracks_by_id.get(1, {})
    v2_track = tracks_by_id.get(2, {})
    vo_track = tracks_by_id.get(3, {})

    if not v2_track:
        return

    # Get item IDs with embeddings
    item_ids = [a["mimirItemId"] for a in enriched_assets if a.get("hasEmbeddings")]
    if not item_ids:
        return

    s3vectors_client = boto3.client("s3vectors")
    bedrock = boto3.client("bedrock-runtime")

    # Narrative extent: V1 SOTs (normalized) + VO clips define the program span.
    sot_clips = sorted(v1_track.get("clips", []), key=lambda c: c.get("start", 0))
    vo_clips_placed = sorted(vo_track.get("clips", []), key=lambda c: c.get("start", 0))
    narrative_end = max(
        [c.get("end", 0) for c in sot_clips + vo_clips_placed] or [0])
    if narrative_end <= 0:
        # Live-read VO cut: no SOT clips and no VO audio on the timeline (the
        # anchor reads the script live). Cover a FIXED target span with B-roll,
        # HARD-CAPPED to the profile's target video duration (~30s) so the cut
        # never runs long — even when the source script is a full package. This
        # keeps the video short and, because fewer cover clips are needed, lets
        # the strict locked-off stability pool suffice (avoiding the fallback to
        # shakier "usable" footage). Without this the rebuild would bail and
        # leave the program track empty.
        target_ms = int((shot_config or {}).get("target_video_duration_s", 30) * 1000)
        narrative_end = target_ms
        if narrative_end <= 0:
            return
        logger.info(
            f"Live-read VO cut (no anchor clips): filling {narrative_end}ms of "
            f"B-roll cover across V1 (hard-capped to the ~"
            f"{target_ms // 1000}s target video duration)"
        )

        # Per-section aligned B-roll: place each VO section's own best-matching
        # stable clips over its slice of the span, so cover tracks the script
        # line-by-line (rather than one whole-story relevance ranking). Falls
        # back to the global fill below if config/assets are missing.
        per_section = _fill_v1_per_section(
            script_analysis, narrative_end, enriched_assets, shot_config)
        if per_section is not None:
            v1_track["clips"] = sorted(per_section, key=lambda c: c.get("start", 0))
            v2_track["clips"] = []
            cursor = 0
            for c in v1_track["clips"]:
                if c.get("start", 0) > cursor:
                    logger.warning(
                        f"V1 gap remains at {cursor}-{c['start']}ms after per-section fill")
                cursor = max(cursor, c.get("end", 0))
            logger.info(
                f"Rebuilt B-roll (per-section aligned): V1 {len(v1_track['clips'])} "
                f"cover clips gapless to {narrative_end}ms, V2 empty")
            return

    # V1 gaps to fill with B-roll cover: leading, inter-SOT, and trailing.
    v1_gaps = []
    cursor = 0
    for c in sot_clips:
        if c.get("start", 0) > cursor:
            v1_gaps.append((cursor, c["start"]))
        cursor = max(cursor, c.get("end", 0))
    if narrative_end > cursor:
        v1_gaps.append((cursor, narrative_end))

    # V2 cutaway spans: the SOT ranges only.
    sot_spans = [(c.get("start", 0), c.get("end", 0)) for c in sot_clips]

    # Generate one embedding for the overall B-roll query (avoid per-clip calls)
    # Use a composite query from all VO + SOT section texts
    sections = script_analysis.get("parsedSections", [])
    broll_query_parts = []
    for s in sections:
        if s.get("sectionType") in ("pkg_vo", "pkg_sot", "pkg_nats"):
            broll_query_parts.append(s.get("content", ""))
    broll_query_text = " ".join(broll_query_parts)[:2000] or "B-roll cover footage"

    try:
        embed_resp = bedrock.invoke_model(
            modelId="amazon.nova-2-multimodal-embeddings-v1:0",
            contentType="application/json",
            accept="application/json",
            body=json.dumps({
                "taskType": "SINGLE_EMBEDDING",
                "singleEmbeddingParams": {
                    "embeddingPurpose": "VIDEO_RETRIEVAL",
                    "embeddingDimension": 1024,
                    "text": {"truncationMode": "END", "value": broll_query_text},
                },
            }),
        )
        embed_body = json.loads(embed_resp["body"].read())
        query_vector = embed_body["embeddings"][0]["embedding"]
    except Exception as e:
        logger.warning(f"Failed to generate B-roll embedding: {e}")
        return

    # Exclude V1 interview items from B-roll
    v1_item_ids = {c.get("mimirItemId") for c in v1_track.get("clips", [])}
    broll_ids = [i for i in item_ids if i not in v1_item_ids]
    if not broll_ids:
        broll_ids = item_ids

    # Query for all B-roll candidates at once (top 50)
    try:
        query_resp = s3vectors_client.query_vectors(
            vectorBucketName=vector_bucket,
            indexName=index_name,
            queryVector={"float32": query_vector},
            topK=50,
            returnMetadata=True,
            returnDistance=True,
            filter={"itemId": {"$in": broll_ids}},
        )
    except Exception as e:
        logger.warning(f"B-roll vector query failed: {e}")
        return

    # Shot-duration config (editorial defaults) — drives min stable-span length
    # and the clip lengths in _fill_spans. Falls back to the legacy ~6s target
    # with a 3s floor and no ceiling when no profile config is supplied.
    shot = shot_config or {}
    min_shot_s = shot.get("min_shot_duration_s", 3)
    target_clip_ms = int(shot.get("target_shot_duration_s", 6) * 1000)
    min_clip_ms = int(min_shot_s * 1000)
    max_clip_ms = int(shot["max_shot_duration_s"] * 1000) if shot.get("max_shot_duration_s") else None

    # Camera-stability: prefer LOCKED-OFF footage. Build stable-only span maps
    # from the per-second metrics (pans/"move" seconds excluded — they read as
    # jerky in cover footage), discarding spans shorter than the min shot.
    raw_stability = _load_stability_cache(
        enriched_assets,
        os.environ.get("STABILITY_BUCKET") or os.environ.get("TRANSCRIPT_STAGING_BUCKET", ""),
        raw=True)

    def _build_pool(cache):
        """Build the candidate pool trimmed against *cache* (empty = no trim)."""
        pool = []
        for v in query_resp.get("vectors", []):
            meta = v.get("metadata", {})
            cand_item = meta.get("itemId")
            trimmed = _stability_trim(
                cand_item, meta.get("startTimeSeconds", 0), meta.get("endTimeSeconds", 15),
                cache, min_clip_s=float(min_shot_s))
            if trimmed is None:
                continue
            pool.append({
                "itemId": cand_item,
                "segmentIndex": meta.get("segmentIndex"),
                "startTimeSeconds": trimmed[0],
                "endTimeSeconds": trimmed[1],
                "distance": v.get("distance", 1.0),
            })
        return pool

    # How much B-roll cover do we actually need to fill (V1 VO-led gaps)?
    needed_ms = sum(max(0, hi - lo) for lo, hi in v1_gaps)
    needed_clips = max(1, needed_ms // max(1, target_clip_ms))

    # Tier 1: strict locked-off footage.
    strict_cache = {mid: _stable_only_segments(data) for mid, data in raw_stability.items()}
    candidate_pool = _build_pool(strict_cache)

    # Graceful degradation: breaking-news/handheld stories may have little or no
    # truly locked-off footage. Rather than reject everything (which leaves the
    # program track with gaps), relax progressively so mildly unstable footage
    # is used — only genuinely unusable frames are ever excluded.
    if len(candidate_pool) < needed_clips:
        logger.warning(
            f"Strict locked-off B-roll pool too small "
            f"({len(candidate_pool)} < ~{needed_clips} needed) — relaxing to "
            f"usable-labeled footage (handheld/breaking-news tolerant)")
        usable_cache = {mid: (data.get("segments") or []) for mid, data in raw_stability.items()}
        candidate_pool = _build_pool(usable_cache)
    if len(candidate_pool) < needed_clips:
        logger.warning(
            f"Relaxed B-roll pool still small ({len(candidate_pool)} < "
            f"~{needed_clips} needed) — using unfiltered candidates so shots are "
            f"not dropped for lack of stability data")
        candidate_pool = _build_pool({})

    logger.info(f"B-roll candidate pool: {len(candidate_pool)} segments from vector index "
                f"(need ~{needed_clips} clips for {needed_ms}ms of cover)")

    # Shared dedup set across both tracks: never place the same segment twice.
    used_segments = set()

    # V1: fill the VO-led gaps with B-roll cover (nat sound at reduced gain).
    v1_fillers = _fill_spans(v1_gaps, candidate_pool, used_segments, broll_cover=True,
                             min_clip_ms=min_clip_ms, target_clip_ms=target_clip_ms,
                             max_clip_ms=max_clip_ms)
    v1_track["clips"] = sorted(sot_clips + v1_fillers, key=lambda c: c.get("start", 0))

    # V2: cutaways ONLY over jump cuts (joins between adjacent soundbite clips)
    # — never blanket coverage, which would hide the interviewee (V2 renders
    # above V1). With single-clip soundbites V2 stays empty and the interview
    # is fully visible; the editor cuts to B-roll manually where they choose.
    old_v2_count = len(v2_track.get("clips", []))
    jump_cut_spans = []
    for prev, nxt in zip(sot_clips, sot_clips[1:]):
        if prev.get("end") == nxt.get("start"):  # hard SOT-to-SOT join
            join = prev["end"]
            lo = max(prev.get("start", 0), join - 1500)
            hi = min(nxt.get("end", join), join + 1500)
            if hi > lo:
                jump_cut_spans.append((lo, hi))
    v2_track["clips"] = _fill_spans(jump_cut_spans, candidate_pool, used_segments,
                                    min_clip_ms=min_clip_ms, target_clip_ms=target_clip_ms,
                                    max_clip_ms=max_clip_ms)

    # Sanity: warn if V1 still has a gap (pool exhaustion) — Cutter can't edit it.
    cursor = 0
    for c in v1_track["clips"]:
        if c.get("start", 0) > cursor:
            logger.warning(f"V1 gap remains at {cursor}-{c['start']}ms after B-roll fill")
        cursor = max(cursor, c.get("end", 0))

    logger.info(
        f"Rebuilt B-roll tracks: V1 {len(sot_clips)} SOTs + {len(v1_fillers)} cover clips "
        f"(gapless to {narrative_end}ms), V2 {old_v2_count} -> {len(v2_track['clips'])} cutaways "
        f"over {len(jump_cut_spans)} jump cut(s), {len(used_segments)} unique segments")


def run_timeline_assembly(
    script_analysis: dict,
    source_material: dict,
    enriched_assets: list,
    story_id: str,
    story_title: str,
    task_token: str,
    vo_clips: dict = None,
    run_id: str = "",
    folder_id: str = None,
    profile_directive: str = "",
    shot_config: dict = None,
    synthesize_voiceover: bool = True,
    timeline_label: str = "Rough Cut",
) -> dict:
    """Assemble a rough cut timeline and create it in Mimir.

    The agent produces ONLY the sequenceDetails JSON — no tools. Python
    then calls create_timeline and update_story_status deterministically.

    Args:
        script_analysis: The structured ScriptAnalysis dict.
        source_material: The source material dict with candidateSegments and gaps.
        story_id: The Saga story ID.
        story_title: The story title (used in the timeline title).
        task_token: The Step Functions task token for callbacks.
        vo_clips: Dict mapping str(orderIndex) → {mimirItemId, durationMs, ...}
                  pre-synthesized by _synthesize_voiceovers. If None, no VO clips.

    Returns:
        A dict with ``timelineItemId``, ``summary``, and ``sequenceDetails``.

    Raises:
        ValueError: If the agent output cannot be parsed or fails validation.
    """
    # Build the VO clips section for the user message
    vo_clips_section = ""
    if vo_clips:
        vo_clips_section = (
            f"\n\n## Pre-Synthesized Voice-Over Clips\n"
            f"These VO clips have already been synthesized via Polly and uploaded to Mimir. "
            f"Use the `mimirItemId` and `durationMs` directly when placing clips on A1. "
            f"Set `sourceType: \"audio-only\"` on each A1 clip.\n"
            f"```json\n{json.dumps(vo_clips, indent=2)}\n```"
        )

    user_message = (
        f"## Story Information\n"
        f"- Story ID: {story_id}\n"
        f"- Story Title: {story_title}\n\n"
        f"## Script Analysis (parsedSections)\n```json\n{json.dumps(script_analysis.get('parsedSections', []), indent=2)}\n```\n\n"
        f"## Source Material (Ranked Candidates)\n```json\n{json.dumps(source_material, indent=2)}\n```"
        f"{vo_clips_section}"
    )

    logger.info(f"Running Timeline Assembly Agent for story: {story_title}")

    bedrock_model = _get_bedrock_model()

    # Zero-tool agent — only produces sequenceDetails JSON
    agent = Agent(
        model=bedrock_model,
        system_prompt=TIMELINE_ASSEMBLY_PROMPT + (profile_directive or ""),
        tools=[],
    )

    try:
        result = agent(user_message)
        response_text = str(result)

        # Parse JSON — try all json blocks, prefer the last valid one
        json_blocks = re.findall(r"```(?:json)?\s*([\s\S]*?)```", response_text)
        if not json_blocks:
            json_match = re.search(r"<json>\s*([\s\S]*?)</json>", response_text)
            if json_match:
                json_blocks = [json_match.group(1)]
            else:
                brace_match = re.search(r"\{[\s\S]*\}", response_text)
                json_blocks = [brace_match.group(0)] if brace_match else [response_text]

        assembly = None
        last_error = None
        for block in reversed(json_blocks):
            try:
                candidate = json.loads(block.strip())
                if isinstance(candidate, dict) and "sequenceDetails" in candidate:
                    assembly = candidate
                    break
            except json.JSONDecodeError as exc:
                last_error = exc
                continue

        if assembly is None:
            try:
                assembly = json.loads(json_blocks[-1].strip())
            except json.JSONDecodeError as exc:
                raise ValueError(
                    f"Timeline Assembly Agent returned invalid JSON: {last_error or exc}"
                ) from exc

        # Save the agent's raw output as an artifact
        _save_artifact(story_id, "timeline-assembly-agent-output", assembly, run_id)

        # Validate the assembly has sequenceDetails
        if "sequenceDetails" not in assembly or not isinstance(assembly.get("sequenceDetails"), dict):
            raise ValueError("Timeline Assembly Agent output missing 'sequenceDetails' object")

        # No-AI-voice profiles (Generate VO / VOSOT): the anchor reads the
        # script live, so there must be NO voice-over audio on A1 (track id 3).
        # The assembly agent can hallucinate placeholder VO items (e.g.
        # "vo_section_0") when no real synthesized clips are supplied; those
        # items don't exist in Mimir and 404 in Cutter ("getPlayableItem").
        # Clear the VO track deterministically when synthesis is off.
        if not synthesize_voiceover:
            for track in assembly.get("sequenceDetails", {}).get("tracks", []):
                is_vo_track = track.get("id") == 3 or (
                    track.get("mediaType") == "audio"
                    and "voice" in str(track.get("name", "")).lower()
                )
                if is_vo_track and track.get("clips"):
                    logger.info(
                        f"Clearing {len(track['clips'])} VO audio clip(s) from A1 — "
                        f"profile reads the script live (no AI voice)"
                    )
                    track["clips"] = []

        # Audio channel mapping is now handled in _build_multitrack_timeline_payload:
        # V1 clips → audioTracks[0,1], V2 clips → audioTracks[2,3], VO → audioTracks[4]
        # No need to rebuild A2 from V1 in post-processing.

        # --- Python: deterministic narrative re-layout (V1 + VO positions) ---
        # Fixes LLM arithmetic drift that overlapped VO narration (A5) with
        # interview soundbite audio (A1/A2). Must run before the V2 rebuild.
        try:
            _normalize_primary_sequence(assembly, script_analysis, source_material, vo_clips or {})
        except Exception as e:
            logger.warning(f"Sequence normalization failed, using agent's positions: {e}")

        # --- Python: rebuild B-roll across V1/V2 (broadcast layout) ---
        # V1 becomes a gapless program track (SOTs + B-roll cover under VO) —
        # Cutter doesn't support video-track gaps on V1 (leading gap snaps the
        # track to 0; mid-track gaps aren't editable). V2 carries cutaway cover
        # over the SOT ranges only; V2 gaps are fine.
        try:
            _rebuild_broll_tracks(assembly, enriched_assets, script_analysis, shot_config)
        except Exception as e:
            logger.warning(f"B-roll rebuild failed, using agent's original tracks: {e}")

        # --- Python: create timeline deterministically ---
        logger.info("Creating timeline in Mimir (Python)")
        # Collect all item IDs from all tracks (including rebuilt V2)
        parent_ids = set()
        for seg in source_material.get("candidateSegments", []):
            for c in seg.get("candidates", []):
                if c.get("mimirItemId"):
                    parent_ids.add(c["mimirItemId"])
        # Add any new items from the V2 rebuild
        for track in assembly.get("sequenceDetails", {}).get("tracks", []):
            for clip in track.get("clips", []):
                if clip.get("mimirItemId"):
                    parent_ids.add(clip["mimirItemId"])
        parent_ids = list(parent_ids)
        # Don't include VO audio items as parent IDs — they're empty shells
        # that the Cutter API can't look up. They're referenced in the
        # sequenceDetails itemRefs directly.

        timeline_result_json = create_timeline(
            title=f"{story_title} - {timeline_label}",
            sequence_details_json=json.dumps(assembly.get("sequenceDetails", {})),
            parent_item_ids=parent_ids,
            folder_id=folder_id,
        )

        timeline_data = json.loads(timeline_result_json) if isinstance(timeline_result_json, str) else timeline_result_json
        timeline_item_id = timeline_data.get("id", "")
        logger.info(f"Timeline created: {timeline_item_id}")

        # --- Python: update story status ---
        try:
            update_story_status(
                story_id=story_id,
                timeline_item_id=timeline_item_id,
            )
            logger.info(f"Story status updated for {story_id}")
        except Exception as e:
            logger.warning(f"Failed to update story status: {e}")

        # Build final result
        summary = assembly.get("summary", {})
        summary.setdefault("clipCount", 0)
        summary.setdefault("totalDurationMs", 0)
        summary.setdefault("trackCount", 4)

        final_result = {
            "timelineItemId": timeline_item_id,
            "summary": summary,
            "sequenceDetails": assembly.get("sequenceDetails", {}),
        }

        # Save final result artifact
        _save_artifact(story_id, "final-result", final_result, run_id)

        # Send success callback
        send_task_success(
            task_token=task_token,
            timeline_item_id=timeline_item_id,
            summary=summary,
        )

        logger.info(
            f"Timeline assembly complete: {summary.get('clipCount', 0)} clips, "
            f"{summary.get('totalDurationMs', 0)}ms total"
        )
        return final_result

    except Exception as exc:
        logger.error(f"Timeline assembly failed: {exc}")
        send_task_failure(
            task_token=task_token,
            error="TimelineAssemblyError",
            cause=str(exc),
        )
        raise


def _gather_model_knowledge(
    story_title: str,
    story_description: str,
) -> str:
    """Ask the foundation model what it knows about the story topic.

    Uses the model's parametric knowledge to surface background context —
    people, organisations, events, locations — that may not be in the
    transcripts or script. The result is injected into Script Analysis as
    additional context so the agent can produce richer section breakdowns
    and better clip matching.

    Returns an empty string if the model has nothing useful to add or if
    the call fails.
    """
    query = story_title.strip()
    if story_description:
        query += f" — {story_description.strip()[:300]}"

    prompt = (
        f"A broadcast news story is being produced with the title: \"{story_title}\"\n"
        + (f"Description: {story_description}\n\n" if story_description else "\n")
        + "In 3-5 concise paragraphs, summarise any relevant background knowledge you have "
        "about the people, organisations, locations, or events referenced in this story title. "
        "Focus on factual context that would help a news producer understand the story. "
        "If you have no relevant knowledge, respond with exactly: NO_KNOWLEDGE"
    )

    try:
        bedrock_model = _get_bedrock_model()
        agent = Agent(
            model=bedrock_model,
            system_prompt=(
                "You are a knowledgeable research assistant for broadcast journalists. "
                "Provide concise, factual background on news topics. "
                "Never fabricate facts. If you are uncertain, say so."
            ),
        )
        result = str(agent(prompt)).strip()

        if not result or result.upper().startswith("NO_KNOWLEDGE"):
            logger.info("Model has no background knowledge for this story topic")
            return ""

        logger.info(f"Model background knowledge gathered: {len(result)} chars")
        return result

    except Exception as e:
        logger.warning(f"Model knowledge gathering failed (non-fatal): {e}")
        return ""


def _synthesize_script_from_transcripts(
    story_title: str,
    story_description: str,
    enriched_assets: list,
) -> str:
    """Synthesize a narrative script from available asset transcripts.

    Called when both the story Content section and Research section are empty.
    Reads all available transcripts from S3, concatenates them with asset
    titles as headers, then asks Nova Pro to write a broadcast news script
    from the raw material.

    Args:
        story_title: The story title.
        story_description: The story description (may be empty).
        enriched_assets: Enriched asset list from story-context-handler.

    Returns:
        A synthesized script string, or empty string if no transcripts found.
    """
    bucket = os.environ.get("TRANSCRIPT_STAGING_BUCKET", "")
    s3 = boto3.client("s3") if bucket else None
    transcript_blocks = []

    import urllib.request

    for asset in enriched_assets:
        item_id = asset.get("mimirItemId", "")
        if not item_id:
            continue
        if not asset.get("hasTranscript") and not asset.get("generatedTranscriptS3Uri") and not asset.get("timedTranscriptUrl"):
            continue

        full_text = ""

        # 1. Try staging bucket first (fastest, already processed)
        if bucket:
            key = f"transcripts/{item_id}/transcript.json"
            try:
                resp = s3.get_object(Bucket=bucket, Key=key)
                tx = json.loads(resp["Body"].read().decode("utf-8"))
                full_text = tx.get("fullTranscript", "").strip()
            except Exception as e:
                logger.debug(f"Staging bucket miss for {item_id}: {e}")

        # 2. Fall back to timedTranscriptUrl on the asset (pre-signed Mimir URL)
        if not full_text:
            timed_url = asset.get("timedTranscriptUrl", "")
            if timed_url:
                try:
                    with urllib.request.urlopen(timed_url, timeout=10) as resp:
                        data = json.loads(resp.read().decode("utf-8"))
                    # Mimir timed transcript format: numeric keys, each {content, startTime, endTime}
                    if isinstance(data, dict) and data.get("0", {}).get("content") is not None:
                        full_text = " ".join(w["content"] for w in data.values() if isinstance(w, dict) and "content" in w)
                    elif isinstance(data, dict):
                        full_text = (data.get("fullTranscript") or
                                     (data.get("results", {}).get("transcripts") or [{}])[0].get("transcript") or
                                     data.get("transcript") or "")
                    full_text = full_text.strip()
                    if full_text:
                        logger.debug(f"Got transcript from timedTranscriptUrl for {item_id}: {len(full_text)} chars")
                except Exception as e:
                    logger.debug(f"timedTranscriptUrl fetch failed for {item_id}: {e}")

        if full_text:
            title = asset.get("title", item_id)
            transcript_blocks.append(f"### {title}\n{full_text}")

    if not transcript_blocks:
        logger.info("No transcripts available — cannot synthesize script")
        return ""

    combined = "\n\n".join(transcript_blocks)
    logger.info(
        f"Synthesizing script from {len(transcript_blocks)} transcripts "
        f"({len(combined)} chars)"
    )

    prompt = (
        "You are a broadcast news producer. Below are raw transcripts from video clips "
        "associated with a news story. Using only the information in these transcripts, "
        "write a complete broadcast news package script. Include:\n"
        "- An anchor introduction\n"
        "- Voice-over narration sections (PKG VO) that tell the story\n"
        "- Sound-on-tape sections (SOT) using direct quotes from the transcripts, "
        "attributed to the speaker\n"
        "- A live tag or wrap\n\n"
        "Format the script clearly with section labels. "
        "Do not invent facts not present in the transcripts.\n\n"
        f"## Story Title\n{story_title}\n\n"
        f"## Story Description\n{story_description or '(none provided)'}\n\n"
        f"## Transcripts\n{combined[:12000]}"  # cap to avoid token overflow
    )

    try:
        bedrock_model = _get_bedrock_model()
        agent = Agent(
            model=bedrock_model,
            system_prompt="You are a broadcast news script writer. Output only the script text with no preamble.",
        )
        result = agent(prompt)
        synthesized = str(result).strip()
        logger.info(f"Synthesized script: {len(synthesized)} chars")
        return synthesized
    except Exception as e:
        logger.warning(f"Script synthesis from transcripts failed: {e}")
        return ""


# Section-type groups for splitting a VOSOT script into two instances.
# VO family = spoken-by-anchor lines + natural sound; SOT = interview soundbites.
_VO_SECTION_TYPES = {"pkg_vo", "pkg_nats", "anchor_intro", "reporter_live", "live_tag", "anchor_qa"}
_SOT_SECTION_TYPES = {"pkg_sot", "super"}


def _sections_subset(script_analysis: dict, keep_types: set) -> dict:
    """Return a shallow copy of *script_analysis* whose parsedSections is
    filtered to only the given sectionTypes (used to split VOSOT into a VO
    instance and a SOT instance)."""
    subset = dict(script_analysis)
    subset["parsedSections"] = [
        s for s in script_analysis.get("parsedSections", [])
        if s.get("sectionType") in keep_types
    ]
    return subset


def _build_script_sections_from_analysis(script_analysis: dict) -> list:
    """Convert a ScriptAnalysis parsedSections array into linear instance script sections.

    Maps each parsed section to a dict with:
      - ``type``: ``"vo"`` for anchor/reporter reads, ``"pkg"`` for package script
      - ``label``: Human-readable label (e.g. "ANCHOR:", "PKG VO:", "SOT:")
      - ``text``: The script text

    VO sections (anchor_intro, reporter_live, live_tag, anchor_qa, pkg_vo) are
    written as white ALL CAPS text. Package script sections (pkg_sot, pkg_nats,
    super) are written in green.

    Args:
        script_analysis: ScriptAnalysis dict with parsedSections.

    Returns:
        List of section dicts for use with create_or_update_linear_instance.
    """
    # Map section types to (display_type, label)
    # "vo" → white ALL CAPS (anchor/talent reads)
    # "pkg" → green (package script elements)
    SECTION_MAP = {
        "anchor_intro":   ("vo",  "ANCHOR:"),
        "reporter_live":  ("vo",  "ON CAM:"),
        "pkg_vo":         ("vo",  "PKG VO:"),
        "live_tag":       ("vo",  "LIVE TAG:"),
        "anchor_qa":      ("vo",  "ANCHOR Q&A:"),
        "pkg_sot":        ("pkg", "SOT:"),
        "pkg_nats":       ("pkg", "NATS:"),
        "super":          ("pkg", "SUPER:"),
    }

    sections = []
    for parsed in script_analysis.get("parsedSections", []):
        section_type = parsed.get("sectionType", "")
        content = parsed.get("content", "").strip()
        if not content:
            continue

        display_type, label = SECTION_MAP.get(section_type, ("vo", section_type.upper() + ":"))

        # For SOT sections, prefer the quotedText if available
        if section_type == "pkg_sot":
            speaker = parsed.get("speaker", "")
            quoted = parsed.get("quotedText", content)
            if speaker:
                label = f"SOT ({speaker}):"
            content = quoted

        sections.append({
            "type": display_type,
            "label": label,
            "text": content,
        })

    return sections


@app.entrypoint
def invoke(payload):
    """Main entrypoint for the Rough Cut Agent.

    Receives story context, enriched assets, and a Step Functions task token.
    Orchestrates the multi-agent graph: Script Analysis → Source Material → Timeline Assembly.
    Sends SendTaskSuccess/SendTaskFailure callbacks when complete.
    """
    task_token = payload.get("task_token")

    try:
        logger.info(f"Rough Cut Agent invoked with payload keys: {list(payload.keys())}")

        # Select the rough-cut profile (prompt/constraint overrides) by type.
        rough_cut_type = payload.get("roughCutType") or DEFAULT_ROUGH_CUT_TYPE
        profile = get_profile(rough_cut_type)
        logger.info(f"Rough cut type: {rough_cut_type} ({profile['label']})")

        # Extract payload fields — storyContext comes from the story-context-handler Lambda
        # which fetches and enriches the story data from Saga API
        story_context_data = payload.get("storyContext", {})
        story = story_context_data.get("story", payload.get("story", {}))
        assets = story_context_data.get("assets", payload.get("assets", []))
        instances = story_context_data.get("instances", payload.get("instances", []))
        notes = story_context_data.get("notes", payload.get("notes", []))

        if not story:
            error_msg = "No story context provided in payload"
            if task_token:
                send_task_failure(
                    task_token=task_token,
                    error="PayloadValidationError",
                    cause=error_msg,
                )
            raise ValueError(error_msg)

        story_id = story.get("mId", story.get("id", ""))
        story_title = story.get("mTitle", story.get("title", "Untitled Story"))

        # Generate a run ID for artifact storage
        import time as _time
        run_id = str(int(_time.time()))

        # Extract Mimir folder ID from Saga sync providers
        mimir_folder_id = None
        for provider in story.get("mSyncProviders", []):
            for meta in provider.get("mMetaData", []):
                if meta.get("key") == "folderId":
                    mimir_folder_id = meta.get("value")
                    break
        if mimir_folder_id:
            logger.info(f"Mimir folder ID: {mimir_folder_id}")
        else:
            logger.warning("No Mimir folder ID found in story sync providers")

        # Extract plain text from Slate document format (content.document[].children[].text)
        # Priority: 1) assigned linear instance content, 2) story.content field
        def _slate_to_text(content) -> str:
            if isinstance(content, dict) and "document" in content:
                lines = []
                for block in content["document"]:
                    children = block.get("children", [])
                    line = "".join(child.get("text", "") for child in children)
                    if line.strip():
                        lines.append(line)
                return "\n".join(lines)
            elif isinstance(content, str):
                return content
            return ""

        # First: look for a linear instance that has content (assigned or unassigned)
        # Prefer assigned instances (a producer has claimed it and written a script)
        # over unassigned ones. Skip instances with no content.
        script_text = ""
        script_source = "none"

        def _is_linear(inst: dict) -> bool:
            platform = (
                (inst.get("platformInfo") or {}).get("platform")
                or inst.get("platformType")
                or ""
            ).lower()
            return platform == "linear"

        def _is_assigned(inst: dict) -> bool:
            # Real Saga API: an instance is "assigned" when its platformInfo
            # account has a rundown accountId. Fall back to legacy fields.
            account = (inst.get("platformInfo") or {}).get("account") or {}
            return bool(
                account.get("accountId")
                or inst.get("assignedUserId")
                or inst.get("assignedUser")
            )

        linear_instances = [inst for inst in instances if _is_linear(inst)]
        # Prefer an assigned instance (a producer has claimed it and written a
        # script) over an unassigned one, so a reporter's existing script is
        # used as context when present.
        linear_instances.sort(key=lambda i: 0 if _is_assigned(i) else 1)
        for inst in linear_instances:
            inst_text = _slate_to_text(inst.get("content", {}))
            if inst_text.strip():
                script_text = inst_text
                script_source = f"linear instance {inst.get('id', '')}"
                logger.info(
                    f"Using script from linear instance {inst.get('id', '')} "
                    f"({len(script_text)} chars)"
                )
                break

        # Fallback: story-level content field
        if not script_text.strip():
            story_content = story.get("content", {})
            script_text = _slate_to_text(story_content)
            if script_text.strip():
                script_source = "story.content"
                logger.info(f"Using script from story.content ({len(script_text)} chars)")

        logger.info(f"Script source: {script_source}")

        # Extract Research section text from instances.
        # A "research" instance is identified by instanceType containing "research"
        # (case-insensitive). If multiple exist, concatenate them.
        research_text = ""
        research_lines = []
        for inst in instances:
            inst_type = inst.get("instanceType", inst.get("type", "")).lower()
            if "research" in inst_type:
                inst_content = inst.get("content", {})
                if isinstance(inst_content, dict) and "document" in inst_content:
                    for block in inst_content["document"]:
                        children = block.get("children", [])
                        line = "".join(child.get("text", "") for child in children)
                        if line.strip():
                            research_lines.append(line)
                elif isinstance(inst_content, str) and inst_content.strip():
                    research_lines.append(inst_content)
        if research_lines:
            research_text = "\n".join(research_lines)
            logger.info(f"Extracted research section: {len(research_text)} chars from {len(research_lines)} lines")
        else:
            logger.info("No research instance found — proceeding with content section only")

        # Also build research text from notes (written by story-research-handler).
        # Notes have title + description fields populated by the Research Story action.
        if notes:
            note_blocks = []
            for note in notes:
                note_title = note.get("title", "")
                note_description = note.get("description", "")
                if note_title and note_description:
                    note_blocks.append(f"### {note_title}\n{note_description}")
                elif note_description:
                    note_blocks.append(note_description)
            if note_blocks:
                notes_research = "\n\n".join(note_blocks)
                research_text = (research_text + "\n\n" + notes_research).strip()
                logger.info(f"Appended {len(note_blocks)} research notes to research_text ({len(research_text)} total chars)")

        logger.info(
            f"Processing story '{story_title}' "
            f"with {len(assets)} assets, {len(instances)} instances, {len(notes)} notes"
        )

        # --- Stage 0: Gather background context (only when script is absent) ---
        # When a producer has written a script, trust it and go straight to
        # Script Analysis. Only gather additional context when the script is
        # missing so the model has enough material to work with.
        story_description = story.get("mDescription", story.get("description", ""))
        model_knowledge = ""

        if not script_text.strip():
            # Stage 0a: Ask the model what it knows about the story topic.
            # Surfaces background on people, organisations, and events that
            # may not be in the transcripts.
            logger.info("Stage 0a: No script found — gathering model background knowledge")
            model_knowledge = _gather_model_knowledge(
                story_title=story_title,
                story_description=story_description,
            )
            if model_knowledge:
                _save_artifact(story_id, "00a-model-knowledge", {"knowledge": model_knowledge}, run_id)

            # Stage 0b: Synthesize a script from transcripts when research is
            # also absent. If research exists, Script Analysis can use that
            # directly alongside the model knowledge.
            if not research_text.strip():
                logger.info(
                    "Stage 0b: No content or research section found — "
                    "synthesizing script from transcripts"
                )
                synthesized = _synthesize_script_from_transcripts(
                    story_title=story_title,
                    story_description=story_description,
                    enriched_assets=assets,
                )
                if synthesized:
                    script_text = synthesized
                    _save_artifact(story_id, "00b-synthesized-script", {"script": synthesized}, run_id)
                    logger.info("Stage 0b: Script synthesized from transcripts")
                else:
                    logger.warning(
                        "Stage 0b: No transcripts available — Script Analysis will "
                        "proceed with model knowledge and story title only"
                    )
        else:
            logger.info("Stage 0: Script present — skipping background knowledge gathering")

        # --- Stage 1: Script Analysis ---
        try:
            story_context = {
                "title": story_title,
                "description": story_description,
                "script": script_text,
                "research": research_text,
                "model_knowledge": model_knowledge,
                "notes": notes,
            }
            logger.info("Stage 1: Running Script Analysis Agent")
            script_analysis = run_script_analysis(
                story_context, profile_directive=profile["script_directive"]
            )
            _save_artifact(story_id, "01-script-analysis", script_analysis, run_id)
            logger.info("Stage 1: Script Analysis complete")

            # Enforce VO-only structure deterministically for profiles that
            # exclude SOT (Generate VO / AI VO). The script-analysis directive
            # asks for VO-only, but when the SOURCE script already contains
            # soundbites the model can still (non-deterministically) emit
            # pkg_sot / interview sections. If those slip through they become V1
            # anchor clips, which makes the cut run to the full script length
            # and defeats the ~30s VO target. Strip them here so a VO cut is
            # always VO/nats only, regardless of model variance or source-script
            # content.
            if not profile.get("include_sot", True):
                _VO_KEEP = {"pkg_vo", "pkg_nats"}
                _orig_sections = script_analysis.get("parsedSections", [])
                _kept = [s for s in _orig_sections if s.get("sectionType") in _VO_KEEP]
                if len(_kept) != len(_orig_sections):
                    logger.info(
                        f"VO-only profile '{rough_cut_type}': dropped "
                        f"{len(_orig_sections) - len(_kept)} non-VO section(s) "
                        f"(e.g. SOT/interview) — keeping {len(_kept)} VO/nats sections"
                    )
                # Re-index so section order keys stay contiguous downstream.
                for _i, _s in enumerate(_kept):
                    _s["orderIndex"] = _i
                script_analysis["parsedSections"] = _kept
                script_analysis["soundbites"] = []
                script_analysis["interviewSegments"] = []
        except Exception as e:
            logger.error(f"Stage 1 (Script Analysis) failed: {e}")
            if task_token:
                send_task_failure(
                    task_token=task_token,
                    error="ScriptAnalysisError",
                    cause=str(e),
                )
            raise

        # --- Stage 2: Source Material Search ---
        try:
            logger.info("Stage 2: Running Source Material Agent")
            source_material = run_source_material(script_analysis, assets)
            _save_artifact(story_id, "02-source-material", source_material, run_id)

            # Log coverage and VO sections tagged for Polly generation
            coverage_pct = source_material.get("coveragePercentage", 0)
            polly_vo_count = sum(
                1
                for seg in source_material.get("candidateSegments", [])
                for cand in seg.get("candidates", [])
                if cand.get("voiceoverSource") == "polly_generated"
            )
            logger.info(
                f"Stage 2: Source Material search complete — "
                f"coverage: {coverage_pct}%, "
                f"VO sections tagged for Polly generation: {polly_vo_count}"
            )
        except Exception as e:
            logger.error(f"Stage 2 (Source Material) failed: {e}")
            if task_token:
                send_task_failure(
                    task_token=task_token,
                    error="SourceMaterialError",
                    cause=str(e),
                )
            raise

        # --- Stage 2.5: Detect Reporter VO + Synthesize Voice-Overs ---
        # GATED on the profile's synthesize_voiceover flag. This is the single
        # switch that separates "Generate VO"/"Generate VOSOT" (anchor reads the
        # script live on linear TV — NO AI voice is ever created) from "Generate
        # AI VO" (reporter-driven digital/social, which does synthesize
        # narration). When off, no VO audio is produced and A1 stays empty.
        if not profile.get("synthesize_voiceover", True):
            logger.info(
                f"Stage 2.5: SKIPPED — profile '{rough_cut_type}' ({profile['label']}) "
                f"does not synthesize an AI voice-over (script is read live). "
                f"No Polly narration will be created."
            )
            vo_clips = {}
        else:
          try:
            all_item_ids = [a.get("mimirItemId") for a in assets if a.get("mimirItemId")]

            # Detect reporter-provided VO by checking transcript word overlap
            logger.info("Stage 2.5a: Detecting reporter-provided voice-overs")
            vo_tags = _detect_reporter_vo(script_analysis, assets)
            reporter_count = sum(1 for v in vo_tags.values() if v.get("voiceoverSource") == "reporter_provided")
            polly_count = sum(1 for v in vo_tags.values() if v.get("voiceoverSource") == "polly_generated")
            logger.info(f"Stage 2.5a: VO detection complete — {reporter_count} reporter-provided, {polly_count} polly_generated")
            _save_artifact(story_id, "03-vo-detection", vo_tags, run_id)

            # Synthesize Polly audio for polly_generated sections
            logger.info("Stage 2.5b: Synthesizing Polly voice-overs")
            vo_clips = _synthesize_voiceovers(
                script_analysis=script_analysis,
                source_material=source_material,
                story_id=story_id,
                story_title=story_title,
                parent_item_ids=all_item_ids,
                vo_tags=vo_tags,
                folder_id=mimir_folder_id,
            )
            logger.info(f"Stage 2.5b: Synthesized {len(vo_clips)} VO clips")
            _save_artifact(story_id, "04-vo-clips", vo_clips, run_id)
          except Exception as e:
            logger.warning(f"Stage 2.5 (VO Detection/Synthesis) failed non-fatally: {e} — continuing without VO clips")
            vo_clips = {}

        # --- Stage 3: Timeline Assembly ---
        # run_timeline_assembly handles SendTaskSuccess/SendTaskFailure internally
        logger.info("Stage 3: Running Timeline Assembly Agent")
        result = run_timeline_assembly(
            script_analysis=script_analysis,
            source_material=source_material,
            enriched_assets=assets,
            story_id=story_id,
            story_title=story_title,
            task_token=task_token or "",
            vo_clips=vo_clips,
            run_id=run_id,
            folder_id=mimir_folder_id,
            profile_directive=profile["timeline_directive"],
            shot_config=profile["shot"],
            synthesize_voiceover=profile.get("synthesize_voiceover", True),
            timeline_label=profile.get("timeline_suffix", profile["label"]),
        )

        # --- Stage 4: Write script to a new unassigned Saga linear instance ---
        # The script is written to a fresh unassigned linear instance for human
        # review — NOT back into the story's Content or Research fields (those
        # are only read as context). The selected rendered clips are associated
        # so a producer sees the media backing the script.
        #
        # Failure handling is explicit: creating the instance and associating
        # clips are distinct steps. If the instance is created but clip
        # association fails, we surface a partial-failure status rather than
        # silently reporting success.
        try:
            logger.info("Stage 4: Writing script to unassigned Saga linear instance(s)")
            import json as _json
            suffix = profile.get("timeline_suffix", "VO")

            # Build the instance plan: (title, sections). VOSOT splits into two
            # instances so the anchor can start the SOT on their own timing —
            # "<story> - VOSOT VO" (VO + nat sound) and "<story> - VOSOT SOT"
            # (the soundbite(s)). Everything else is a single "<story> - <suffix>"
            # instance. Instances are SCRIPT ONLY — no clips are associated; the
            # media deliverable is the Cutter sequence (timeline), not rendered
            # assets.
            if profile.get("split_vo_sot"):
                plan = [
                    (f"{story_title} - {suffix} VO",
                     _build_script_sections_from_analysis(
                         _sections_subset(script_analysis, _VO_SECTION_TYPES))),
                    (f"{story_title} - {suffix} SOT",
                     _build_script_sections_from_analysis(
                         _sections_subset(script_analysis, _SOT_SECTION_TYPES))),
                ]
            else:
                plan = [(f"{story_title} - {suffix}",
                         _build_script_sections_from_analysis(script_analysis))]

            instances_summary = []
            for title, sections in plan:
                if not sections:
                    logger.info(f"Stage 4: no sections for '{suffix}' instance variant — skipping")
                    continue
                # Idempotent, title-aware find-or-create; re-running the same
                # action updates its own instance and never collides with others.
                res = json.loads(create_or_update_linear_instance(
                    story_id=story_id,
                    script_sections_json=_json.dumps(sections),
                    instance_title=title,
                ))
                instances_summary.append({
                    "instanceId": res.get("instanceId"),
                    "status": res.get("status"),
                    "sectionsWritten": res.get("sectionsWritten"),
                })
                logger.info(
                    f"Stage 4: wrote {len(sections)} script sections to a "
                    f"'{suffix}' instance for story {story_id}"
                )

            _save_artifact(story_id, "05-instances", instances_summary, run_id)
            result.setdefault("summary", {})["instances"] = instances_summary
        except Exception as e:
            logger.warning(f"Stage 4 (Write Script to Linear Instance) failed non-fatally: {e}")
            result.setdefault("summary", {})["instances"] = [{"status": "error", "error": str(e)}]

        return result

    except Exception as e:
        logger.error(f"Error in Rough Cut Agent: {e}")
        # Stages 1/2 send their own SendTaskFailure before re-raising, and
        # Stage 3 handles callbacks internally. This outer handler returns
        # an error dict so the entrypoint always produces a response.
        return {
            "error": str(e),
            "status": "error",
            "agent": "rough-cut-agent",
        }


# Note: no custom @app.ping handler — the BedrockAgentCoreApp default reports
# PingStatus.HEALTHY_BUSY while a task is running and PingStatus.HEALTHY otherwise.
# A custom handler must return a PingStatus enum (not a dict), or the SDK's
# _handle_ping crashes on status.value; the default already does the right thing.


if __name__ == "__main__":
    app.run()
