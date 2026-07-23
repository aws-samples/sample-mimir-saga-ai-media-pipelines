# Mimir + Saga MCP Server

MCP server that exposes the Mimir (media asset management) and Saga (editorial planning) APIs as tools for Amazon Quick Suite and other MCP clients. Deployed on Amazon Bedrock AgentCore Runtime with AgentCore Gateway for authentication.

## Tools (15 total)

### Mimir — Media Asset Management

| Tool | Description |
|------|-------------|
| `search_assets` | Search for media assets by keyword, with optional folder and type filters |
| `get_asset_details` | Get full metadata for a specific asset by ID |
| `get_folder_contents` | Browse folder structure and contents |
| `get_asset_transcript` | Get word-level timed transcript of a video/audio asset |
| `get_asset_comments` | Get all comments on a media asset |
| `get_item_thumbnail` | Get thumbnail URL for a video asset |
| `update_item_metadata` | Update metadata fields on an asset (tags, descriptions) |
| `get_recent_items` | Get recently added or modified assets |

### Saga — Editorial Planning

| Tool | Description |
|------|-------------|
| `search_stories` | Search for stories and pitches |
| `get_story_details` | Get full story details including script content |
| `create_story` | Create a new story or pitch |
| `update_story_content` | Update a story's script/content (converts text to Slate format) |
| `get_story_assets` | Get media assets linked to a story |
| `get_story_notes` | Get editorial notes on a story |
| `add_story_note` | Add an editorial note to a story |

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `MIMIR_API_BASE` | Yes | Mimir API base URL (e.g. `https://us.mjoll.no`) |
| `MIMIR_API_KEY` | Yes* | Mimir API key (direct, for local dev) |
| `SAGA_API_BASE` | Yes* | Saga API base URL (direct, for local dev) |
| `SAGA_API_KEY` | Yes* | Saga API key (direct, for local dev) |
| `MIMIR_API_KEY_SECRET_ARN` | Yes* | Secrets Manager ARN (for AgentCore Runtime) |
| `SAGA_API_KEY_SECRET_ARN` | Yes* | Secrets Manager ARN (for AgentCore Runtime) |
| `SAGA_API_URL_SECRET_ARN` | Yes* | Secrets Manager ARN (for AgentCore Runtime) |

*Either direct env vars OR secret ARNs are required. Direct vars for local dev, ARNs for deployed.

## Local Development

```bash
pip install -r requirements.txt

MIMIR_API_BASE=https://us.mjoll.no \
MIMIR_API_KEY=your-mimir-key \
SAGA_API_BASE=https://your-saga-instance.execute-api.us-west-2.amazonaws.com/v1 \
SAGA_API_KEY=your-saga-key \
python mimir_mcp.py
```

### Run Tests

```bash
# Read-only tests (all tools except write operations)
python test_mcp.py

# Write tests (creates test story + note in Saga)
python test_write_tools.py

# Content update test (writes script to a story)
python test_write_content.py
```

## Deployment

### Architecture

```
Quick Suite → AgentCore Gateway (Cognito auth) → AgentCore Runtime (MCP server) → Mimir/Saga APIs
```

### What gets deployed

| Stack | Resources |
|-------|-----------|
| `AgentCoreStack` | MCP server container on AgentCore Runtime |
| `McpGatewayStack` | AgentCore Gateway + Cognito User Pool + IAM roles |

### Deploy

```bash
# From the project root — deploys all stacks including MCP server + Gateway
./deploy.sh
```

### Deployment outputs you'll need

After deployment, note these CloudFormation outputs from `McpGatewayStack`:

| Output | Use In Quick Suite |
|--------|-------------------|
| `GatewayMcpEndpoint` | MCP Server Endpoint |
| `CognitoClientId` | Client ID (service auth) |
| `CognitoTokenUrl` | Token URL (service auth) |

You'll also need the **Cognito Client Secret** — retrieve it from the AWS Console:
Cognito → User Pools → `mcp-gateway-auth` → App clients → `quick-suite-mcp-client` → Show client secret

## Configure in Amazon Quick Suite

### Prerequisites
- Amazon Quick Enterprise subscription (required for MCP integrations)
- Deployment completed (all outputs available)

### Step 1: Create MCP Integration

1. In the Quick console, go to **Integrations** → **Add**
2. Select **Model Context Protocol (MCP)**
3. Configure:
   - **Name**: `Mimir-Saga MAM`
   - **Description**: `Media asset management and editorial planning tools for broadcast news`
   - **MCP Server Endpoint**: paste the `GatewayMcpEndpoint` output value
4. Click **Next**

### Step 2: Configure Authentication

1. Select **Service authentication**
2. Fill in:
   - **Client ID**: from `CognitoClientId` deployment output
   - **Client Secret**: from Cognito console (see above)
   - **Token URL**: from `CognitoTokenUrl` deployment output
3. Click **Create and continue**

### Step 3: Review Tools

Quick connects to the Gateway and auto-discovers all 15 tools. Review and click **Next**. Share the integration with your Quick users.

### Step 4: Link to a Chat Agent

1. Go to **Chat Agents** in Quick
2. Create or edit an agent
3. Under **Actions**, click **Link actions**
4. Select the `Mimir-Saga MAM` integration
5. Save and launch the agent

### Verify

Ask the agent:
- "What stories are we working on?"
- "Search for news footage in Mimir"
- "Create a new story for the mayor's press conference"
- "Show me the transcript of the latest interview"
- "Add a note to the city council story that we need B-roll of the courthouse"
- "Write a script for the park funding story based on these notes"

### Limitations
- MCP operations have a 60-second timeout in Quick
- Tool list is static after initial registration — redeploy and recreate integration if tools change
- Quick supports remote MCP servers only (HTTP streaming)
