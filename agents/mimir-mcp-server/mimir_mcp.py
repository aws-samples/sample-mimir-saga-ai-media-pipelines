"""
Mimir MCP Server

Exposes the Mimir media asset management API as MCP tools
for integration with Amazon Quick Suite and other MCP clients.

Tools:
  - search_assets: Search for media assets by keyword
  - get_asset_details: Get full metadata for a specific asset
  - get_folder_contents: Browse folder structure and contents
  - get_asset_transcript: Get the transcript of a video/audio asset
  - get_asset_comments: Get comments on an asset
  - get_recent_items: Get recently added/modified items
"""

import os
import json
import logging
from datetime import datetime, timedelta

import httpx
from mcp.server.fastmcp import FastMCP

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# --- Configuration ---
# Supports two modes:
# 1. Direct env vars (local development): MIMIR_API_KEY, SAGA_API_KEY, SAGA_API_BASE
# 2. Secrets Manager ARNs (AgentCore Runtime): MIMIR_API_KEY_SECRET_ARN, SAGA_API_KEY_SECRET_ARN, SAGA_API_URL_SECRET_ARN

MIMIR_API_BASE = os.environ.get("MIMIR_API_BASE", "https://us.mjoll.no")
MIMIR_API_KEY = os.environ.get("MIMIR_API_KEY", "")
SAGA_API_BASE = os.environ.get("SAGA_API_BASE", "")
SAGA_API_KEY = os.environ.get("SAGA_API_KEY", "")

def _load_secrets():
    """Load API keys from Secrets Manager if ARN env vars are set."""
    global MIMIR_API_KEY, SAGA_API_KEY, SAGA_API_BASE

    mimir_secret_arn = os.environ.get("MIMIR_API_KEY_SECRET_ARN")
    saga_key_secret_arn = os.environ.get("SAGA_API_KEY_SECRET_ARN")
    saga_url_secret_arn = os.environ.get("SAGA_API_URL_SECRET_ARN")

    if not any([mimir_secret_arn, saga_key_secret_arn, saga_url_secret_arn]):
        logger.info("No secret ARNs found — using direct env vars")
        return

    try:
        import boto3
        secrets_client = boto3.client("secretsmanager")

        if mimir_secret_arn and not MIMIR_API_KEY:
            resp = secrets_client.get_secret_value(SecretId=mimir_secret_arn)
            MIMIR_API_KEY = resp["SecretString"]
            logger.info("Loaded Mimir API key from Secrets Manager")

        if saga_key_secret_arn and not SAGA_API_KEY:
            resp = secrets_client.get_secret_value(SecretId=saga_key_secret_arn)
            SAGA_API_KEY = resp["SecretString"]
            logger.info("Loaded Saga API key from Secrets Manager")

        if saga_url_secret_arn and not SAGA_API_BASE:
            resp = secrets_client.get_secret_value(SecretId=saga_url_secret_arn)
            SAGA_API_BASE = resp["SecretString"]
            logger.info("Loaded Saga API URL from Secrets Manager")

    except Exception as e:
        logger.error(f"Failed to load secrets: {e}")

_load_secrets()

mcp = FastMCP(
    "Mimir-Saga MAM",
    instructions="Media asset management and editorial planning tools for broadcast news workflows. Mimir handles media assets (footage, clips, files). Saga handles editorial planning (stories, rundowns, assignments).",
    host="0.0.0.0",
    stateless_http=True,
)

# --- Helpers ---

def _headers() -> dict:
    return {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "x-mimir-cognito-id-token": f"Bearer {MIMIR_API_KEY}",
    }


def _saga_headers() -> dict:
    return {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "x-api-key": SAGA_API_KEY,
    }


def _simplify_item(item: dict) -> dict:
    """Extract the most useful fields from a Mimir item to keep responses concise."""
    tech = item.get("technicalMetadata", {}).get("formData", {})
    return {
        "id": item.get("id"),
        "name": item.get("name") or item.get("originalFileName"),
        "itemType": item.get("itemType"),
        "mediaDuration": item.get("mediaDuration"),
        "mediaFrameRate": item.get("mediaFrameRate"),
        "mediaType": item.get("mediaType"),
        "mediaSize": item.get("mediaSize"),
        "createdOn": item.get("createdOn"),
        "modifiedOn": item.get("modifiedOn"),
        "originalFileName": item.get("originalFileName"),
        "hasProxy": item.get("hasProxy"),
        "hasEditProxy": item.get("hasEditProxy"),
        "transcriptionEnabled": item.get("transcriptionEnabled"),
        "itemState": item.get("itemState"),
        "resolution": f"{tech.get('technical_video_width', '')}x{tech.get('technical_video_height', '')}" if tech.get("technical_video_width") else None,
        "codec": tech.get("technical_media_codec_name"),
        "thumbnail": item.get("thumbnail"),
    }


# --- Tools ---

@mcp.tool()
async def search_assets(
    query: str,
    items_per_page: int = 10,
    page: int = 0,
    folder_id: str | None = None,
    element_type: str | None = None,
) -> dict:
    """Search for media assets in Mimir by keyword.

    Args:
        query: Search terms (e.g. "city council meeting", "interview mayor")
        items_per_page: Number of results to return (default 10, max 50)
        page: Page offset for pagination (default 0)
        folder_id: Optional folder ID to scope the search
        element_type: Optional filter by type (e.g. "video", "audio", "image", "document")

    Returns:
        Search results with total count and simplified item details.
    """
    params = {
        "searchString": query,
        "itemsPerPage": min(items_per_page, 50),
        "from": page,
        "readableMetadataFields": "true",
    }
    if folder_id:
        params["folderId"] = folder_id
    if element_type:
        params["elementType"] = element_type

    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.get(
            f"{MIMIR_API_BASE}/api/v1/search",
            headers=_headers(),
            params=params,
        )
        resp.raise_for_status()
        data = resp.json()

    items = data.get("_embedded", {}).get("collection", [])
    return {
        "total": data.get("total", 0),
        "count": len(items),
        "page": page,
        "items": [_simplify_item(item) for item in items],
    }


@mcp.tool()
async def get_asset_details(item_id: str) -> dict:
    """Get full metadata for a specific media asset.

    Args:
        item_id: The Mimir item ID (UUID format)

    Returns:
        Complete item details including metadata, technical specs, and URLs.
    """
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.get(
            f"{MIMIR_API_BASE}/api/v1/items/{item_id}",
            headers=_headers(),
            params={"readableMetadataFields": "true"},
        )
        resp.raise_for_status()
        return _simplify_item(resp.json())


@mcp.tool()
async def get_folder_contents(
    folder_id: str,
    items_per_page: int = 20,
    skip_folders: bool = False,
) -> dict:
    """Browse the contents of a folder in Mimir.

    Args:
        folder_id: The folder ID to browse
        items_per_page: Number of items to return (default 20)
        skip_folders: If true, only return items (no subfolders)

    Returns:
        List of items and subfolders in the folder.
    """
    params = {
        "readableMetadataFields": "true",
        "skipFolders": str(skip_folders).lower(),
    }

    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.get(
            f"{MIMIR_API_BASE}/api/v1/folders/{folder_id}/content",
            headers=_headers(),
            params=params,
        )
        resp.raise_for_status()
        data = resp.json()

    # Folder content uses "hits" not "_embedded.collection"
    items = data.get("hits", data.get("_embedded", {}).get("collection", []))
    return {
        "total": data.get("total", len(items)),
        "items": [_simplify_item(item) for item in items],
    }


@mcp.tool()
async def get_asset_transcript(item_id: str) -> dict:
    """Get the transcript of a video or audio asset with word-level timing.

    Fetches the item details to get the transcript URL, then retrieves
    the full timed transcript. Returns the full text and word-level timing.

    Args:
        item_id: The Mimir item ID

    Returns:
        Full transcript text and word-level timing entries.
    """
    async with httpx.AsyncClient(timeout=30) as client:
        # Step 1: Get item to find transcript URL
        resp = await client.get(
            f"{MIMIR_API_BASE}/api/v1/items/{item_id}",
            headers=_headers(),
        )
        resp.raise_for_status()
        item = resp.json()

        transcript_url = item.get("timedTranscriptUrl")
        if not transcript_url:
            return {
                "error": f"No transcript available for item {item_id}",
                "transcriptionEnabled": item.get("transcriptionEnabled", False),
                "transcriptionState": item.get("transcriptionState"),
            }

        # Step 2: Fetch the timed transcript
        resp2 = await client.get(transcript_url, timeout=60)
        resp2.raise_for_status()
        words = resp2.json()

    # Build full text from word entries
    full_text = " ".join(w.get("content", "") for w in words)
    return {
        "itemId": item_id,
        "wordCount": len(words),
        "fullText": full_text,
        "durationMs": words[-1]["endTime"] if words else 0,
        "words": words,  # Full word-level timing
    }


@mcp.tool()
async def get_asset_comments(item_id: str) -> dict:
    """Get all comments on a media asset.

    Args:
        item_id: The Mimir item ID

    Returns:
        List of comments with authors and timestamps.
    """
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.get(
            f"{MIMIR_API_BASE}/api/v1/items/{item_id}/comments",
            headers=_headers(),
        )
        resp.raise_for_status()
        return resp.json()


@mcp.tool()
async def get_item_thumbnail(item_id: str, position: int = 0) -> dict:
    """Get a thumbnail image URL for a video asset at a specific time position.

    Args:
        item_id: The Mimir item ID
        position: Time position in milliseconds (default 0 = first frame)

    Returns:
        Thumbnail URL that can be displayed or downloaded.
    """
    async with httpx.AsyncClient(timeout=30) as client:
        # Get item details which includes the pre-signed thumbnail URL
        resp = await client.get(
            f"{MIMIR_API_BASE}/api/v1/items/{item_id}",
            headers=_headers(),
        )
        resp.raise_for_status()
        item = resp.json()

        thumbnail_url = item.get("thumbnail")
        thumbnail_strip = item.get("thumbnailStrip")

        return {
            "itemId": item_id,
            "thumbnailUrl": thumbnail_url,
            "thumbnailStripUrl": thumbnail_strip,
            "requestedPosition": position,
        }


@mcp.tool()
async def update_item_metadata(
    item_id: str,
    metadata: dict,
) -> dict:
    """Update metadata fields on a Mimir item (e.g., add tags, descriptions, labels).

    Args:
        item_id: The Mimir item ID to update
        metadata: Dictionary of metadata fields to update (e.g., {"description": "City council meeting footage"})

    Returns:
        Updated item confirmation.
    """
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.patch(
            f"{MIMIR_API_BASE}/api/v1/itemMetadata/{item_id}",
            headers=_headers(),
            json=metadata,
        )
        resp.raise_for_status()
        return {"success": True, "itemId": item_id}


@mcp.tool()
async def get_recent_items(
    hours: int = 24,
    items_per_page: int = 20,
    element_type: str | None = None,
) -> dict:
    """Get recently added or modified media assets.

    Args:
        hours: Look back period in hours (default 24)
        items_per_page: Number of results (default 20)
        element_type: Optional filter by type (e.g. "video", "audio")

    Returns:
        Recently modified items sorted by modification date.
    """
    since = datetime.utcnow() - timedelta(hours=hours)
    params = {
        "searchString": "*",
        "itemsPerPage": min(items_per_page, 50),
        "from": 0,
        "sortBy": "modifiedAt",
        "sortOrder": "desc",
        "readableMetadataFields": "true",
    }
    if element_type:
        params["elementType"] = element_type

    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.get(
            f"{MIMIR_API_BASE}/api/v1/search",
            headers=_headers(),
            params=params,
        )
        resp.raise_for_status()
        data = resp.json()

    items = data.get("_embedded", {}).get("collection", [])
    return {
        "total": data.get("total", 0),
        "count": len(items),
        "items": [_simplify_item(item) for item in items],
    }


# --- Saga Tools ---

@mcp.tool()
async def search_stories(
    query: str,
    types: list[str] | None = None,
    status_list: list[str] | None = None,
    limit: int = 10,
) -> dict:
    """Search for stories and pitches in Saga editorial planning system.

    Args:
        query: Search terms (e.g. "city council", "breaking news", "weather")
        types: Filter by type - ["story"], ["pitch"], or ["story", "pitch"] (default: both)
        status_list: Filter by status - e.g. ["draft", "in_progress", "ready"]
        limit: Number of results (default 10, max 50)

    Returns:
        Matching stories with titles, status, and metadata.
    """
    body = {
        "searchString": query,
        "perPagelimit": min(limit, 50),
    }
    if types:
        body["types"] = types
    if status_list:
        body["statusList"] = status_list

    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(
            f"{SAGA_API_BASE}/search",
            headers=_saga_headers(),
            json=body,
        )
        resp.raise_for_status()
        data = resp.json()

    items = data.get("items", [])
    return {
        "total": data.get("total", len(items)),
        "stories": [
            {
                "id": item.get("id"),
                "type": item.get("type"),
                "title": item.get("title"),
                "status": item.get("status"),
                "createdAt": item.get("createdAt"),
                "updatedAt": item.get("updatedAt"),
                "publishingAt": item.get("publishingAt"),
                "metadata": item.get("metadata", {}),
                "totalInstances": item.get("totalInstances", 0),
            }
            for item in items
        ],
    }


@mcp.tool()
async def get_story_details(story_id: str) -> dict:
    """Get full details of a story including content, assignments, and sync status.

    Args:
        story_id: The Saga story ID (e.g. "STR-xxxxx")

    Returns:
        Complete story details including title, content, metadata, and assignments.
    """
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.get(
            f"{SAGA_API_BASE}/stories/{story_id}",
            headers=_saga_headers(),
        )
        resp.raise_for_status()
        story = resp.json()

        # Extract script text from content URL or inline content
        script_text = ""
        content_url = story.get("contentUrl")
        content = story.get("content")

        if content_url:
            # Content stored externally — fetch it
            try:
                resp2 = await client.get(content_url, timeout=30)
                resp2.raise_for_status()
                content = resp2.json()
            except Exception:
                content = None

        if isinstance(content, dict) and "document" in content:
            lines = []
            for block in content["document"]:
                children = block.get("children", [])
                line = "".join(child.get("text", "") for child in children)
                if line:
                    lines.append(line)
            script_text = "\n".join(lines)

    return {
        "id": story.get("mId"),
        "title": story.get("mTitle"),
        "type": story.get("mType"),
        "description": story.get("mDescription"),
        "state": story.get("mState"),
        "publishingAt": story.get("mPublishingAt"),
        "createdAt": story.get("mCreatedAt"),
        "updatedAt": story.get("mUpdatedAt"),
        "metadata": story.get("metadata", {}),
        "assignedMembers": story.get("mAssignedMembers", []),
        "scriptText": script_text if script_text else None,
    }


@mcp.tool()
async def create_story(
    title: str,
    story_type: str = "story",
    description: str | None = None,
    publishing_at: str | None = None,
) -> dict:
    """Create a new story or pitch in Saga.

    Args:
        title: Title of the story (e.g. "City Council Meeting Coverage")
        story_type: "story" or "pitch" (default: "story")
        description: Optional description of the story
        publishing_at: Optional publish date in ISO format (e.g. "2026-04-10T18:00:00Z")

    Returns:
        Created story details with ID.
    """
    body = {
        "mTitle": title,
        "mType": story_type,
    }
    if description:
        body["mDescription"] = description
    if publishing_at:
        body["mPublishingAt"] = publishing_at

    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(
            f"{SAGA_API_BASE}/stories",
            headers=_saga_headers(),
            json=body,
        )
        resp.raise_for_status()
        story = resp.json()

    return {
        "id": story.get("mId"),
        "title": story.get("mTitle"),
        "type": story.get("mType"),
        "state": story.get("mState"),
        "createdAt": story.get("mCreatedAt"),
    }


@mcp.tool()
async def get_story_assets(story_id: str) -> dict:
    """Get all media assets associated with a story.

    Args:
        story_id: The Saga story ID

    Returns:
        List of assets linked to the story with their Mimir item IDs.
    """
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.get(
            f"{SAGA_API_BASE}/stories/{story_id}/assets",
            headers=_saga_headers(),
        )
        resp.raise_for_status()
        data = resp.json()

    assets = data if isinstance(data, list) else data.get("items", data.get("assets", []))
    return {
        "storyId": story_id,
        "count": len(assets),
        "assets": [
            {
                "id": a.get("mRefId") or a.get("id"),
                "title": a.get("mTitle") or a.get("title"),
                "type": a.get("mType") or a.get("type"),
                "mimirItemId": a.get("mimirItemId") or a.get("mRefId"),
            }
            for a in assets
        ],
    }


@mcp.tool()
async def get_story_notes(story_id: str) -> dict:
    """Get editorial notes on a story.

    Args:
        story_id: The Saga story ID

    Returns:
        List of notes with content and authors.
    """
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.get(
            f"{SAGA_API_BASE}/stories/{story_id}/notes",
            headers=_saga_headers(),
        )
        resp.raise_for_status()
        return resp.json()


@mcp.tool()
async def update_story_content(story_id: str, script_text: str) -> dict:
    """Update a story's content/script in Saga. Converts plain text into Slate document format.

    Each paragraph of the input text becomes a separate paragraph block.
    Lines starting with (( are treated as broadcast cues (SOT markers, PKG markers, etc.).

    Args:
        story_id: The Saga story ID
        script_text: The script or content text. Use newlines to separate paragraphs.

    Returns:
        Updated story confirmation.
    """
    # Convert plain text to Slate document format
    lines = [line.strip() for line in script_text.strip().split("\n") if line.strip()]
    document = []
    for i, line in enumerate(lines):
        # First line becomes heading
        if i == 0:
            document.append({
                "type": "heading-one",
                "children": [{"text": line}],
            })
        else:
            document.append({
                "type": "paragraph",
                "children": [{"text": line}],
            })

    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.patch(
            f"{SAGA_API_BASE}/stories/{story_id}",
            headers=_saga_headers(),
            json={"content": {"document": document}},
        )
        resp.raise_for_status()
        return {
            "success": True,
            "storyId": story_id,
            "paragraphs": len(document),
        }


@mcp.tool()
async def add_story_note(story_id: str, title: str, description: str = "") -> dict:
    """Add an editorial note to a story.

    Args:
        story_id: The Saga story ID
        title: Title/headline of the note
        description: Detailed note content (optional)

    Returns:
        Created note confirmation.
    """
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(
            f"{SAGA_API_BASE}/stories/{story_id}/notes",
            headers=_saga_headers(),
            json={"title": title, "description": description},
        )
        resp.raise_for_status()
        return resp.json()


# --- Entrypoint ---

if __name__ == "__main__":
    mcp.run(transport="streamable-http")
