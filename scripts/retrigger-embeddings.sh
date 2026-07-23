#!/bin/bash
# Re-trigger the EmbedVideoContent state machine for story items missing embeddings.
#
# Usage:
#   ./scripts/retrigger-embeddings.sh <story-id>              # re-trigger missing items
#   ./scripts/retrigger-embeddings.sh <story-id> --dry-run    # preview only
#   ./scripts/retrigger-embeddings.sh --all                   # re-trigger ALL timed-out items
#   ./scripts/retrigger-embeddings.sh --all --dry-run         # preview ALL timed-out items
#
# Requires: parameters.json in project root with sagaApiKey, sagaApiUrl, mimirApiKey

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PARAMS_FILE="$PROJECT_ROOT/parameters.json"
STATE_MACHINE_ARN="arn:aws:states:${REGION}:${AWS_ACCOUNT_ID:-YOUR_ACCOUNT_ID}:stateMachine:EmbedVideoContent"
REGION="us-east-1"
DELAY_SECONDS=2

if [ ! -f "$PARAMS_FILE" ]; then
  echo "❌ parameters.json not found at $PARAMS_FILE"
  exit 1
fi

MODE="story"
DRY_RUN=false
STORY_ID=""

for arg in "$@"; do
  case $arg in
    --dry-run) DRY_RUN=true ;;
    --all) MODE="all" ;;
    *) STORY_ID="$arg" ;;
  esac
done

if [ "$MODE" = "story" ] && [ -z "$STORY_ID" ]; then
  echo "Usage: $0 <story-id> [--dry-run]"
  echo "       $0 --all [--dry-run]"
  exit 1
fi

if $DRY_RUN; then
  echo "🔍 DRY RUN — will not start any executions"
fi

if [ "$MODE" = "story" ]; then
  echo "📋 Fetching assets for story: $STORY_ID"

  python3 - "$STORY_ID" "$PARAMS_FILE" "$STATE_MACHINE_ARN" "$REGION" "$DELAY_SECONDS" "$DRY_RUN" << 'PYEOF'
import sys, json, urllib.request, subprocess

story_id = sys.argv[1]
params_file = sys.argv[2]
sm_arn = sys.argv[3]
region = sys.argv[4]
delay = int(sys.argv[5])
dry_run = sys.argv[6] == "true"

# Get AWS account ID dynamically
account_id = subprocess.run(['aws', 'sts', 'get-caller-identity', '--query', 'Account', '--output', 'text'], capture_output=True, text=True).stdout.strip()

with open(params_file) as f:
    params = json.loads(f.read())

saga_url = params["sagaApiUrl"]
saga_key = params["sagaApiKey"]
mimir_key = params["mimirApiKey"]

# Fetch story assets from Saga API
req = urllib.request.Request(
    f"{saga_url}/stories/{story_id}/assets",
    headers={"x-api-key": saga_key, "Accept": "application/json"}
)
resp = urllib.request.urlopen(req)
data = json.loads(resp.read())
assets = data.get("assets", data) if isinstance(data, dict) else data
video_assets = [a for a in assets if a.get("itemType") == "video"]
print(f"Found {len(video_assets)} video assets in story")

# Check which ones are missing embeddings
missing = []
for a in video_assets:
    item_id = a.get("externalId", a.get("mimirItemId", ""))
    if not item_id:
        continue
    r = subprocess.run([
        "aws", "s3vectors", "get-vectors",
        "--vector-bucket-name", f"video-embeddings-{account_id}",
        "--index-name", "video-embeddings-index",
        "--keys", json.dumps([f"{item_id}/segment-0"]),
        "--region", region,
        "--query", "vectors | length(@)",
        "--output", "text"
    ], capture_output=True, text=True)
    if r.stdout.strip() != "1":
        missing.append(a)

print(f"Missing embeddings: {len(missing)}/{len(video_assets)}")
if not missing:
    print("✅ All video assets have embeddings!")
    sys.exit(0)

# Fetch item details from Mimir to build the webhook-style payload
import time
triggered = 0
for a in missing:
    item_id = a.get("externalId", a.get("mimirItemId", ""))
    title = a.get("title", "?")

    # Get item details from Mimir
    try:
        req2 = urllib.request.Request(
            f"https://us.mjoll.no/api/v1/items/{item_id}",
            headers={
                "Accept": "application/json",
                "x-mimir-cognito-id-token": f"Bearer {mimir_key}"
            }
        )
        resp2 = urllib.request.urlopen(req2)
        item_data = json.loads(resp2.read())
    except Exception as e:
        print(f"  ⚠️  Could not fetch Mimir details for {item_id}: {e}")
        continue

    # Build the same payload the webhook sends
    payload = json.dumps({
        "event": "item_created",
        "context": {"subject": "newItemCreated"},
        "item": {
            "id": item_id,
            "itemType": item_data.get("itemType", "video"),
            "metadata": item_data.get("metadata", {})
        }
    })

    if dry_run:
        print(f"  Would re-trigger: {item_id}  {title}")
        triggered += 1
        continue

    r2 = subprocess.run([
        "aws", "stepfunctions", "start-execution",
        "--state-machine-arn", sm_arn,
        "--input", payload,
        "--region", region,
        "--query", "executionArn",
        "--output", "text"
    ], capture_output=True, text=True)

    if r2.returncode == 0:
        print(f"  ✅ Re-triggered: {item_id}  {title}")
        triggered += 1
    else:
        print(f"  ❌ Failed: {item_id}  {r2.stderr.strip()}")

    time.sleep(delay)

print(f"\n📊 {triggered} items {'would be' if dry_run else ''} re-triggered")
PYEOF

elif [ "$MODE" = "all" ]; then
  echo "📋 Re-triggering ALL timed-out executions..."

  python3 - "$STATE_MACHINE_ARN" "$REGION" "$DELAY_SECONDS" "$DRY_RUN" << 'PYEOF'
import sys, json, subprocess, time

sm_arn = sys.argv[1]
region = sys.argv[2]
delay = int(sys.argv[3])
dry_run = sys.argv[4] == "true"

# Get timed-out executions
r = subprocess.run([
    "aws", "stepfunctions", "list-executions",
    "--state-machine-arn", sm_arn,
    "--status-filter", "TIMED_OUT",
    "--max-results", "100",
    "--region", region,
    "--query", "executions[].name",
    "--output", "json"
], capture_output=True, text=True)
timed_out_names = json.loads(r.stdout)
print(f"Found {len(timed_out_names)} timed-out executions")

# Get succeeded item IDs to skip
r2 = subprocess.run([
    "aws", "stepfunctions", "list-executions",
    "--state-machine-arn", sm_arn,
    "--status-filter", "SUCCEEDED",
    "--max-results", "100",
    "--region", region,
    "--query", "executions[].name",
    "--output", "json"
], capture_output=True, text=True)
succeeded_names = json.loads(r2.stdout)

succeeded_items = set()
for name in succeeded_names:
    r3 = subprocess.run([
        "aws", "stepfunctions", "get-execution-history",
        "--execution-arn", f"arn:aws:states:{region}:{sm_arn.split(':')[4]}:execution:EmbedVideoContent:{name}",
        "--region", region, "--max-results", "5",
        "--query", "events[?type==`ExecutionStarted`].executionStartedEventDetails.input",
        "--output", "text"
    ], capture_output=True, text=True)
    try:
        data = json.loads(r3.stdout.strip())
        succeeded_items.add(data["item"]["id"])
    except:
        pass

print(f"Already succeeded: {len(succeeded_items)} unique items")

triggered = 0
skipped = 0
for name in timed_out_names:
    r4 = subprocess.run([
        "aws", "stepfunctions", "get-execution-history",
        "--execution-arn", f"arn:aws:states:{region}:{sm_arn.split(':')[4]}:execution:EmbedVideoContent:{name}",
        "--region", region, "--max-results", "5",
        "--query", "events[?type==`ExecutionStarted`].executionStartedEventDetails.input",
        "--output", "text"
    ], capture_output=True, text=True)

    try:
        original_input = r4.stdout.strip()
        data = json.loads(original_input)
        item_id = data["item"]["id"]
    except:
        continue

    if item_id in succeeded_items:
        skipped += 1
        continue

    if dry_run:
        print(f"  Would re-trigger: {item_id}")
        triggered += 1
        continue

    r5 = subprocess.run([
        "aws", "stepfunctions", "start-execution",
        "--state-machine-arn", sm_arn,
        "--input", original_input,
        "--region", region,
        "--query", "executionArn",
        "--output", "text"
    ], capture_output=True, text=True)

    if r5.returncode == 0:
        print(f"  ✅ Re-triggered: {item_id}")
        triggered += 1
    else:
        print(f"  ❌ Failed: {item_id}  {r5.stderr.strip()}")

    time.sleep(delay)

print(f"\n📊 {triggered} re-triggered, {skipped} skipped (already succeeded)")
PYEOF

fi

echo "✅ Done"
