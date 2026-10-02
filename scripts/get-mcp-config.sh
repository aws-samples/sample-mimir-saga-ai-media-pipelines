#!/bin/bash
# Get MCP Gateway connection details for Quick Suite or Kiro, and verify they work.
#
# Usage:
#   ./scripts/get-mcp-config.sh                 # print config (secret masked) + run live check
#   ./scripts/get-mcp-config.sh --show-secret   # also print the client secret (for pasting into Quick Suite)
#   ./scripts/get-mcp-config.sh --no-verify     # skip the live endpoint check
#
# The live check is the important part: it proves the gateway, the Cognito client
# and the MCP server behind them are all still valid. A stale Quick Suite
# connector (pointing at a gateway ID from a previous deployment) is silent
# otherwise — Quick Suite keeps showing "Ready" from whenever it was configured.

set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
SHOW_SECRET=false
VERIFY=true

for arg in "$@"; do
  case "$arg" in
    --show-secret) SHOW_SECRET=true ;;
    --no-verify)   VERIFY=false ;;
    -h|--help)     sed -n '2,14p' "$0"; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; exit 1 ;;
  esac
done

# --- Preflight: required tools ---
# Do this before anything else. On some hosts /usr/local/bin (where the AWS CLI
# v2 lives) is missing from a login shell's PATH; without this check the first
# AWS call silently produces no output and every downstream error is misleading.
for tool in aws curl python3; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "❌ Required command '$tool' not found on PATH." >&2
    if [ "$tool" = "aws" ] && [ -x /usr/local/bin/aws ]; then
      echo "   It IS installed at /usr/local/bin/aws but not on your PATH. Fix with:" >&2
      echo "     export PATH=\$PATH:/usr/local/bin" >&2
    fi
    exit 1
  fi
done

# Fail early and clearly if credentials are absent/expired, rather than letting
# an auth error masquerade as "resource not found" later on.
if ! CALLER=$(aws sts get-caller-identity --query Account --output text 2>&1); then
  echo "❌ AWS credentials are not usable:" >&2
  echo "   $CALLER" >&2
  exit 1
fi
echo "AWS account: $CALLER  |  region: $REGION"

# --- Discover the stack ---
# The stack name is prefixed with an acronym derived from cdk.json productName
# ("Mimir Saga AI" -> "MSAI"), so never hardcode it: find it by suffix.
# Capture stderr so a real API error is reported instead of being swallowed.
if ! STACK=$(aws cloudformation list-stacks --region "$REGION" \
  --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE UPDATE_ROLLBACK_COMPLETE IMPORT_COMPLETE \
  --query 'StackSummaries[?ends_with(StackName, `McpGatewayStack`)].StackName | [0]' \
  --output text 2>&1); then
  echo "❌ Failed to list CloudFormation stacks in $REGION:" >&2
  echo "   $STACK" >&2
  exit 1
fi

if [ -z "$STACK" ] || [ "$STACK" = "None" ]; then
  echo "❌ No *-McpGatewayStack found in $REGION. Deploy it first:" >&2
  echo "   npx cdk deploy '*McpGatewayStack'" >&2
  exit 1
fi

get_output() {
  aws cloudformation describe-stacks --stack-name "$STACK" --region "$REGION" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue | [0]" --output text 2>/dev/null
}

# GatewayUrl already ends in /mcp — do not append another path segment.
GATEWAY_URL=$(get_output GatewayUrl)
CLIENT_ID=$(get_output CognitoClientId)
TOKEN_URL=$(get_output CognitoTokenUrl)
USER_POOL_ID=$(get_output CognitoUserPoolId)
SCOPE="mcp-gateway/invoke"

CLIENT_SECRET=$(aws cognito-idp describe-user-pool-client \
  --user-pool-id "$USER_POOL_ID" --client-id "$CLIENT_ID" --region "$REGION" \
  --query 'UserPoolClient.ClientSecret' --output text 2>/dev/null || echo "")

if [ -z "$CLIENT_SECRET" ] || [ "$CLIENT_SECRET" = "None" ]; then
  echo "❌ Could not read the client secret for client $CLIENT_ID in pool $USER_POOL_ID." >&2
  echo "   The Cognito pool may have been replaced. Redeploy the gateway stack." >&2
  exit 1
fi

if [ "$SHOW_SECRET" = true ]; then
  SECRET_DISPLAY="$CLIENT_SECRET"
else
  SECRET_DISPLAY="<hidden — re-run with --show-secret>"
fi

echo ""
echo "=== MCP Gateway Connection Details (stack: $STACK) ==="
echo ""
echo "Base URL:      $GATEWAY_URL"
echo "Token URL:     $TOKEN_URL"
echo "Client ID:     $CLIENT_ID"
echo "Client Secret: $SECRET_DISPLAY"
echo "Scope:         $SCOPE"
echo "Grant Type:    client_credentials"
echo ""
echo "Paste these into the Quick Suite MCP connector (Service-to-service OAuth)."
echo "If the connector's Base URL or Client ID differ from the above, it is"
echo "pointing at a previous deployment and will fail — update it."
echo ""

if [ "$VERIFY" = false ]; then
  exit 0
fi

# --- Live end-to-end verification ---
echo "=== Verifying endpoint ==="

TOKEN_RESPONSE=$(curl -s --max-time 30 -X POST "$TOKEN_URL" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -u "$CLIENT_ID:$CLIENT_SECRET" \
  -d "grant_type=client_credentials&scope=$SCOPE" 2>/dev/null || echo "")

TOKEN=$(printf '%s' "$TOKEN_RESPONSE" | python3 -c \
  'import sys,json;print(json.load(sys.stdin).get("access_token",""))' 2>/dev/null || echo "")

if [ -z "$TOKEN" ]; then
  echo "❌ OAuth token request FAILED."
  echo "   Response: $TOKEN_RESPONSE"
  exit 1
fi
echo "✅ OAuth token acquired"

MCP_RESPONSE=$(curl -s --max-time 60 -X POST "$GATEWAY_URL" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' 2>/dev/null || echo "")

TOOL_COUNT=$(printf '%s' "$MCP_RESPONSE" | python3 -c '
import sys, json
try:
    d = json.load(sys.stdin)
except Exception:
    print(-1); sys.exit()
print(len(d["result"]["tools"]) if "result" in d and "tools" in d.get("result", {}) else -1)
' 2>/dev/null || echo "-1")

if [ "$TOOL_COUNT" -lt 0 ]; then
  echo "❌ MCP tools/list FAILED against $GATEWAY_URL"
  echo "   Response: $(printf '%s' "$MCP_RESPONSE" | head -c 400)"
  echo ""
  echo "   Common causes:"
  echo "     - URL has a duplicated /mcp path segment (400 'Http operation is not supported')"
  echo "     - Gateway target not READY, or its runtime ARN points at a deleted runtime"
  exit 1
fi

echo "✅ MCP endpoint reachable — $TOOL_COUNT tools discovered"
echo ""
echo "Gateway is healthy. Any client failure is a client-side config mismatch."
echo ""
echo "=== Kiro Setup (optional) ==="
echo "Add to .kiro/settings/mcp.json — note the bearer token below expires in ~1h:"
echo ""
cat <<EOF
{
  "mcpServers": {
    "mimir-saga": {
      "type": "streamableHttp",
      "url": "$GATEWAY_URL",
      "headers": {
        "Authorization": "Bearer <run with --show-secret and mint a token, or paste \$TOKEN>"
      }
    }
  }
}
EOF
echo ""
