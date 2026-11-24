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
- [Graphics Templates (Bodymovin Export)](#graphics-templates-bodymovin-export)
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

1. Launch the pipeline stack. No clone required — fetch the template straight from GitHub:

   ```bash
   curl -fsSL https://raw.githubusercontent.com/aws-samples/sample-mimir-saga-ai-media-pipelines/main/scripts/deploy-pipeline.yaml -o deploy-pipeline.yaml && \
   aws cloudformation create-stack \
     --stack-name MSAI-DeployPipeline \
     --template-body file://deploy-pipeline.yaml \
     --capabilities CAPABILITY_NAMED_IAM \
     --parameters \
       ParameterKey=MimirApiKey,ParameterValue='sakm....' \
       ParameterKey=SagaApiKey,ParameterValue='...' \
       ParameterKey=MimirInstance,ParameterValue=us \
       ParameterKey=MimirAllowedIssuer,ParameterValue='https://cognito-idp.us-east-1.amazonaws.com/us-east-1_XXXXXXXXX'
   ```

   `MimirAllowedIssuer` is required for the Mimir custom actions; see [Mimir custom action authentication](#mimir-custom-action-authentication).

   Or upload `scripts/deploy-pipeline.yaml` in the [CloudFormation console](https://console.aws.amazon.com/cloudformation/home#/stacks/create) and fill in the parameters.

   The stack stores each key in its own Secrets Manager secret (see the `MimirApiKeySecretArn` and `SagaApiKeySecretArn` outputs). The CodeBuild project references those secrets as `SECRETS_MANAGER` environment variables, so no key value appears in the project or build definitions. When you update the pipeline stack later, keep the existing key values ("Use existing value" in the console, `UsePreviousValue=true` in the CLI); clearing a key deletes its secret.

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

Never pass API keys in `--environment-variables-override` as `PLAINTEXT`: override values are stored on the build record. To change a key, update the `MimirApiKey`/`SagaApiKey` stack parameters (which updates the pipeline secrets) and update the same values in the SSM config parameter, which is authoritative after the first build. Then start a new build.

> **Note**: The CodeBuild role uses `AdministratorAccess` because CDK deploys resources across many services. Scope it down for production accounts. The role also has an explicit `secretsmanager:GetSecretValue` grant on just the two API key secrets, so CodeBuild can still resolve them after you scope it down.

## Local Deployment (for developers)

### Setup

1. Clone the repository
2. Copy `parameters.example.json` to `parameters.json` and fill in your values. Each entry is documented in the file:
   ```json
   [
     { "ParameterKey": "MimirApiKey",   "ParameterValue": "sakm...." },
     { "ParameterKey": "SagaApiKey",    "ParameterValue": "..." },
     { "ParameterKey": "SagaApiUrl",    "ParameterValue": "https://<your-saga-api>/v1" },
     { "ParameterKey": "MimirInstance", "ParameterValue": "us" },
     { "ParameterKey": "MimirAllowedIssuer", "ParameterValue": "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_XXXXXXXXX" }
   ]
   ```
   `MimirAllowedIssuer` is required for the Mimir custom actions (see [Mimir custom action authentication](#mimir-custom-action-authentication)). Optional parameters: `SummaryFieldName`, `MimirAllowedAudience`, `EnableTranscribeFallback`, `EnableEmbeddingsWebhook`, `EmbeddingsFilterField`, `EmbeddingsFilterValues`, `EmbeddingsFilterFieldKey` — see `parameters.example.json` for descriptions and [Embeddings Filter](#embeddings-filter-optional).
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

- `AGENT_MODEL_ID` — Model for source material and timeline assembly (default: Claude Sonnet 4.6, `us.anthropic.claude-sonnet-4-6`). If it is not accessible, the agent falls back to Amazon Nova Pro (`us.amazon.nova-pro-v1:0`)
- `SCRIPT_ANALYSIS_MODEL_ID` — Model for script analysis (falls back to `AGENT_MODEL_ID`)
- `POLLY_VOICE_ID` — Amazon Polly voice for VO synthesis (default: `Matthew`)

### Mimir Integrations (Auto-Registered)

The following are automatically registered in Mimir on every deploy via a CDK custom resource:

- **Summarize** custom action → `POST /actions/summarizer`
- **Chapterize** custom action → `POST /actions/chapterize`
- **Reframe 9:16** custom action → `POST /actions/reframe-9-16`
- **Reframe 1:1** custom action → `POST /actions/reframe-1-1`
- **Reframe 4:5** custom action → `POST /actions/reframe-4-5`
- **Embed Video Content** webhook → `POST /webhook/item-embed` (triggers on video item creation; optionally filtered, see [Embeddings Filter](#embeddings-filter-optional))

These are idempotent — safe to run on every deploy. If someone deletes them in the Mimir UI, the next deploy recreates them.

#### Mimir custom action authentication

Mimir sends the user's Cognito ID token with every custom action (`includeJWT`). `mimir-handler` accepts a request only when that token is signed by, and issued from, the user pool named in `MimirAllowedIssuer`. **While `MimirAllowedIssuer` is blank, every custom action is rejected with `401`**, and `cdk synth`/`cdk deploy` print a warning. Before this check was required, a blank value accepted tokens from any Cognito user pool, so anyone with an AWS account could mint a token and start the pipelines.

To find your tenant's issuer, ask Mimir support, or trigger any custom action once and look for `unverified iss "https://cognito-idp...` in the `<prefix>-mimir-handler` CloudWatch log. That value comes from an unverified token, so confirm it is your Mimir tenant's pool before you use it. Then set it in `parameters.json`, or for the CodeBuild deployment pass `MSAI_PARAM_OVERRIDES='{"MimirAllowedIssuer":"https://cognito-idp..."}'`, and redeploy.

Optionally set `MimirAllowedAudience` to your Mimir app client ID (the token's `aud` claim; comma-separate several) to also pin the audience.

### Embeddings Filter (Optional)

By default every new video item in Mimir is embedded. Set `EnableEmbeddingsWebhook` to `false` to turn automatic embedding off entirely (the deploy then removes the webhook from Mimir). To embed only items whose metadata matches a value (for example, one station), set both parameters:

| Parameter | Value | Notes |
|---|---|---|
| `EmbeddingsFilterField` | Mimir metadata **fieldId**, e.g. `Station` | The field id from the metadata form definition (`node scripts/get-mimir-metadata-fields.js` lists the default form's fields with their UUIDs), not the label shown in the UI. The Mimir webhook condition uses this id. |
| `EmbeddingsFilterValues` | One value or a comma-separated list, e.g. `WKEF` or `WKEF,WBFF` | Exact, case-sensitive match on the stored value (for choice fields, the option value, not its label). |
| `EmbeddingsFilterFieldKey` | Optional, usually blank | The explicit key in the item's `metadata.formData` for the pipeline check, e.g. the field UUID. Leave blank to have the pipeline look it up (see below). |

Example, Sinclair, only WKEF. `Station` is the mandatory call-letters dropdown on the default form; its stored value equals its label:

```json
{ "ParameterKey": "EmbeddingsFilterField",  "ParameterValue": "Station" },
{ "ParameterKey": "EmbeddingsFilterValues", "ParameterValue": "WKEF" }
```

With the CodeBuild deployment, pass them once with `MSAI_PARAM_OVERRIDES='{"EmbeddingsFilterField":"Station","EmbeddingsFilterValues":"WKEF"}'`; they are then kept in the SSM config.

How it works:

- **In Mimir (the primary gate).** Instead of the single `Embed Video Content` webhook, the deploy registers one webhook per value, labelled `Embed Video Content [<field>=<value>]`, with the condition *item type equals video AND metadata field `<field>` equals `<value>`*. Mimir webhook conditions match one value per condition and combine conditions with AND only, hence one webhook per value. The previous unfiltered webhook is removed on the same deploy; clearing both parameters restores it.
- **In the pipeline (defensive second check).** The EmbedVideoContent state machine re-checks the item's current metadata before staging the video (`CheckEmbeddingsFilter`). Items that do not match end as `Succeeded` at `EmbeddingSkippedFilterMismatch`. Mimir does not key `metadata.formData` by fieldId: default-form text and date fields use `default_<fieldId>`, choice fields use the field's UUID (for `Station`, `formData['<uuid>'] = 'WKEF'`). The check therefore tries `formData[<fieldId>]`, then `formData['default_<fieldId>']`, then `formData[<field UUID>]`, looking the UUID up once per Lambda container in the default metadata form, then in the form list (`GET /api/v1/mdfs/default`, `GET /api/v1/mdfs`). Set `EmbeddingsFilterFieldKey` to skip the lookup (needed for a field on a non-default form). Values can be plain, arrays (multiple choice, tree choice: any element matches) or `{value,label}` objects (the value is compared).
- **Fail open.** If the pipeline cannot resolve the field (unknown fieldId or the lookup fails), it logs one line `filter field unresolved, letting item through: field=<field> …` and embeds the item, so a configuration mistake never silently stops all embeddings. The Mimir webhook remains the gate.
- Setting only one of `EmbeddingsFilterField` / `EmbeddingsFilterValues` fails `cdk synth` with an error.
- The webhook fires on item creation, so the filter field must already be set when Mimir creates the item (for example by the upload form or the ingest that creates it). Items whose field is filled in later raise an item-change event instead and are not embedded. Items embedded on demand by the Rough Cut pipeline are not filtered.

### Webhook Authentication

The Mimir Webhooks API (`/webhook/item-embed`, `/webhook/item-change`, `/webhook/item-create`) only accepts requests that carry the `x-mimir-webhook-token` header. A Lambda authorizer compares it, in constant time, with the `MimirWebhookToken` secret that CDK generates in Secrets Manager (ARN in SSM `/infrastructure/webhook-token-secret-arn`). A request with no header gets `401`, a wrong value gets `403`, and in both cases no Lambda or Step Functions execution starts. The stage is also throttled (50 requests/second, burst 100).

You do not need to configure anything in Mimir: on every deploy, the registration custom resource adds the header to each Mimir webhook whose URL points at this API, including webhooks you created yourself with `scripts/create-mimir-webhook.sh` or in the Mimir UI. CloudFormation runs that step before it deploys the API stage that enforces the header, so existing webhooks keep working through the upgrade. If you create a webhook by hand between deploys, add the header with the secret value in Mimir's **Custom headers** (header field `x-mimir-webhook-token`), or redeploy.

To rotate the token, put a new value in the `MimirWebhookToken` secret and redeploy. Until the redeploy updates Mimir, webhooks are rejected (the authorizer re-reads the secret within 5 minutes).

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

## Graphics Templates (Bodymovin Export)

The Reframe + Graphics pipeline renders [Lottie](https://airbnb.io/lottie/) motion-graphics overlays exported from Adobe After Effects. Templates live in `graphics/templates/` and are uploaded to S3 on deploy — see [graphics/README.md](graphics/README.md) for layer-naming conventions and template requirements.

### Installing the Bodymovin plugin

Bodymovin is the free After Effects extension that exports compositions as Lottie JSON.

**Option A — Adobe Exchange (recommended):**
1. Install from the [Bodymovin page on Adobe Exchange](https://exchange.adobe.com/apps/cc/12557) (Creative Cloud handles the install)
2. Restart After Effects

**Option B — Manual ZXP install:**
1. Download the `.zxp` from [aescripts.com/bodymovin](https://aescripts.com/bodymovin/) (free, "name your own price" at $0) or from the [lottie-web GitHub repo](https://github.com/airbnb/lottie-web) (`build/extension/bodymovin.zip`)
2. Install it with [ZXP Installer](https://aescripts.com/learn/zxp-installer/)
3. Restart After Effects

**Then, in After Effects:**
1. Enable **Preferences → Scripting & Expressions → "Allow Scripts to Write Files and Access Network"** (required — the export silently fails without it)
2. Open the plugin via **Window → Extensions → Bodymovin**

### Export settings

Several Bodymovin settings are not optional for this pipeline — the wrong value
produces a JSON that exports without error and then renders incorrectly. Glyphs
must be on (the server-side text fitting measures glyph widths), asset
compression must be off (it can drop the logo's alpha channel), and expressions
must not be converted to keyframes (it freezes the headline line-count control).

The full table, with the reason behind each, is in
**[graphics/README.md → Bodymovin export settings that matter](graphics/README.md#bodymovin-export-settings-that-matter)**.

After exporting, name the files per the convention in
[graphics/README.md](graphics/README.md), drop them in `graphics/templates/`,
and deploy.

### Authoring guidelines

Start from `graphics/reframe-graphics-overlay-template.aep` rather than a blank
project — it already meets the renderer's layer-name contract and the export
constraints. See
[graphics/README.md → Template anatomy](graphics/README.md#template-anatomy) for
which layers are structural, which are placeholders, and what a customer is
expected to rebrand.

Two constraints worth knowing before you design anything:

- **Text is replaced at render time, geometry is not.** Auto-sizing rigs that
  measure text bounds with `sourceRectAtTime()` cannot run in lottie-web. Bake
  such expressions before export and let the handler resize label backgrounds
  instead — see
  [Text background fitting](graphics/README.md#text-background-fitting).
- **Only the first ~15s renders.** The pipeline caps the overlay at `maxFrames`
  and loops it, so put the entrance animation at the start and hold. See
  [Render duration and looping](graphics/README.md#render-duration-and-looping).

## Scripts

| Script | Purpose |
|---|---|
| `ae-audit-project.jsx` | After Effects: read-only audit of a graphics template project — font inventory, brand-string leak scan, Lottie compatibility warnings, renderer layer-name contract check. Run via File > Scripts > Run Script File... |
| `ae-sanitize-template.jsx` | After Effects: automates the mechanical sanitization of a template — reduce to delivery comps, delete guide layers, remap fonts, swap logos for a placeholder, trim durations, rename comps. Defaults to a dry run |
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

The Mimir/Saga API key secrets are retained when the stacks are deleted, so a stack update can never delete a key. Delete them yourself when you are done (Secrets Manager console, descriptions "API key for calling Mimir API", "API key for calling Saga API" and "Base URL for Saga API").

## Security

See [CONTRIBUTING](CONTRIBUTING.md#security-issue-notifications) for more information.

This sample is intended for evaluation in non-production environments. Review IAM policies, S3 bucket policies, and API authentication settings before adapting it for production use. API keys for Mimir and Saga are stored in AWS Secrets Manager; the `parameters.json` file containing your keys is gitignored and must never be committed. The keys are not part of any CloudFormation template: the stacks create the secrets empty, and `deploy.sh` writes the values from `parameters.json` with `PutSecretValue` (`scripts/sync-api-key-secrets.js`). To change a key, update `parameters.json` (or the SSM config parameter for the CodeBuild deployment) and redeploy. The deploying identity needs `secretsmanager:GetSecretValue` and `secretsmanager:PutSecretValue` on these secrets.

API authentication in this sample:

- **Mimir Webhooks API**: every route requires the `x-mimir-webhook-token` header, checked by a Lambda authorizer before any integration runs (see [Webhook authentication](#webhook-authentication)).
- **Mimir custom actions** (`/actions/*` handled by `mimir-handler`): each request must carry a valid Mimir-issued Cognito ID token (`includeJWT`). Set `MimirAllowedIssuer` to your Mimir tenant's issuer; if it is blank, a valid ID token from any Amazon Cognito user pool is accepted.
- **Saga custom actions** (`/actions/generate-*`, `/actions/story-research`): the shared `SagaActionsApiKey` is checked in `saga-action-handler`.

Mimir custom actions are authenticated by the Mimir user's Cognito ID token, pinned to the issuer in `MimirAllowedIssuer`; with no issuer configured they are all rejected (see [Mimir custom action authentication](#mimir-custom-action-authentication)).

## License

This library is licensed under the MIT-0 License. See the [LICENSE](LICENSE) file.
