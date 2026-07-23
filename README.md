# Mimir & Saga AI Media Pipelines

AWS CDK project that integrates Mimir (media asset management) and Saga (editorial planning) with AI-powered media processing pipelines. Built for broadcast news workflows.

## Table of Contents

- [Architecture](#architecture)
- [Quick Start: Connect MCP Server to Quick Suite](#quick-start-connect-mcp-server-to-quick-suite)
- [Quick Start: Connect MCP Server to Kiro](#quick-start-connect-mcp-server-to-kiro)
- [Project Structure](#project-structure)
- [Prerequisites](#prerequisites)
- [One-Click Deployment (CloudFormation + CodeBuild)](#one-click-deployment-cloudformation--codebuild)
- [Local Deployment (for developers)](#local-deployment-for-developers)
- [Configuration](#configuration)
- [Scripts](#scripts)
- [Cost](#cost)
- [Cleanup](#cleanup)
- [Security](#security)
- [License](#license)

## Architecture

Five CDK stacks deployed to a single AWS account:

- **InfrastructureStack** — API Gateway, Lambda functions, Step Functions state machines, S3 buckets, DynamoDB, S3 Vectors
- **AgentCoreStack** — Bedrock AgentCore runtimes for AI agents (rough-cut-agent, xml-processor-agent, mimir-mcp-server)
- **McpGatewayStack** — AgentCore Gateway with Cognito JWT auth for the MCP server
- **SagaFeedsStack** — Wire feed ingestion pipeline (AP, Reuters → Saga stories)
- **ObservabilityStack** — Bedrock model invocation logging

### State Machines

| State Machine | Trigger | Purpose |
|---|---|---|
| **EmbedVideoContent** | Mimir webhook (item creation) | Downloads video → camera-stability analysis (FFmpeg) → Nova multimodal embeddings → S3 Vectors |
| **RoughCutTimeline** | Saga custom action | Gathers story context → reuses Mimir transcripts (or transcribes) → classifies clips → invokes rough-cut-agent → creates Cutter timeline |
| **StoryResearch** | Saga custom action | Generates AI research notes for a story (scripts, key facts, interview questions, angles) via Amazon Nova Pro |
| **SummarizeContent** | Mimir custom action | Transcript + visual video summaries via Amazon Nova Pro; runs Amazon Transcribe as a fallback when an item has no transcript |
| **ChapterizeContent** | Mimir custom action | Transcript-informed chapters via Amazon Nova Pro, written as Mimir timed metadata |
| **VerticalReframe** | Mimir custom action | Smart crops video to 9:16, 1:1, or 4:5 using MediaConvert Smart Cropping |
| **ReframeWithGraphics** | Mimir custom action | Smart crop + Lottie motion-graphics overlay composited per aspect ratio |
| **SagaFeedsWebhook** | Mimir webhook (item creation) | Matches wire feed items to Saga stories |

### Summarizer Pipeline

The summarizer uses Amazon Nova Pro to generate concise video summaries. It intelligently handles video storage:

- **Customer-owned S3**: If the video is stored in an S3 bucket accessible to the Lambda (e.g., customer-managed storage configured in Mimir), the summarizer uses the S3 URI directly — no data movement required.
- **Mimir-managed storage**: If the video is in Mimir's storage tenancy (not directly accessible via S3), the summarizer downloads the video via Mimir's proxy URL and stages it to a temporary S3 bucket before sending to Nova.

This means the pipeline works out-of-the-box with Mimir's hosted storage, but also optimizes for zero-copy when customers bring their own S3 buckets.

### Chapterize Pipeline

The chapterizer uses Amazon Nova Pro to analyze video content and generate chapter markers at logical scene transitions. Chapters are written as timed metadata in Mimir. The number of chapters scales with video duration (~1 per 20 seconds). Consecutive chapters with identical titles are automatically merged.

### Smart Reframe Pipeline

The reframe pipeline uses AWS Elemental MediaConvert with Smart Cropping (powered by Elemental Inference) to intelligently crop landscape video to portrait/square formats while keeping the region of interest centered.

**Supported aspect ratios:**
- **9:16** — vertical (TikTok, Reels, Shorts)
- **1:1** — square (Instagram feed)
- **4:5** — portrait (Instagram, Facebook)

The pipeline creates a new Mimir item with the reframed video, copies metadata from the original, and creates a relation between them. Smart Cropping uses AI to track the region of interest frame-by-frame, producing smooth, professional-looking crops.

**Note:** MediaConvert Smart Cropping is only available in **us-west-2**. The pipeline stages video to S3, runs the MediaConvert job cross-region, then uploads the result back to Mimir. Uses the same smart S3 resolution as the summarizer (direct access if available, proxy download if not).

### Rough Cut Agent Pipeline

The rough-cut-agent is a multi-stage AI pipeline that generates broadcast news rough cut timelines:

1. **Script Analysis** (Claude Sonnet) — Parses broadcast scripts into typed sections (anchor intro, reporter standup, VO narration, SOT soundbites, B-roll cues)
2. **Source Material Search** (Claude Sonnet) — Matches script sections to source clips using transcript text search + Nova multimodal embeddings. Interview soundbites are trimmed to start at the interviewee's answer (interviewer questions excluded)
3. **VO Detection** — Identifies reporter-provided voice-over in standup clips vs sections needing Polly synthesis
4. **VO Synthesis** — Generates voice-over audio via Amazon Polly, uploads to Mimir
5. **Timeline Assembly** (Claude Sonnet) — Chooses clips per script section; Python then recomputes all timeline positions deterministically (narrative clips packed back-to-back in script order)
6. **Broadcast Track Layout** (Python) — V1 is a gapless program track: interview SOTs plus B-roll cover under every VO section (nat sound at reduced gain). V2 carries cutaways only over jump cuts between soundbite segments. B-roll picks are restricted to camera-stable, locked-off footage (minimum 3s clips) using the per-clip stability maps
7. **Timeline Creation** — Creates the Mimir Cutter timeline with multi-track audio channel mapping (V1 audio → A1/A2, V2 → A3/A4, VO → A5)

### Camera-Stability Analysis

At ingest, every video clip is scored for camera stability (FFmpeg deshake + blurdetect in a single decode pass). Per-second motion magnitude, direction coherence, and sharpness classify each second as stable, intentional pan, settle, jiggle, wobble, shaky, or soft (out of focus). A usable/unusable segment map is written to S3 (`stability/{itemId}/segments.json`) and consumed by the rough cut agent so B-roll never lands on operator hunting, reframing, or focus-hunting moments. Thresholds are environment-tunable on the `stability-analysis-handler` Lambda (including a low-light contrast setting for dark footage), and the per-second metrics are retained so rules can be re-tuned without re-running FFmpeg. `scripts/backfill-stability.sh` analyzes clips ingested before this feature existed.

### Mimir + Saga MCP Server

The mimir-mcp-server exposes 15 Mimir and Saga API tools via MCP (Model Context Protocol) for integration with Amazon Quick Suite, Kiro, and other MCP clients. Deployed on AgentCore Runtime behind an AgentCore Gateway with Cognito JWT auth.

**Tools**: search_assets, get_asset_details, get_folder_contents, get_asset_transcript, get_asset_comments, get_item_thumbnail, update_item_metadata, get_recent_items, search_stories, get_story_details, create_story, update_story_content, get_story_assets, get_story_notes, add_story_note

## Quick Start: Connect MCP Server to Quick Suite

After deploying, run the config script to get all connection details:

```bash
./scripts/get-mcp-config.sh
```

Then in Amazon Quick Suite:

1. Click the **gear icon** (bottom-left) to open Settings
2. Go to **Integrations → Actions**
3. Click **Add action** and select **MCP**
4. Enter the values from the script output:
   - **Server URL** — the Gateway MCP endpoint
   - **Auth Type** — OAuth 2.0 Client Credentials
   - **Token URL** — the Cognito token endpoint
   - **Client ID** — the Cognito app client ID
   - **Client Secret** — the Cognito app client secret
   - **Scope** — `mcp-gateway/invoke`
5. Save — Quick Suite will auto-discover all 15 Mimir + Saga tools

## Quick Start: Connect MCP Server to Kiro

Run the config script which generates a ready-to-use Kiro config with a fresh bearer token:

```bash
./scripts/get-mcp-config.sh
```

Copy the JSON output into `.kiro/settings/mcp.json`. Note: the token expires in 1 hour — re-run the script to refresh.

## Project Structure

```
├── agents/
│   ├── rough-cut-agent/       # Rough cut timeline generation (Python, Strands SDK)
│   ├── mimir-mcp-server/      # MCP server for Mimir + Saga (Python, MCP SDK)
│   └── xml-processor-agent/   # Wire feed XML processing
├── lambda/                    # Lambda function handlers
├── lib/
│   ├── infrastructure-stack.ts     # Main CDK stack (API Gateway, Step Functions, S3, etc.)
│   ├── agentcore-stack.ts          # Bedrock AgentCore runtimes
│   ├── mcp-gateway-stack.ts        # AgentCore Gateway + Cognito auth
│   ├── observability-stack.ts      # Logging stack
│   ├── saga-feeds-stack.ts         # Wire feeds stack
│   └── constructs/                 # Reusable CDK constructs (AgentCore, MultiAgentCore)
├── scripts/                   # Utility and operational scripts
├── deploy.sh                  # One-command deployment (all 5 stacks)
└── parameters.json            # API keys (not committed)
```

## Prerequisites

- Node.js 22+
- AWS CLI configured with appropriate credentials
- AWS CDK v2
- Python 3.10+ (for agents)

> For the one-click CloudFormation deployment below, you only need an AWS account and your Mimir/Saga API keys — CodeBuild handles everything else.

## One-Click Deployment (CloudFormation + CodeBuild)

Deploy without a local development environment. A small CloudFormation stack creates a CodeBuild project that clones this repository, seeds your configuration, and runs `deploy.sh` automatically.

1. Launch the pipeline stack:

   ```bash
   aws cloudformation create-stack \
     --stack-name MSAI-DeployPipeline \
     --template-body file://scripts/deploy-pipeline.yaml \
     --capabilities CAPABILITY_NAMED_IAM \
     --parameters \
       ParameterKey=MimirApiKey,ParameterValue='sakm....' \
       ParameterKey=SagaApiKey,ParameterValue='...' \
       ParameterKey=MimirInstance,ParameterValue=us
   ```

   Or upload `scripts/deploy-pipeline.yaml` in the [CloudFormation console](https://console.aws.amazon.com/cloudformation/home#/stacks/create) and fill in the parameters.

2. Stack creation automatically starts the first build (~30–45 minutes). Follow progress via the `BuildConsoleUrl` stack output.
3. Your `parameters.json` is persisted as an SSM SecureString parameter (`/MimirSagaAI/DeploymentConfig/parameters`), so re-deploys are one command:

   ```bash
   aws codebuild start-build --project-name MSAI-DeployPipeline-build
   ```

   Each build pulls the latest code from the configured branch and redeploys.

To change configuration later, either update the pipeline stack parameters in the CloudFormation console and start a new build, or pass one-off overrides:

```bash
aws codebuild start-build --project-name MSAI-DeployPipeline-build \
  --environment-variables-override \
    name=MSAI_PARAM_OVERRIDES,value='{"SummaryFieldName":"ai_summary"}',type=PLAINTEXT
```

> **Note**: The CodeBuild role uses `AdministratorAccess` because CDK deploys resources across many services. Scope it down for production accounts.

## Local Deployment (for developers)

### Setup

1. Clone the repository
2. Copy `parameters.example.json` to `parameters.json` and fill in your values. Each entry is documented in the file:
   ```json
   [
     { "ParameterKey": "MimirApiKey",   "ParameterValue": "sakm...." },
     { "ParameterKey": "SagaApiKey",    "ParameterValue": "..." },
     { "ParameterKey": "SagaApiUrl",    "ParameterValue": "https://<your-saga-api>/v1" },
     { "ParameterKey": "MimirInstance", "ParameterValue": "us" }
   ]
   ```
   Optional parameters: `SummaryFieldName`, `MimirAllowedIssuer`, `EnableTranscribeFallback` — see `parameters.example.json` for descriptions.
3. Install dependencies:
   ```bash
   npm install
   ```

### Deploy

```bash
./deploy.sh
```

Deploys all 5 stacks in dependency order: Observability → Infrastructure → AgentCore → SagaFeeds → McpGateway.

## Configuration

### Agent Model

The rough-cut-agent model is configured via environment variables in `lib/agentcore-stack.ts`:

- `AGENT_MODEL_ID` — Model for source material and timeline assembly (default: Claude Sonnet 4)
- `SCRIPT_ANALYSIS_MODEL_ID` — Model for script analysis (falls back to `AGENT_MODEL_ID`)
- `POLLY_VOICE_ID` — Amazon Polly voice for VO synthesis (default: `Matthew`)

### Mimir Integrations (Auto-Registered)

The following are automatically registered in Mimir on every deploy via a CDK custom resource:

- **Summarize** custom action → `POST /actions/summarizer`
- **Chapterize** custom action → `POST /actions/chapterize`
- **Reframe 9:16** custom action → `POST /actions/reframe-9-16`
- **Reframe 1:1** custom action → `POST /actions/reframe-1-1`
- **Reframe 4:5** custom action → `POST /actions/reframe-4-5`
- **Embed Video Content** webhook → `POST /webhook/item-embed` (triggers on video item creation)

These are idempotent — safe to run on every deploy. If someone deletes them in the Mimir UI, the next deploy recreates them.

### Saga Custom Actions (Manual One-Time Setup)

The Saga custom actions (**Generate Rough Cut** and **Research Story**) must be configured manually via the Saga web UI:

1. Go to **Settings → Integrations → Custom actions** in Saga
2. Create a Custom Action per endpoint, with Types = `Story`
3. Set the endpoint URL from the stack outputs (`RoughCutEndpoint` / `StoryResearchEndpoint`), appending the shared API key as a query parameter:
   `https://<api-id>.execute-api.<region>.amazonaws.com/prod/actions/rough-cut?apiKey=<key>`
4. The key value is generated at deploy time — read it from the `SagaActionsApiKey` secret in AWS Secrets Manager

This is required because Saga's integration config is only available via its GraphQL API (AppSync), which requires user-level Cognito authentication not available to the CDK deploy process.

### MCP Gateway

The McpGatewayStack creates:
- Cognito User Pool with client credentials OAuth flow
- AgentCore Gateway with JWT auth
- Gateway Target pointing to the MCP server on AgentCore Runtime

Run `scripts/get-mcp-config.sh` to retrieve all connection details.

## Scripts

| Script | Purpose |
|---|---|
| `get-mcp-config.sh` | Get MCP Gateway connection details for Quick Suite / Kiro |
| `retrigger-embeddings.sh` | Re-trigger failed embedding jobs by story ID or all timed-out |
| `backfill-stability.sh` | Run camera-stability analysis for clips ingested before the feature existed |
| `upload-video-to-mimir.py` | Upload a video from S3 into an existing Mimir item |
| `create-mimir-webhook.sh` | Interactive webhook creation |
| `clear-timed-metadata.js` | Clear chapter/marker data from a Mimir item (for testing) |
| `test-vector-search.js` | Test embedding search queries |
| `get-mimir-item-details.js` | Fetch item details from Mimir API |
| `get-mimir-metadata-fields.js` | List metadata field IDs |

## Cost

You are responsible for the cost of the AWS services used while running this sample. Primary cost drivers (all pay-per-use, no idle base cost apart from S3 storage):

| Service | Used for | Driver |
|---|---|---|
| Amazon Bedrock (Nova Pro, Claude Sonnet) | Summaries, chapters, research, rough-cut agents | Tokens / video input per invocation |
| Amazon Bedrock (Nova Multimodal Embeddings) | Video embeddings at ingest | Per 15s video segment, once per clip |
| Amazon Bedrock AgentCore | Agent runtimes + gateway | Per invocation / runtime-seconds |
| Amazon Transcribe | Transcript fallback + rough-cut transcription | Per audio minute (skipped when Mimir already has a transcript) |
| AWS Elemental MediaConvert | Smart-crop reframes + graphics compositing | Per output minute |
| Amazon Polly | Voice-over synthesis | Per character |
| AWS Lambda / Step Functions / S3 / DynamoDB | Orchestration, staging, state | Minor at sample scale |

Costs scale with the number and length of videos processed. Delete the stacks when finished evaluating (see Cleanup).

## Cleanup

Remove all deployed resources:

```bash
npx cdk destroy --all
```

S3 buckets created by this sample use `autoDeleteObjects`, so their contents are removed with the stacks. Also remove the custom actions/webhooks registered in Mimir and the custom actions configured in Saga if you no longer need them.

## Security

See [CONTRIBUTING](CONTRIBUTING.md#security-issue-notifications) for more information.

This sample is intended for evaluation in non-production environments. Review IAM policies, S3 bucket policies, and API authentication settings before adapting it for production use. API keys for Mimir and Saga are stored in AWS Secrets Manager; the `parameters.json` file containing your keys is gitignored and must never be committed.

## License

This library is licensed under the MIT-0 License. See the [LICENSE](LICENSE) file.
