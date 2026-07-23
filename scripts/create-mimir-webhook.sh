#!/bin/bash

# Create Mimir Webhook (Interactive)
# Fetches the webhook API base URL from Parameter Store and discovers routes from API Gateway
# Usage: ./scripts/create-mimir-webhook.sh

set -e

PARAMS_FILE="./parameters.json"
if [ ! -f "$PARAMS_FILE" ]; then
    echo "Error: parameters.json not found. Run from project root."
    exit 1
fi

echo ""
echo "=== Mimir Webhook Creator ==="
echo ""

# Fetch webhook API base URL from Parameter Store
echo "Fetching webhook API URL from Parameter Store..."
BASE_URL=$(aws ssm get-parameter --name "/infrastructure/webhook-api-base-url" --query "Parameter.Value" --output text 2>/dev/null) || true

if [ -z "$BASE_URL" ] || [ "$BASE_URL" = "None" ]; then
    echo "Could not fetch from Parameter Store."
    read -p "Enter webhook API base URL: " BASE_URL
fi

# Strip trailing slash
BASE_URL="${BASE_URL%/}"
echo "Webhook API: $BASE_URL"

# Extract API ID and stage from the URL
API_ID=$(echo "$BASE_URL" | sed -n 's|https://\([^.]*\)\.execute-api.*|\1|p')
STAGE=$(echo "$BASE_URL" | sed -n 's|.*/\([^/]*\)$|\1|p')

# Discover routes from API Gateway
echo ""
echo "Discovering routes from API Gateway..."
ROUTES=()
if [ -n "$API_ID" ]; then
    # Get all resources from the API
    RESOURCES_JSON=$(aws apigateway get-resources --rest-api-id "$API_ID" --query "items[?resourceMethods].{path: path, methods: resourceMethods}" --output json 2>/dev/null) || true

    if [ -n "$RESOURCES_JSON" ] && [ "$RESOURCES_JSON" != "[]" ]; then
        # Extract paths that have POST methods (webhook routes)
        while IFS= read -r route; do
            ROUTES+=("$route")
        done < <(echo "$RESOURCES_JSON" | jq -r '.[] | select(.methods.POST != null) | .path' | sort)
    fi
fi

if [ ${#ROUTES[@]} -eq 0 ]; then
    echo "Could not discover routes. Enter manually."
    read -p "Enter webhook path (e.g. /webhook/item-embed): " WEBHOOK_PATH
else
    echo ""
    echo "Available POST routes:"
    for i in "${!ROUTES[@]}"; do
        echo "  $((i + 1))) ${ROUTES[$i]}"
    done
    echo ""
    read -p "Select route [1]: " ROUTE_CHOICE
    ROUTE_CHOICE=${ROUTE_CHOICE:-1}
    WEBHOOK_PATH="${ROUTES[$((ROUTE_CHOICE - 1))]}"
fi

WEBHOOK_URL="${BASE_URL}${WEBHOOK_PATH}"

# Select API key
echo ""
echo "Available API keys in parameters.json:"
KEYS=$(jq -r 'to_entries[] | select(.key | startswith("mimirApiKey")) | .key' "$PARAMS_FILE")
i=1
declare -a KEY_NAMES
for key in $KEYS; do
    echo "  $i) $key"
    KEY_NAMES[$i]="$key"
    i=$((i + 1))
done

echo ""
read -p "Select API key [1]: " KEY_CHOICE
KEY_CHOICE=${KEY_CHOICE:-1}
SELECTED_KEY="${KEY_NAMES[$KEY_CHOICE]}"
API_KEY=$(jq -r ".[\"$SELECTED_KEY\"]" "$PARAMS_FILE")

if [ "$API_KEY" = "null" ] || [ -z "$API_KEY" ]; then
    echo "Error: Could not read API key '$SELECTED_KEY'"
    exit 1
fi
echo "Using: $SELECTED_KEY"

# Webhook type
echo ""
echo "Webhook types:"
echo "  1) itemCreation"
echo "  2) itemChange"
echo ""
read -p "Select type [1]: " TYPE_CHOICE
TYPE_CHOICE=${TYPE_CHOICE:-1}

case $TYPE_CHOICE in
    1) WEBHOOK_TYPE="itemCreation" ;;
    2) WEBHOOK_TYPE="itemChange" ;;
    *) WEBHOOK_TYPE="itemCreation" ;;
esac

# Label
echo ""
read -p "Webhook label [Mimir Webhook - $WEBHOOK_TYPE]: " LABEL
LABEL=${LABEL:-"Mimir Webhook - $WEBHOOK_TYPE"}

# Mimir instance
echo ""
read -p "Mimir instance [us]: " MIMIR_INSTANCE
MIMIR_INSTANCE=${MIMIR_INSTANCE:-us}

# Confirm
echo ""
echo "=== Summary ==="
echo "  Instance:  ${MIMIR_INSTANCE}.mjoll.no"
echo "  Type:      $WEBHOOK_TYPE"
echo "  URL:       $WEBHOOK_URL"
echo "  Label:     $LABEL"
echo "  API Key:   ${API_KEY:0:10}..."
echo ""
read -p "Create this webhook? [Y/n]: " CONFIRM
CONFIRM=${CONFIRM:-Y}

if [[ ! "$CONFIRM" =~ ^[Yy]$ ]]; then
    echo "Cancelled."
    exit 0
fi

# Create the webhook
RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "https://${MIMIR_INSTANCE}.mjoll.no/config/api/v1/config/webhooks" \
  -H "Accept: application/json" \
  -H "Content-Type: application/json" \
  -H "x-mimir-cognito-id-token: Bearer $API_KEY" \
  -d '{
    "protected": false,
    "type": "'"$WEBHOOK_TYPE"'",
    "url": "'"$WEBHOOK_URL"'",
    "label": "'"$LABEL"'",
    "condition": {
      "criteria": "always"
    },
    "headers": [
      {
        "headerField": "Content-Type",
        "headerValue": "application/json"
      }
    ]
  }')

HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | sed '$d')

echo ""
if [ "$HTTP_CODE" -ge 200 ] && [ "$HTTP_CODE" -lt 300 ]; then
    echo "Webhook created successfully (HTTP $HTTP_CODE):"
    echo "$BODY" | jq . 2>/dev/null || echo "$BODY"
else
    echo "Error creating webhook (HTTP $HTTP_CODE):"
    echo "$BODY" | jq . 2>/dev/null || echo "$BODY"
    exit 1
fi
