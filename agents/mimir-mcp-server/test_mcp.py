"""Comprehensive test script for all Mimir + Saga MCP server tools."""
import asyncio
import sys
sys.path.insert(0, ".")
from mimir_mcp import (
    search_assets, get_asset_details, get_folder_contents,
    get_asset_transcript, get_asset_comments, get_item_thumbnail,
    update_item_metadata, get_recent_items,
    search_stories, get_story_details, create_story,
    get_story_assets, get_story_notes, add_story_note,
)

FOLDER_ID = "949c065c-c6f3-434a-9a05-8cdb4fc7a040"
VIDEO_WITH_TRANSCRIPT = "ff00dce6-6986-4190-ac6c-faa3425f3f2b"
VIDEO_ID = "e56882c5-603a-46dd-b17d-1e5992695e37"
STORY_ID = "STR-3BsIHO6HQHB5GpraGUgB4UcuQOw"

PASSED = 0
FAILED = 0

async def run_test(name, coro):
    global PASSED, FAILED
    try:
        result = await coro
        print(f"  ✅ {name}")
        PASSED += 1
        return result
    except Exception as e:
        print(f"  ❌ {name}: {e}")
        FAILED += 1
        return None

async def test():
    # --- Mimir Tools ---
    print("\n=== MIMIR TOOLS ===")

    print("\n1. search_assets")
    r = await run_test("search 'news'", search_assets("news"))
    if r: print(f"     Total: {r['total']}")

    print("\n2. get_asset_details")
    r = await run_test(f"details for {VIDEO_ID[:12]}...", get_asset_details(VIDEO_ID))
    if r: print(f"     Name: {r.get('name')}, Duration: {r.get('mediaDuration')}ms")

    print("\n3. get_folder_contents")
    r = await run_test("browse NAB folder", get_folder_contents(FOLDER_ID, items_per_page=3, skip_folders=True))
    if r: print(f"     Total: {r['total']}")

    print("\n4. get_asset_transcript")
    r = await run_test("transcript (has transcript)", get_asset_transcript(VIDEO_WITH_TRANSCRIPT))
    if r and "error" not in r: print(f"     Words: {r['wordCount']}")

    print("\n5. get_asset_transcript (graceful fail)")
    r = await run_test("transcript (no transcript)", get_asset_transcript(VIDEO_ID))
    if r and "error" in r: print(f"     Expected error: ✓")

    print("\n6. get_asset_comments")
    await run_test("comments", get_asset_comments(VIDEO_WITH_TRANSCRIPT))

    print("\n7. get_item_thumbnail")
    r = await run_test("thumbnail", get_item_thumbnail(VIDEO_WITH_TRANSCRIPT))
    if r: print(f"     Has URL: {bool(r.get('thumbnailUrl'))}")

    print("\n8. get_recent_items")
    r = await run_test("recent items", get_recent_items(hours=168))
    if r: print(f"     Total: {r['total']}")

    print("\n9. update_item_metadata")
    print("  ⏭️  Skipped (would modify data)")

    # --- Saga Tools ---
    print("\n\n=== SAGA TOOLS ===")

    print("\n10. search_stories")
    r = await run_test("search stories '*'", search_stories("*", limit=3))
    if r: print(f"      Total: {r['total']}, Returned: {len(r['stories'])}")

    print("\n11. get_story_details")
    r = await run_test(f"story details {STORY_ID[:15]}...", get_story_details(STORY_ID))
    if r: print(f"      Title: {r.get('title')}, State: {r.get('state')}")

    print("\n12. get_story_assets")
    r = await run_test(f"story assets", get_story_assets(STORY_ID))
    if r: print(f"      Assets: {r['count']}")

    print("\n13. get_story_notes")
    await run_test("story notes", get_story_notes(STORY_ID))

    print("\n14. create_story")
    print("  ⏭️  Skipped (would create data)")

    print("\n15. add_story_note")
    print("  ⏭️  Skipped (would modify data)")

    print(f"\n{'='*40}")
    print(f"Results: {PASSED} passed, {FAILED} failed, 3 skipped")
    print(f"{'='*40}")

asyncio.run(test())
