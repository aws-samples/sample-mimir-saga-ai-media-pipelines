#!/bin/bash
# Get MCP Gateway connection details for Quick Suite or Kiro
# Usage: ./scripts/get-mcp-config.sh

set -e

REGION="us-east-1"

echo ""
echo "=== MCP Gateway Connection Details ==="
echo ""

# Get values from CloudFormation outputs
GATEWAY_URL=$(aws cloudformation describe-stacks --stack-name McpGatewayStack --region "$REGION" \
  --query 'Stacks[0].Outputs[?OutputKey==`GatewayUrl`].OutputValue' --output text 2>/dev/null)

COGNITO_CLIENT_ID=$(aws cloudformation describe-stacks --stack-name McpGatewayStack --region "$REGION" \
  --query 'Stacks[0].Outputs[?OutputKey==`CognitoClientId`].OutputValue' --output text 2>/dev/null)

COGNITO_TOKEN_URL=$(aws cloudformation describe-stacks --stack-name McpGatewayStack --region "$REGION" \
  --query 'Stacks[0].Outputs[?OutputKey==`CognitoTokenUrl`].OutputValue' --output text 2>/dev/null)

COGNITO_USER_POOL_ID=$(aws cloudformation describe-stacks --stack-name McpGatewayStack --region "$REGION" \
  --query 'Stacks[0].Outputs[?OutputKey==`CognitoUserPoolId`].OutputValue' --output text 2>/dev/null)

if [ -z "$GATEWAY_URL" ] || [ "$GATEWAY_URL" = "None" ]; then
  echo "❌ McpGatewayStack not deployed. Run: npx cdk deploy McpGatewayStack"
  exit 1
fi

# Get client secret from Cognito
CLIENT_SECRET=$(aws cognito-idp describe-user-pool-client \
  --user-pool-id "$COGNITO_USER_POOL_ID" \
  --client-id "$COGNITO_CLIENT_ID" \
  --region "$REGION" \
  --query 'UserPoolClient.ClientSecret' --output text 2>/dev/null)

echo "MCP Server URL:   $GATEWAY_URL"
echo "Token URL:        $COGNITO_TOKEN_URL"
echo "Client ID:        $COGNITO_CLIENT_ID"
echo "Client Secret:    $CLIENT_SECRET"
echo "Scope:            mcp-gateway/invoke"
echo "Grant Type:       client_credentials"
echo ""
echo "=== Quick Suite Setup ==="
echo ""
echo "1. Open Quick Suite → Settings → MCP Servers"
echo "2. Add a new MCP server with:"
echo "   - Server URL:     $GATEWAY_URL"
echo "   - Auth Type:      OAuth 2.0 Client Credentials"
echo "   - Token URL:      $COGNITO_TOKEN_URL"
echo "   - Client ID:      $COGNITO_CLIENT_ID"
echo "   - Client Secret:  $CLIENT_SECRET"
echo "   - Scope:          mcp-gateway/invoke"
echo ""
echo "=== Kiro Setup ==="
echo ""

# Generate a fresh token for Kiro (expires in 1 hour)
TOKEN=$(curl -s -X POST "$COGNITO_TOKEN_URL" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -u "$COGNITO_CLIENT_ID:$CLIENT_SECRET" \
  -d "grant_type=client_credentials&scope=mcp-gateway/invoke" | python3 -c "import sys,json; print(json.loads(sys.stdin.read()).get('access_token','ERROR'))" 2>/dev/null)

if [ "$TOKEN" != "ERROR" ] && [ -n "$TOKEN" ]; then
  echo "Add to .kiro/settings/mcp.json:"
  echo ""
  echo '{'
  echo '  "mcpServers": {'
  echo '    "mimir-saga": {'
  echo '      "type": "streamableHttp",'
  echo "      \"url\": \"$GATEWAY_URL\","
  echo '      "headers": {'
  echo "        \"Authorization\": \"Bearer $TOKEN\""
  echo '      }'
  echo '    }'
  echo '  }'
  echo '}'
  echo ""
  echo "⚠️  Token expires in 1 hour. Re-run this script to get a fresh one."
else
  echo "⚠️  Could not generate token. Check Cognito configuration."
fi
