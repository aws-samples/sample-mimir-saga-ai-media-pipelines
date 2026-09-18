"""Agent tools for the Rough Cut Agent.

Provides tools for interacting with Mimir API, Saga API, Bedrock embeddings,
and S3 Vector Index. Credentials are retrieved from Secrets Manager at module load.
"""

import json
import logging
import os
import re

import boto3
import requests
from strands import tool

logger = logging.getLogger(__name__)

# --- AWS clients ---
_secrets_client = boto3.client("secretsmanager")
_bedrock_client = boto3.client("bedrock-runtime")
_s3vectors_client = boto3.client("s3vectors")

# --- Constants ---
MIMIR_BASE_URL = os.environ.get("MIMIR_API_BASE", "https://us.mjoll.no")
EMBEDDING_MODEL_ID = "amazon.nova-2-multimodal-embeddings-v1:0"
EMBEDDING_DIMENSION = 1024

# Nat sound (B-roll cover audio) is mixed LOW under the voice-over. Ernie's
# editorial spec is ~10% (1/10). Env-overridable via NAT_SOUND_GAIN_DENOMINATOR.
_NAT_GAIN_DEN = int(os.environ.get("NAT_SOUND_GAIN_DENOMINATOR", "10") or "10")
NAT_SOUND_GAIN = (1, _NAT_GAIN_DEN if _NAT_GAIN_DEN > 0 else 10)

# ---------------------------------------------------------------------------
# Text-to-speech sanitization
# ---------------------------------------------------------------------------
# Newsroom scripts embed production cues and slug lines that humans must SEE in
# the SAGA instance but that must NEVER be spoken by the AI voice. Broadcast VO
# is written in ALL CAPS, so we must NOT strip lines merely for being uppercase
# — only known cue tokens, cue labels, and bracketed directions are removed.

# Cue labels that prefix a script line, e.g. "PKG VO: ...". Matched at line
# start and ONLY when followed by a colon, so real words ("LIVE FROM THE
# SCENE...") are never stripped. Longer labels first so they match greedily.
_TTS_CUE_LABELS = sorted([
    "pkg vo", "pkg sot", "pkg nats", "pkg", "vo/sot", "vosot", "vo",
    "sot", "nats", "nat sound", "nat", "anchor q&a", "anchor", "on cam",
    "oncam", "reporter", "stand up", "standup", "live tag", "live", "tag",
    "super", "cg", "font", "wrap", "lead", "toss",
], key=len, reverse=True)
_TTS_LABEL_RE = re.compile(
    r"^\s*(?:" + "|".join(re.escape(l) for l in _TTS_CUE_LABELS) + r")\s*:\s*",
    re.IGNORECASE,
)
# Standalone cue lines (no colon) that are ONLY a cue token, e.g. a line that
# is just "PKG VO" or "STANDUP". Compared against the same vocabulary.
_TTS_CUE_TOKENS = {re.sub(r"[^a-z0-9 ]", "", l).strip() for l in _TTS_CUE_LABELS}
# Bracketed production directions: (( )), [[ ]], [ ], ( ). In broadcast VO these
# are non-spoken directions (e.g. "((nats))", "(NAT POP)", "[SOT full]").
_TTS_BRACKET_RE = re.compile(r"\(\(.*?\)\)|\[\[.*?\]\]|\[.*?\]|\(.*?\)", re.DOTALL)


def sanitize_for_tts(text: str) -> str:
    """Strip newsroom production cues/slugs from *text* before TTS.

    Removes bracketed directions ((( )), [[ ]], [ ], ( )), leading cue labels
    (``PKG VO:``, ``ANCHOR:``, ``SOT:``, ``NATS:`` …), and standalone cue-only
    lines (``PKG VO``, ``STANDUP`` …). Never strips a line just for being
    ALL CAPS (broadcast VO is written that way). This is applied ONLY to the
    text sent to the AI voice — the script written to the SAGA instance keeps
    all cues intact for producers/anchors.

    Returns the cleaned, single-spaced text (may be empty if the input was
    entirely cues).
    """
    if not text:
        return ""
    cleaned = _TTS_BRACKET_RE.sub(" ", text)
    kept = []
    for line in cleaned.splitlines():
        line = _TTS_LABEL_RE.sub("", line)  # drop a leading "LABEL:" prefix
        norm = re.sub(r"[^a-z0-9 ]", " ", line.lower())
        norm = re.sub(r"\s+", " ", norm).strip()
        if not norm:
            continue
        if norm in _TTS_CUE_TOKENS:  # whole line was just a cue token
            continue
        kept.append(line.strip())
    return re.sub(r"\s+", " ", " ".join(kept)).strip()

# --- Module-level credential cache ---
_secret_cache: dict[str, str] = {}


def _get_secret(secret_arn: str) -> str:
    """Retrieve a secret value from Secrets Manager with caching."""
    if secret_arn in _secret_cache:
        return _secret_cache[secret_arn]
    response = _secrets_client.get_secret_value(SecretId=secret_arn)
    _secret_cache[secret_arn] = response["SecretString"]
    return _secret_cache[secret_arn]


def _get_mimir_api_key() -> str:
    return _get_secret(os.environ["MIMIR_API_KEY_SECRET_ARN"])


def _get_saga_api_key() -> str:
    return _get_secret(os.environ["SAGA_API_KEY_SECRET_ARN"])


def _get_saga_api_url() -> str:
    return _get_secret(os.environ["SAGA_API_URL_SECRET_ARN"])


def _mimir_auth_headers() -> dict[str, str]:
    """Return auth headers for Mimir API calls."""
    return {
        "Accept": "application/json",
        "x-mimir-cognito-id-token": f"Bearer {_get_mimir_api_key()}",
    }


def _saga_auth_headers() -> dict[str, str]:
    """Return auth headers for Saga API calls."""
    return {
        "Accept": "application/json",
        "x-api-key": _get_saga_api_key(),
    }


# ---------------------------------------------------------------------------
# Tool 1: get_mimir_item_details
# ---------------------------------------------------------------------------

@tool
def get_mimir_item_details(mimir_item_id: str) -> str:
    """Fetch full item details from the Mimir API for a given item ID.

    Returns item metadata including duration, technical metadata, proxy URL,
    transcript URL, and frame rate.

    Args:
        mimir_item_id: The Mimir item ID to look up.
    """
    url = f"{MIMIR_BASE_URL}/api/v1/items/{mimir_item_id}"
    logger.info(f"Fetching Mimir item details: {mimir_item_id}")

    response = requests.get(url, headers=_mimir_auth_headers(), timeout=30)
    response.raise_for_status()

    return json.dumps(response.json())


# ---------------------------------------------------------------------------
# Tool 2: get_transcript
# ---------------------------------------------------------------------------

@tool
def get_transcript(mimir_item_id: str) -> str:
    """Fetch the word-level timed transcript for a Mimir item.

    First retrieves the item details to get the timedTranscriptUrl,
    then fetches and returns the timed transcript JSON.

    Args:
        mimir_item_id: The Mimir item ID whose transcript to fetch.
    """
    # Step 1: Get item details to find the transcript URL
    item_url = f"{MIMIR_BASE_URL}/api/v1/items/{mimir_item_id}"
    logger.info(f"Fetching item details for transcript: {mimir_item_id}")

    item_response = requests.get(item_url, headers=_mimir_auth_headers(), timeout=30)
    item_response.raise_for_status()
    item = item_response.json()

    transcript_url = item.get("timedTranscriptUrl")
    if not transcript_url:
        return json.dumps({"error": f"No timedTranscriptUrl found for item {mimir_item_id}"})

    # Step 2: Fetch the timed transcript
    logger.info(f"Fetching timed transcript from: {transcript_url}")
    transcript_response = requests.get(
        transcript_url, headers=_mimir_auth_headers(), timeout=60
    )
    transcript_response.raise_for_status()

    return json.dumps(transcript_response.json())



# ---------------------------------------------------------------------------
# Tool 3: query_embeddings
# ---------------------------------------------------------------------------

@tool
def query_embeddings(text: str, top_k: int = 10, item_ids: list[str] = None) -> str:
    """Search the S3 Vector Index for video segments semantically similar to the given text.

    Generates a text embedding via the Bedrock Nova model, then queries the
    S3 Vector Index. Returns results with segment timing metadata
    (startTimeSeconds, endTimeSeconds).

    Args:
        text: The search text to embed and query against the vector index.
        top_k: Maximum number of results to return (default 10).
        item_ids: Optional list of Mimir item IDs to restrict search to. If provided, only segments from these items are returned.
    """
    vector_bucket = os.environ["VECTOR_BUCKET_NAME"]
    index_name = os.environ["VECTOR_INDEX_NAME"]

    # Step 1: Generate text embedding via Bedrock
    logger.info(f"Generating embedding for query text (top_k={top_k})")
    embed_response = _bedrock_client.invoke_model(
        modelId=EMBEDDING_MODEL_ID,
        contentType="application/json",
        accept="application/json",
        body=json.dumps({
            "taskType": "SINGLE_EMBEDDING",
            "singleEmbeddingParams": {
                "embeddingPurpose": "VIDEO_RETRIEVAL",
                "embeddingDimension": EMBEDDING_DIMENSION,
                "text": {
                    "truncationMode": "END",
                    "value": text,
                },
            },
        }),
    )
    embed_body = json.loads(embed_response["body"].read())
    query_vector = embed_body["embeddings"][0]["embedding"]

    # Step 2: Query S3 Vector Index
    logger.info(f"Querying vector index: {index_name}")
    query_params = {
        "vectorBucketName": vector_bucket,
        "indexName": index_name,
        "queryVector": {"float32": query_vector},
        "topK": top_k,
        "returnMetadata": True,
        "returnDistance": True,
    }

    # Filter to specific items if provided
    if item_ids:
        query_params["filter"] = {"itemId": {"$in": item_ids}}

    query_response = _s3vectors_client.query_vectors(**query_params)

    # Step 3: Format results with timing metadata
    results = []
    for vector in query_response.get("vectors", []):
        metadata = vector.get("metadata", {})
        results.append({
            "key": vector.get("key"),
            "distance": vector.get("distance"),
            "itemId": metadata.get("itemId"),
            "segmentIndex": metadata.get("segmentIndex"),
            "startTimeSeconds": metadata.get("startTimeSeconds"),
            "endTimeSeconds": metadata.get("endTimeSeconds"),
        })

    return json.dumps(results)



# ---------------------------------------------------------------------------
# Tool 4: create_timeline
# ---------------------------------------------------------------------------

def _build_legacy_timeline_payload(sequence_details, item_details_cache):
    """Build Cutter payload for legacy 3-track format (1 video + 2 audio).

    This is the original behavior: flatten all video track clips into a single
    videoTracks array with mirrored audio on ch0/ch1.

    Returns:
        Tuple of (item_refs, source_refs, timeline_payload_body, clip_count).
    """
    item_refs = {}
    source_refs = {}
    video_track_clips = []
    audio_track_ch0 = []
    audio_track_ch1 = []

    src_counter = 0
    box_counter = 0
    timeline_position_ms = 0

    all_clips = []
    for track in sequence_details.get("tracks", []):
        if track.get("mediaType") == "video":
            for clip in track.get("clips", []):
                all_clips.append(clip)

    all_clips.sort(key=lambda c: c.get("start", 0))

    for clip in all_clips:
        mimir_id = clip["mimirItemId"]
        in_point_ms = clip.get("inPoint", 0)
        out_point_ms = clip.get("outPoint", in_point_ms + clip.get("duration", 5000))

        if mimir_id not in item_refs:
            duration_s = item_details_cache.get(mimir_id, 60)
            item_refs[mimir_id] = {
                "type": "video",
                "nAudioChannels": 2,
                "durationInSeconds": {"numerator": int(duration_s * 1000), "denominator": 1000},
                "frameDurationInSeconds": {"numerator": 1001, "denominator": 30000},
                "hasIndexFile": False,
            }

        src_id = f"id-{src_counter}"
        in_point_s = in_point_ms / 1000.0
        out_point_s = out_point_ms / 1000.0
        timeline_pos_s = timeline_position_ms / 1000.0
        offset_s = timeline_pos_s - in_point_s

        source_refs[src_id] = {
            "type": "video-with-audio",
            "itemId": mimir_id,
            "mediaStartOffset": {"numerator": int(offset_s * 1000), "denominator": 1000},
            "videoInPointInSeconds": {"numerator": int(in_point_s * 1000), "denominator": 1000},
            "videoOutPointInSeconds": {"numerator": int(out_point_s * 1000), "denominator": 1000},
            "audioInPoint": {"type": "follow-video"},
            "audioOutPoint": {"type": "follow-video"},
        }

        video_track_clips.append({
            "type": "video", "srcId": src_id, "boxId": f"box-v{box_counter}",
            "positionControlPoints": {"type": "docked", "controlPoints": []},
            "padBackground": {"type": "color", "color": {"r": 0, "g": 0, "b": 0, "a": 1}},
            "name": None, "effects": [],
        })

        audio_track_ch0.append({
            "type": "audio", "srcId": src_id, "boxId": f"box-a{box_counter}",
            "channel": 0, "gainMultiplier": {"numerator": 1, "denominator": 1},
            "controlPoints": [], "name": None,
        })
        audio_track_ch1.append({
            "type": "audio", "srcId": src_id, "boxId": f"box-b{box_counter}",
            "channel": 1, "gainMultiplier": {"numerator": 1, "denominator": 1},
            "controlPoints": [], "name": None,
        })

        clip_duration_ms = out_point_ms - in_point_ms
        timeline_position_ms += clip_duration_ms
        src_counter += 1
        box_counter += 1

    payload_body = {
        "version": "v8",
        "nextUiId": box_counter * 3 + 1,
        "itemRefs": item_refs,
        "sourceRefs": source_refs,
        "videoTracks": [video_track_clips],
        "audioTracks": [
            audio_track_ch0, audio_track_ch1,
            [], [], [], [], [], [], [], [], [], [], [], [], [], [],
        ],
        "transitions": [],
        "muted": [],
    }

    return item_refs, source_refs, payload_body, len(all_clips)


def _build_multitrack_timeline_payload(sequence_details, item_details_cache):
    """Build Cutter payload for 4-track format (V1, V2, A1, A2).

    Tracks are identified by id:
      V1 (id:1) — A-roll / interview video
      V2 (id:2) — B-roll / cover footage
      A1 (id:3) — Voice-over narration audio
      A2 (id:4) — Interview / nats audio (ignored — audio derived from V1/V2)

    Audio track layout in Cutter:
      audioTracks[0] — V1 audio channel 0
      audioTracks[1] — V1 audio channel 1
      audioTracks[2] — V2 audio channel 0
      audioTracks[3] — V2 audio channel 1
      audioTracks[4] — Voice-over (A1) audio
      audioTracks[5..15] — empty

    Each video clip's audio channels are placed on consecutive audio track
    slots dedicated to that video track, so overlapping V1/V2 clips don't
    clobber each other's audio.

    Supports audio-only source references for Polly-generated clips.

    Returns:
        Tuple of (item_refs, source_refs, timeline_payload_body, clip_count).
    """
    item_refs = {}
    source_refs = {}

    # Separate Cutter track arrays
    v1_track_clips = []   # videoTracks[0]
    v2_track_clips = []   # videoTracks[1]
    v1_audio_ch0 = []     # audioTracks[0] — V1 channel 0
    v1_audio_ch1 = []     # audioTracks[1] — V1 channel 1
    v2_audio_ch0 = []     # audioTracks[2] — V2 channel 0
    v2_audio_ch1 = []     # audioTracks[3] — V2 channel 1
    vo_track_clips = []   # audioTracks[4] — voice-over

    src_counter = 0
    box_counter = 0
    total_clip_count = 0

    # Index tracks by id for lookup
    tracks_by_id = {}
    for track in sequence_details.get("tracks", []):
        track_id = track.get("id")
        if track_id is not None:
            tracks_by_id[track_id] = track

    # --- Process V1 (A-roll, id:1) ---
    v1_track = tracks_by_id.get(1, {})
    v1_clips = sorted(v1_track.get("clips", []), key=lambda c: c.get("start", 0))

    for clip in v1_clips:
        mimir_id = clip["mimirItemId"]
        in_point_ms = clip.get("inPoint", 0)
        out_point_ms = clip.get("outPoint", in_point_ms + clip.get("duration", 5000))
        start_ms = clip.get("start", 0)
        end_ms = clip.get("end", start_ms + clip.get("duration", 5000))

        # Clamp outPoint to match timeline slot duration
        timeline_dur_ms = end_ms - start_ms
        out_point_ms = min(out_point_ms, in_point_ms + timeline_dur_ms)

        # Register video item ref
        if mimir_id not in item_refs:
            duration_s = item_details_cache.get(mimir_id, 60)
            item_refs[mimir_id] = {
                "type": "video",
                "nAudioChannels": 2,
                "durationInSeconds": {"numerator": int(duration_s * 1000), "denominator": 1000},
                "frameDurationInSeconds": {"numerator": 1001, "denominator": 30000},
                "hasIndexFile": False,
            }

        src_id = f"id-{src_counter}"
        in_point_s = in_point_ms / 1000.0
        out_point_s = out_point_ms / 1000.0
        start_s = start_ms / 1000.0
        offset_s = start_s - in_point_s

        source_refs[src_id] = {
            "type": "video-with-audio",
            "itemId": mimir_id,
            "mediaStartOffset": {"numerator": int(offset_s * 1000), "denominator": 1000},
            "videoInPointInSeconds": {"numerator": int(in_point_s * 1000), "denominator": 1000},
            "videoOutPointInSeconds": {"numerator": int(out_point_s * 1000), "denominator": 1000},
            "audioInPoint": {"type": "follow-video"},
            "audioOutPoint": {"type": "follow-video"},
        }

        v1_track_clips.append({
            "type": "video", "srcId": src_id, "boxId": f"box-v{box_counter}",
            "positionControlPoints": {"type": "docked", "controlPoints": []},
            "padBackground": {"type": "color", "color": {"r": 0, "g": 0, "b": 0, "a": 1}},
            "name": None, "effects": [],
        })
        box_counter += 1

        # Emit audio clips for each channel on V1's dedicated audio tracks.
        # SOT/interview clips play at full gain. B-roll cover clips (filling
        # the VO-led spans that keep V1 gapless) play at NAT_SOUND_GAIN (~10%) —
        # nat sound under the voice-over, matching the V2 B-roll audio convention.
        gain = NAT_SOUND_GAIN if clip.get("brollCover") else (1, 1)
        n_channels = item_refs[mimir_id].get("nAudioChannels", 2)
        for ch in range(n_channels):
            ch_list = v1_audio_ch0 if ch == 0 else v1_audio_ch1
            ch_list.append({
                "type": "audio", "srcId": src_id, "boxId": f"box-a{box_counter}",
                "channel": ch, "gainMultiplier": {"numerator": gain[0], "denominator": gain[1]},
                "controlPoints": [], "name": None,
            })
            box_counter += 1

        src_counter += 1
        total_clip_count += 1

    # --- Process V2 (B-roll, id:2) ---
    v2_track = tracks_by_id.get(2, {})
    v2_clips = sorted(v2_track.get("clips", []), key=lambda c: c.get("start", 0))

    for clip in v2_clips:
        mimir_id = clip["mimirItemId"]
        in_point_ms = clip.get("inPoint", 0)
        out_point_ms = clip.get("outPoint", in_point_ms + clip.get("duration", 5000))
        start_ms = clip.get("start", 0)
        end_ms = clip.get("end", start_ms + clip.get("duration", 5000))

        # Clamp outPoint to match timeline slot duration
        timeline_dur_ms = end_ms - start_ms
        out_point_ms = min(out_point_ms, in_point_ms + timeline_dur_ms)

        if mimir_id not in item_refs:
            duration_s = item_details_cache.get(mimir_id, 60)
            item_refs[mimir_id] = {
                "type": "video",
                "nAudioChannels": 2,
                "durationInSeconds": {"numerator": int(duration_s * 1000), "denominator": 1000},
                "frameDurationInSeconds": {"numerator": 1001, "denominator": 30000},
                "hasIndexFile": False,
            }

        src_id = f"id-{src_counter}"
        in_point_s = in_point_ms / 1000.0
        out_point_s = out_point_ms / 1000.0
        start_s = start_ms / 1000.0
        offset_s = start_s - in_point_s

        source_refs[src_id] = {
            "type": "video-with-audio",
            "itemId": mimir_id,
            "mediaStartOffset": {"numerator": int(offset_s * 1000), "denominator": 1000},
            "videoInPointInSeconds": {"numerator": int(in_point_s * 1000), "denominator": 1000},
            "videoOutPointInSeconds": {"numerator": int(out_point_s * 1000), "denominator": 1000},
            "audioInPoint": {"type": "follow-video"},
            "audioOutPoint": {"type": "follow-video"},
        }

        v2_track_clips.append({
            "type": "video", "srcId": src_id, "boxId": f"box-v{box_counter}",
            "positionControlPoints": {"type": "docked", "controlPoints": []},
            "padBackground": {"type": "color", "color": {"r": 0, "g": 0, "b": 0, "a": 1}},
            "name": None, "effects": [],
        })
        box_counter += 1

        # Emit audio clips for each channel on V2's dedicated audio tracks
        n_channels = item_refs[mimir_id].get("nAudioChannels", 2)
        for ch in range(n_channels):
            ch_list = v2_audio_ch0 if ch == 0 else v2_audio_ch1
            ch_list.append({
                "type": "audio", "srcId": src_id, "boxId": f"box-a{box_counter}",
                "channel": ch,
                "gainMultiplier": {"numerator": NAT_SOUND_GAIN[0], "denominator": NAT_SOUND_GAIN[1]},
                "controlPoints": [], "name": None,
            })
            box_counter += 1

        src_counter += 1
        total_clip_count += 1

    # --- Process A1 (voice-over, id:3) ---
    a1_track = tracks_by_id.get(3, {})
    a1_clips = sorted(a1_track.get("clips", []), key=lambda c: c.get("start", 0))

    for clip in a1_clips:
        mimir_id = clip["mimirItemId"]
        in_point_ms = clip.get("inPoint", 0)
        out_point_ms = clip.get("outPoint", in_point_ms + clip.get("duration", 5000))
        start_ms = clip.get("start", 0)
        source_type = clip.get("sourceType", "video-with-audio")

        if source_type == "audio-only":
            # Audio items uploaded to Mimir
            if mimir_id not in item_refs:
                duration_ms = clip.get("duration", out_point_ms - in_point_ms)
                item_refs[mimir_id] = {
                    "type": "audio",
                    "nAudioChannels": 1,
                    "durationInSeconds": {"numerator": int(duration_ms), "denominator": 1000},
                }

            src_id = f"id-{src_counter}"
            in_point_s = in_point_ms / 1000.0
            out_point_s = out_point_ms / 1000.0
            start_s = start_ms / 1000.0
            offset_s = start_s - in_point_s

            source_refs[src_id] = {
                "type": "audio",
                "itemId": mimir_id,
                "mediaStartOffset": {"numerator": int(offset_s * 1000), "denominator": 1000},
                "audioInPointInSeconds": {"numerator": int(in_point_s * 1000), "denominator": 1000},
                "audioOutPointInSeconds": {"numerator": int(out_point_s * 1000), "denominator": 1000},
            }
        else:
            # Video-with-audio source (reporter-provided VO from a video asset)
            if mimir_id not in item_refs:
                duration_s = item_details_cache.get(mimir_id, 60)
                item_refs[mimir_id] = {
                    "type": "video",
                    "nAudioChannels": 2,
                    "durationInSeconds": {"numerator": int(duration_s * 1000), "denominator": 1000},
                    "frameDurationInSeconds": {"numerator": 1001, "denominator": 30000},
                    "hasIndexFile": False,
                }

            src_id = f"id-{src_counter}"
            in_point_s = in_point_ms / 1000.0
            out_point_s = out_point_ms / 1000.0
            start_s = start_ms / 1000.0
            offset_s = start_s - in_point_s

            source_refs[src_id] = {
                "type": "video-with-audio",
                "itemId": mimir_id,
                "mediaStartOffset": {"numerator": int(offset_s * 1000), "denominator": 1000},
                "videoInPointInSeconds": {"numerator": int(in_point_s * 1000), "denominator": 1000},
                "videoOutPointInSeconds": {"numerator": int(out_point_s * 1000), "denominator": 1000},
                "audioInPoint": {"type": "follow-video"},
                "audioOutPoint": {"type": "follow-video"},
            }

        vo_track_clips.append({
            "type": "audio", "srcId": src_id, "boxId": f"box-a{box_counter}",
            "channel": 0, "gainMultiplier": {"numerator": 1, "denominator": 1},
            "controlPoints": [], "name": None,
        })

        src_counter += 1
        box_counter += 1
        total_clip_count += 1

    # --- Process A2 (interview/nats, id:4) ---
    # For multi-channel video sources, each audio channel gets its own
    # A2 track from the agent is ignored — audio is derived from V1/V2 clips above.
    # Each video track's audio channels are already placed on dedicated audio track slots.

    # Build audioTracks:
    #   [0] V1 audio ch0
    #   [1] V1 audio ch1
    #   [2] V2 audio ch0
    #   [3] V2 audio ch1
    #   [4] Voice-over (A1)
    #   [5..15] empty
    audio_tracks = [v1_audio_ch0, v1_audio_ch1, v2_audio_ch0, v2_audio_ch1, vo_track_clips]
    audio_tracks.extend([] for _ in range(11))

    payload_body = {
        "version": "v8",
        "nextUiId": box_counter * 3 + 1,
        "itemRefs": item_refs,
        "sourceRefs": source_refs,
        "videoTracks": [v1_track_clips, v2_track_clips],
        "audioTracks": audio_tracks,
        "transitions": [],
        "muted": [],
    }

    return item_refs, source_refs, payload_body, total_clip_count


@tool
def create_timeline(
    title: str, sequence_details_json: str, parent_item_ids: list[str], folder_id: str = None
) -> str:
    """Create a new Mimir timeline item with clips in Cutter format.

    Creates a timeline item in Mimir and populates it using the Cutter
    timeline API so clips are editable in Mimir Cutter.

    Supports two input formats:
    - Legacy 3-track (1 video + 2 audio): uses original single-videoTrack behavior
    - Multi-track 4+ tracks with ids 1-4 (V1, V2, A1, A2): builds separate
      videoTracks for V1/V2 and places audio on A1/A2 audioTracks slots,
      with support for audio-only source references (Polly VO clips)

    Args:
        title: The title for the new timeline item.
        sequence_details_json: JSON string of the sequenceDetails object with tracks and clips.
        parent_item_ids: List of parent Mimir item IDs to associate with the timeline.
    """
    logger.info(f"Creating timeline item: {title}")

    sequence_details = json.loads(sequence_details_json)

    # Step 1: Create the timeline item
    create_url = f"{MIMIR_BASE_URL}/api/v1/items"
    create_payload = {
        "title": title,
        "itemType": "timeline",
        "parentItemIds": parent_item_ids,
    }
    if folder_id:
        create_payload["folderParents"] = [folder_id]

    headers = _mimir_auth_headers()
    headers["Content-Type"] = "application/json"

    response = requests.post(create_url, headers=headers, json=create_payload, timeout=30)
    response.raise_for_status()
    item_data = response.json()
    item_id = item_data["id"]
    logger.info(f"Created timeline item: {item_id}")

    # Step 2: Get source item details for Cutter itemRefs
    item_details_cache = {}
    for pid in parent_item_ids:
        try:
            resp = requests.get(
                f"{MIMIR_BASE_URL}/api/v1/items/{pid}",
                headers=_mimir_auth_headers(), timeout=30
            )
            resp.raise_for_status()
            details = resp.json()
            duration = details.get("duration", 60)
            item_details_cache[pid] = duration
        except Exception:
            item_details_cache[pid] = 60  # default 60s

    # Step 3: Determine format and build Cutter payload
    tracks = sequence_details.get("tracks", [])
    use_multitrack = len(tracks) >= 4

    if use_multitrack:
        _, _, payload_body, clip_count = _build_multitrack_timeline_payload(
            sequence_details, item_details_cache
        )
    else:
        _, _, payload_body, clip_count = _build_legacy_timeline_payload(
            sequence_details, item_details_cache
        )

    timeline_payload = {
        "timeline": payload_body,
        "timelineVersion": 0,
    }

    # Step 4: PUT to Cutter timeline API
    timeline_url = f"{MIMIR_BASE_URL}/prime/api/v1/timelines/{item_id}"
    timeline_resp = requests.put(
        timeline_url, headers=headers, json=timeline_payload, timeout=30
    )
    timeline_resp.raise_for_status()
    logger.info(f"Cutter timeline populated with {clip_count} clips")

    return json.dumps(item_data)


# ---------------------------------------------------------------------------
# Tool 5: update_story_status
# ---------------------------------------------------------------------------

@tool
def update_story_status(story_id: str, timeline_item_id: str) -> str:
    """Update a Saga story with a reference to the generated timeline item.

    Patches the story metadata on the Saga API to indicate the rough cut
    timeline is available.

    Args:
        story_id: The Saga story ID to update.
        timeline_item_id: The Mimir item ID of the generated timeline.
    """
    saga_url = _get_saga_api_url()
    url = f"{saga_url}/stories/{story_id}"
    logger.info(f"Updating story {story_id} with timeline {timeline_item_id}")

    payload = {
        "timelineItemId": timeline_item_id,
    }

    headers = _saga_auth_headers()
    headers["Content-Type"] = "application/json"

    response = requests.patch(url, headers=headers, json=payload, timeout=30)
    response.raise_for_status()

    return json.dumps(response.json())


# ---------------------------------------------------------------------------
# Tool 6: get_generated_transcript
# ---------------------------------------------------------------------------

@tool
def get_generated_transcript(mimir_item_id: str) -> str:
    """Read a generated transcript from S3 for a given Mimir item ID.

    Reads the word-level timed transcript JSON from the staging bucket
    at transcripts/{itemId}/transcript.json. Returns sentence-level timing
    (text, startTime, endTime) without individual word arrays to keep
    the response compact.

    Args:
        mimir_item_id: The Mimir item ID whose generated transcript to fetch.
    """
    bucket = os.environ.get("TRANSCRIPT_STAGING_BUCKET")
    if not bucket:
        return json.dumps({"error": "TRANSCRIPT_STAGING_BUCKET environment variable is not set"})

    key = f"transcripts/{mimir_item_id}/transcript.json"
    logger.info(f"Fetching generated transcript: s3://{bucket}/{key}")

    s3_client = boto3.client("s3")
    try:
        response = s3_client.get_object(Bucket=bucket, Key=key)
        content = response["Body"].read().decode("utf-8")
        # Strip word arrays to reduce token usage — agent only needs sentence timing
        transcript = json.loads(content)
        compact = {
            "fullTranscript": transcript.get("fullTranscript", ""),
            "sentences": [
                {
                    "text": s["text"],
                    "startTime": s["startTime"],
                    "endTime": s["endTime"],
                }
                for s in transcript.get("sentences", [])
            ],
        }
        return json.dumps(compact)
    except s3_client.exceptions.NoSuchKey:
        return json.dumps({"error": f"No generated transcript found for item {mimir_item_id}"})


# ---------------------------------------------------------------------------
# Tool 7: get_word_timing
# ---------------------------------------------------------------------------

@tool
def get_word_timing(mimir_item_id: str, start_time: float, end_time: float) -> str:
    """Get word-level timing for a specific time range within a generated transcript.

    Use this when you need precise word-level in/out points for a specific
    segment. Returns only the words that fall within the given time range,
    keeping the response small.

    Args:
        mimir_item_id: The Mimir item ID whose transcript to query.
        start_time: Start of the time range in seconds.
        end_time: End of the time range in seconds.
    """
    bucket = os.environ.get("TRANSCRIPT_STAGING_BUCKET")
    if not bucket:
        return json.dumps({"error": "TRANSCRIPT_STAGING_BUCKET environment variable is not set"})

    key = f"transcripts/{mimir_item_id}/transcript.json"
    logger.info(f"Fetching word timing for {mimir_item_id} [{start_time}-{end_time}s]")

    s3_client = boto3.client("s3")
    try:
        response = s3_client.get_object(Bucket=bucket, Key=key)
        content = response["Body"].read().decode("utf-8")
        transcript = json.loads(content)

        # Find sentences that overlap with the time range
        matching_words = []
        for sentence in transcript.get("sentences", []):
            if sentence["endTime"] < start_time or sentence["startTime"] > end_time:
                continue
            for word in sentence.get("words", []):
                if word["endTime"] >= start_time and word["startTime"] <= end_time:
                    matching_words.append(word)

        return json.dumps({"words": matching_words, "itemId": mimir_item_id})
    except s3_client.exceptions.NoSuchKey:
        return json.dumps({"error": f"No generated transcript found for item {mimir_item_id}"})


# ---------------------------------------------------------------------------
# Tool 8: generate_voiceover
# ---------------------------------------------------------------------------

@tool
def generate_voiceover(text: str, story_id: str, section_index: int) -> str:
    """Synthesize voice-over audio from text using Amazon Polly.

    Calls Polly SynthesizeSpeech with neural engine, mp3 output,
    and configurable voice ID. Stores the result in S3 at
    voiceover/{story_id}/{section_index}.mp3.

    Args:
        text: The narration text to synthesize.
        story_id: The story ID for S3 key organization.
        section_index: The section index for S3 key organization.

    Returns:
        JSON with s3Uri, durationMs, and sectionIndex.
    """
    voice_id = os.environ.get("POLLY_VOICE_ID", "Matthew")
    bucket = os.environ.get("TRANSCRIPT_STAGING_BUCKET")

    if not bucket:
        logger.error("TRANSCRIPT_STAGING_BUCKET environment variable is not set")
        return json.dumps({"error": "TRANSCRIPT_STAGING_BUCKET not configured", "sectionIndex": section_index})

    # Strip newsroom production cues so the AI voice never speaks them.
    spoken_text = sanitize_for_tts(text)
    if not spoken_text:
        logger.warning(f"Section {section_index} was entirely cues — nothing to synthesize")
        return json.dumps({"error": "No speakable text after cue sanitization", "sectionIndex": section_index})

    s3_key = f"voiceover/{story_id}/{section_index}.mp3"
    logger.info(f"Generating voiceover for story {story_id}, section {section_index} with voice {voice_id}")

    try:
        polly_client = boto3.client("polly")
        response = polly_client.synthesize_speech(
            Text=spoken_text,
            OutputFormat="mp3",
            Engine="neural",
            VoiceId=voice_id,
        )

        audio_bytes = response["AudioStream"].read()

        # Store audio in S3
        s3_client = boto3.client("s3")
        s3_client.put_object(
            Bucket=bucket,
            Key=s3_key,
            Body=audio_bytes,
            ContentType="audio/mpeg",
        )

        # Estimate duration: Polly neural mp3 is ~48kbps → 48000 bits/s → 6000 bytes/s
        duration_ms = len(audio_bytes) / (48000 / 8) * 1000
        s3_uri = f"s3://{bucket}/{s3_key}"

        logger.info(f"Voiceover stored at {s3_uri}, estimated duration {duration_ms:.0f}ms")

        return json.dumps({
            "s3Uri": s3_uri,
            "durationMs": round(duration_ms),
            "sectionIndex": section_index,
        })

    except Exception as e:
        logger.error(f"Polly voiceover generation failed for section {section_index}: {e}")
        return json.dumps({"error": str(e), "sectionIndex": section_index})


# ---------------------------------------------------------------------------
# Tool 9: upload_voiceover_to_mimir
# ---------------------------------------------------------------------------

@tool
def upload_voiceover_to_mimir(
    s3_uri: str, story_title: str, section_index: int, parent_item_ids: list[str]
) -> str:
    """Create a Mimir audio item for a synthesized voice-over file.

    Creates an audio item in Mimir with the title
    "{storyTitle} - VO {sectionIndex}" and associates it as a child
    of the specified parent items.

    Args:
        s3_uri: The S3 URI of the voice-over audio file.
        story_title: The story title for naming the Mimir item.
        section_index: The section index for naming.
        parent_item_ids: List of parent Mimir item IDs.

    Returns:
        JSON with the created Mimir item ID and title.
    """
    item_title = f"{story_title} - VO {section_index}"
    logger.info(f"Creating Mimir audio item: {item_title}")

    try:
        url = f"{MIMIR_BASE_URL}/api/v1/items"
        headers = _mimir_auth_headers()
        headers["Content-Type"] = "application/json"

        payload = {
            "title": item_title,
            "itemType": "audio",
            "parentItemIds": parent_item_ids,
        }

        response = requests.post(url, headers=headers, json=payload, timeout=30)
        response.raise_for_status()
        item_data = response.json()

        mimir_item_id = item_data["id"]
        logger.info(f"Created Mimir audio item: {mimir_item_id}")

        return json.dumps({
            "mimirItemId": mimir_item_id,
            "title": item_title,
        })

    except Exception as e:
        logger.error(f"Failed to create Mimir audio item for VO section {section_index}: {e}")
        return json.dumps({"error": str(e)})

# ---------------------------------------------------------------------------
# Tool 10: create_or_update_linear_instance
# ---------------------------------------------------------------------------

def _build_linear_instance_slate(script_sections: list) -> dict:
    """Build a Slate document for a linear instance from structured script sections.

    Each section is a dict with:
      - ``type``: ``"vo"`` (white ALL CAPS) or ``"pkg"`` (green text)
      - ``label``: Optional label string (e.g. "ANCHOR:", "PKG VO:")
      - ``text``: The script text for this section

    VO text (anchor/talent reads) → white (#ffffff), ALL CAPS
    Package script text → green (#00ff00)

    Returns a Slate document dict compatible with Saga LinearInstancesContent.
    """
    blocks = []

    for section in script_sections:
        section_type = section.get("type", "vo")
        label = section.get("label", "")
        text = section.get("text", "").strip()

        if not text:
            continue

        if section_type == "vo":
            # VO text: white, ALL CAPS
            display_text = text.upper()
            color = "#ffffff"
        else:
            # Package script: green. Saga only accepts a fixed enum of text
            # colors — use its green (#74db63); #00ff00 is rejected with a 400.
            display_text = text
            color = "#74db63"

        # Build children array — label in bold if present, then text
        children = []
        if label:
            children.append({
                "text": f"{label} ",
                "bold": True,
                "color": color,
            })
        children.append({
            "text": display_text,
            "color": color,
        })

        blocks.append({
            "type": "paragraph",
            "children": children,
        })

        # Add an empty spacer paragraph between sections
        blocks.append({
            "type": "paragraph",
            "children": [{"text": ""}],
        })

    # Remove trailing spacer
    if blocks and blocks[-1] == {"type": "paragraph", "children": [{"text": ""}]}:
        blocks.pop()

    return {"document": blocks}


@tool
def create_or_update_linear_instance(story_id: str, script_sections_json: str,
                                     instance_title: str = None) -> str:
    """Create or update an unassigned linear instance for a Saga story with the generated script.

    IDEMPOTENT per action: when ``instance_title`` is given (e.g.
    "<story> - VO"), we reuse ONLY an existing unassigned org-scoped linear
    instance with that exact title and update it in place — so re-running the
    same action updates its own instance rather than creating a duplicate, and
    different actions (VO / AI VO / VOSOT / Package) never collide because each
    owns a distinctly-titled instance. If no matching instance exists, one is
    created with that title. When ``instance_title`` is omitted, the legacy
    behavior applies (reuse the first unassigned org-scoped linear instance).

    Then updates the instance content with the formatted script in Slate format.
    Instances are SCRIPT ONLY — no clips/rendered media are associated. The media
    deliverable is the Cutter sequence (timeline) created separately; a human
    approves it before air, so nothing is attached to the instance.

    VO text (anchor/talent reads) is written as white text in ALL CAPS.
    Package script text is written in green.

    Args:
        story_id: The Saga story ID.
        script_sections_json: JSON array of script section objects, each with:
            - type: "vo" (white ALL CAPS) or "pkg" (green)
            - label: Optional label (e.g. "ANCHOR:", "PKG VO:")
            - text: The script text for this section
        instance_title: Optional exact title for the instance (e.g.
            "<story> - VO"). Drives idempotent, per-action find-or-create.

    Returns:
        JSON string with ``instanceId``, ``sectionsWritten``, ``created``,
        and ``status`` ("success" | error).
    """
    saga_url = _get_saga_api_url()
    headers = _saga_auth_headers()
    headers["Content-Type"] = "application/json"

    script_sections = json.loads(script_sections_json)

    logger.info(
        f"create_or_update_linear_instance: story={story_id}, "
        f"sections={len(script_sections)}"
    )

    # Build the Slate document once — reused for both create and update paths.
    slate_doc = _build_linear_instance_slate(script_sections)

    # Step 1: Get existing instances for the story
    instances_url = f"{saga_url}/stories/{story_id}/instances"
    resp = requests.get(instances_url, headers=_saga_auth_headers(), timeout=30)
    resp.raise_for_status()
    instances_data = resp.json()
    instances = instances_data.get("instances", instances_data if isinstance(instances_data, list) else [])

    # Step 2: Find an existing UNASSIGNED, ORG-SCOPED linear instance.
    # Real Saga API shape (verified against live API):
    #   - platform is on platformInfo.platform (or platformType), NOT instanceType
    #   - "unassigned" == platformInfo.account.accountId is null / empty
    #     (an assigned instance has a rundown accountId + accountTitle)
    #   - org-scoped instances have ids shaped "<orgId>-INS-...". Bare instances
    #     ("INS-...") were created by a tenant-scoped key and are INVISIBLE in the
    #     org's Instances pane. We must NOT reuse a bare instance — otherwise the
    #     script write lands on a hidden instance. By requiring an org-scoped id
    #     here, we fall through to CREATE a fresh org-scoped instance instead.
    def _is_org_scoped(inst_id):
        return isinstance(inst_id, str) and "-INS-" in inst_id

    # Title-aware matching makes re-runs idempotent PER ACTION: with a title we
    # reuse only the instance carrying that exact title (case-insensitive), and
    # skip other unassigned instances so distinct actions never clobber each
    # other. Without a title, fall back to the first unassigned org-scoped one.
    want_title = (instance_title or "").strip().lower()
    target_instance_id = None
    for inst in instances:
        platform = (
            (inst.get("platformInfo") or {}).get("platform")
            or inst.get("platformType")
            or ""
        ).lower()
        account = (inst.get("platformInfo") or {}).get("account") or {}
        is_unassigned = not account.get("accountId")
        inst_id = inst.get("id") or inst.get("mId")
        inst_title = (inst.get("title") or inst.get("mTitle") or "").strip().lower()
        if not (platform == "linear" and is_unassigned and _is_org_scoped(inst_id)):
            continue
        if want_title and inst_title != want_title:
            # A different action's instance — leave it untouched.
            continue
        target_instance_id = inst_id
        # Log the (untrusted, non-secret) story id for correlation rather than
        # the instance id, which is derived from a Saga API response reached via
        # a Secrets-Manager-sourced URL (CodeQL treats response-derived values
        # as secret-tainted).
        logger.info(
            f"Reusing existing unassigned linear instance"
            f"{' titled ' + repr(instance_title) if want_title else ''} "
            f"for story {story_id} (idempotent re-run)"
        )
        break

    if target_instance_id:
        # Step 3a: Update the existing instance's content via PATCH.
        patch_url = f"{saga_url}/instances/{target_instance_id}"
        patch_resp = requests.patch(
            patch_url, headers=headers, json={"content": slate_doc}, timeout=30
        )
        patch_resp.raise_for_status()
        was_created = False
        logger.info(
            f"Updated existing unassigned linear instance for story {story_id} with "
            f"{len(script_sections)} script sections"
        )
    else:
        # Step 3b: No unassigned linear instance — create one WITH the script
        # content in a single POST. The Saga create endpoint accepts inline
        # content, so no follow-up PATCH is needed. The instance inherits the org
        # of the API key, so an org-scoped key produces an org-stamped instance
        # visible in that org's Instances pane. It is left UNASSIGNED and
        # unscheduled (state "todo") for human review.
        logger.info("No unassigned linear instance found — creating one with script content")
        story_title = ""
        try:
            story_resp = requests.get(
                f"{saga_url}/stories/{story_id}", headers=_saga_auth_headers(), timeout=30
            )
            if story_resp.ok:
                story_json = story_resp.json()
                story_title = story_json.get("mTitle") or story_json.get("title") or ""
        except Exception as e:
            logger.warning(f"Could not fetch story title for instance: {type(e).__name__}")

        create_url = f"{saga_url}/stories/{story_id}/instances"
        create_payload = {
            "title": instance_title or story_title or "Rough Cut",
            "state": "todo",
            "platformInfo": {
                "platform": "linear",
                "account": {"accountId": None, "accountTitle": "Unassigned"},
            },
            "content": slate_doc,
        }
        create_resp = requests.post(
            create_url, headers=headers, json=create_payload, timeout=30
        )
        create_resp.raise_for_status()
        created_json = create_resp.json()
        target_instance_id = (
            created_json.get("id")
            or created_json.get("mId")
            or (created_json.get("instance", {}) or {}).get("id")
        )
        if not target_instance_id:
            return json.dumps({"error": "Failed to create a linear instance",
                               "status": "error"})
        was_created = True
        logger.info(f"Created new unassigned linear instance for story {story_id}")

    # Instances are SCRIPT ONLY — no clips/rendered media are associated. The
    # media deliverable is the Cutter sequence (timeline) created separately;
    # a human approves it before air, so nothing is attached to the instance.
    return json.dumps({
        "instanceId": target_instance_id,
        "sectionsWritten": len(script_sections),
        "created": was_created,
        "status": "success",
    })
