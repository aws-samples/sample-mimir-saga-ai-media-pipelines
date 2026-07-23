"""Test write tools: create_story and add_story_note."""
import asyncio
import sys
sys.path.insert(0, ".")
from mimir_mcp import create_story, add_story_note, get_story_details, get_story_notes

async def test():
    # 1. Create a test story
    print("=== Creating test story ===")
    story = await create_story(
        title="MCP Integration Test - Safe to Delete",
        story_type="story",
        description="Test story created by Mimir MCP server test suite. Safe to delete.",
    )
    print(f"  ✅ Created story: {story['id']}")
    print(f"     Title: {story['title']}")
    print(f"     State: {story['state']}")

    story_id = story["id"]

    # 2. Add a note to the story
    print("\n=== Adding note to story ===")
    note = await add_story_note(story_id, "B-roll needed", "Need B-roll of the courthouse by 4pm for the city council package.")
    print(f"  ✅ Added note")
    print(f"     Response: {note}")

    # 3. Verify by reading back
    print("\n=== Verifying story details ===")
    details = await get_story_details(story_id)
    print(f"  ✅ Story title: {details['title']}")
    print(f"     Description: {details['description']}")

    print("\n=== Verifying notes ===")
    notes = await get_story_notes(story_id)
    print(f"  ✅ Notes: {notes}")

    print(f"\n=== All write tests passed ===")
    print(f"Story ID to clean up: {story_id}")

asyncio.run(test())
