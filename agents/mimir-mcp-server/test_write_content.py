"""Test update_story_content tool."""
import asyncio
import sys
sys.path.insert(0, ".")
from mimir_mcp import update_story_content, get_story_details

SCRIPT = """City Council Approves New Park Funding
((---PKG---))
The city council voted unanimously Tuesday night to approve twelve million dollars in funding for the new Riverside Park expansion.
((SOT - Mayor Sarah Chen))
This park will serve our community for generations. It is the single largest investment in public green space in our city history.
The project includes a new amphitheater, walking trails, and a community garden. Construction is expected to begin this fall.
((REPORTER ON CAM))
Reporting from City Hall, this is a story that residents have been waiting years to hear. Back to you."""

async def test():
    story_id = "STR-3CHneic17YKhPSiM3l2ksZPkAKM"
    print("=== Updating story content ===")
    result = await update_story_content(story_id, SCRIPT)
    print(f"  Result: {result}")

    print("\n=== Verifying ===")
    details = await get_story_details(story_id)
    print(f"  Title: {details['title']}")
    if details.get("scriptText"):
        print(f"  Script preview: {details['scriptText'][:300]}...")
    else:
        print("  No script text returned")

asyncio.run(test())
