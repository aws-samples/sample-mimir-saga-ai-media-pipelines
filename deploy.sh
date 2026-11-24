#!/bin/bash

set -e  # Exit on any error

echo "🚀 Starting deployment process..."

# Check for parameters.json, copy from template if not present
if [[ ! -f "parameters.json" ]]; then
  if [[ -f "parameters.example.json" ]]; then
    echo "⚠️  parameters.json not found. Copying from parameters.example.json..."
    cp parameters.example.json parameters.json
    echo "✅ Created parameters.json from template"
    echo "⚠️  Review parameters.json and update values for your environment before continuing."
    echo ""
    read -p "Press Enter to continue after reviewing parameters.json, or Ctrl+C to abort..."
  else
    echo "❌ parameters.json not found and no parameters.example.json template available!"
    exit 1
  fi
fi

# Install root dependencies
echo "📦 Installing root dependencies..."
npm install

# Install Lambda function dependencies (in parallel so re-runs are fast).
# npm install is idempotent — it's a no-op when deps are current, and picks up
# any package.json changes. Running them concurrently avoids the slow sequential loop.
echo "📦 Installing Lambda function dependencies..."
install_pids=()
for lambda_dir in lambda/*/; do
  if [ -f "${lambda_dir}package.json" ]; then
    (cd "${lambda_dir}" && npm install --silent) &
    install_pids+=($!)
  fi
done
if [ ${#install_pids[@]} -gt 0 ]; then
  wait "${install_pids[@]}"
  echo "  ✅ Lambda dependencies installed (${#install_pids[@]} functions)"
fi

# Download FFmpeg static binaries for Lambda layer (if not already present)
echo "🎬 Checking FFmpeg Lambda layer..."
if [ ! -f "layers/ffmpeg/bin/ffmpeg" ] || [ ! -f "layers/ffmpeg/bin/ffprobe" ]; then
  echo "  Downloading FFmpeg static build (~150MB)..."
  mkdir -p layers/ffmpeg/bin
  wget -q https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz -O /tmp/ffmpeg-static.tar.xz
  tar -xf /tmp/ffmpeg-static.tar.xz -C /tmp
  cp /tmp/ffmpeg-*-amd64-static/ffmpeg layers/ffmpeg/bin/ffmpeg
  cp /tmp/ffmpeg-*-amd64-static/ffprobe layers/ffmpeg/bin/ffprobe
  chmod +x layers/ffmpeg/bin/ffmpeg layers/ffmpeg/bin/ffprobe
  rm -rf /tmp/ffmpeg-*-amd64-static /tmp/ffmpeg-static.tar.xz
  echo "  ✅ FFmpeg layer ready"
else
  echo "  ✅ FFmpeg layer already present"
fi

# Check if CDK is bootstrapped
echo "🔍 Checking CDK bootstrap status..."
REGION=$(aws configure get region || echo "us-east-1")
if ! aws ssm get-parameter --name "/cdk-bootstrap/hnb659fds/version" --region "$REGION" >/dev/null 2>&1 && \
   ! aws cloudformation describe-stacks --stack-name CDKToolkit --region "$REGION" >/dev/null 2>&1; then
  echo "🔧 CDK not bootstrapped. Bootstrapping now..."
  npx cdk bootstrap
else
  echo "✅ CDK already bootstrapped"
fi

# Build CDK
echo "🔨 Building CDK..."
# Clear CDK output cache to ensure fresh asset hashing (prevents stale agent container images)
rm -rf cdk.out
npm run build

# mimir-handler only accepts tokens from MimirAllowedIssuer. When parameters.json
# leaves it (or MimirAllowedAudience) blank, read both from Mimir's public config
# (https://<MimirInstance>.mjoll.no/api/v1) and pass them as CDK context. Explicit
# values win. If the lookup fails the issuer stays blank and custom actions fail closed.
MIMIR_AUTH_CONTEXT=()
while IFS= read -r ctx; do
  [ -n "$ctx" ] && MIMIR_AUTH_CONTEXT+=(-c "$ctx")
done < <(node scripts/derive-mimir-auth.js parameters.json)

# Configure MediaConvert queue in us-west-2 for Smart Cropping (Elemental Inference)
echo "🎬 Configuring MediaConvert Smart Cropping queue (us-west-2)..."
MC_ENDPOINT=$(aws mediaconvert describe-endpoints --region us-west-2 --query "Endpoints[0].Url" --output text 2>/dev/null)
if [ -n "$MC_ENDPOINT" ]; then
  CURRENT_FEEDS=$(aws mediaconvert get-queue --region us-west-2 --endpoint-url "$MC_ENDPOINT" --name Default --query "Queue.MaximumConcurrentFeeds" --output text 2>/dev/null)
  if [ "$CURRENT_FEEDS" = "None" ] || [ "$CURRENT_FEEDS" = "0" ] || [ -z "$CURRENT_FEEDS" ]; then
    echo "  Setting MaximumConcurrentFeeds=2 on Default queue..."
    aws mediaconvert update-queue --region us-west-2 --endpoint-url "$MC_ENDPOINT" --name Default --maximum-concurrent-feeds 2 >/dev/null
    echo "  ✅ MediaConvert queue configured"
  else
    echo "  ✅ MediaConvert queue already configured (feeds: $CURRENT_FEEDS)"
  fi
else
  echo "  ⚠️  Could not get MediaConvert endpoint in us-west-2. Smart Cropping may not work."
fi

# Read stack prefix from cdk.json productName.
# Acronym rule must match createNamingConventions() in bin/app.ts:
# keep all letters of already-uppercase words (e.g. "AI"), else take the first letter.
# "Mimir Saga AI" -> "MSAI"
STACK_PREFIX=$(node -p "const n = JSON.parse(require('fs').readFileSync('cdk.json')).context.productName || 'Mimir Saga AI'; n.trim().split(/\s+/).map(w => w === w.toUpperCase() ? w : w[0].toUpperCase()).join('')" 2>/dev/null)
echo "📋 Stack prefix: ${STACK_PREFIX}"

# Deploy stacks in dependency order
echo "🚀 Deploying stacks in dependency order..."
echo "📦 Deploying ${STACK_PREFIX}-ObservabilityStack..."
npx cdk deploy "${STACK_PREFIX}-ObservabilityStack" --require-approval never "${MIMIR_AUTH_CONTEXT[@]}"

echo "📦 Deploying ${STACK_PREFIX}-CoreStack (creates secrets and SSM parameters)..."
# The API key secrets are created without a value, so the keys never land in a
# CloudFormation template. scripts/sync-api-key-secrets.js writes them from
# parameters.json. For an existing stack, sync before the deploy too, so the
# Mimir registration custom resource runs with the current key.
sync_api_keys() { AWS_REGION="${AWS_REGION:-$REGION}" node scripts/sync-api-key-secrets.js "$@"; }
CORE_STACK="${STACK_PREFIX}-CoreStack"
if aws cloudformation describe-stacks --stack-name "$CORE_STACK" >/dev/null 2>&1; then
  CORE_STACK_EXISTED=true
  echo "🔑 Syncing API keys into ${CORE_STACK} secrets (pre-deploy)..."
  sync_api_keys "$CORE_STACK"
else
  CORE_STACK_EXISTED=false
fi
npx cdk deploy "$CORE_STACK" --require-approval never "${MIMIR_AUTH_CONTEXT[@]}"
echo "🔑 Syncing API keys into ${CORE_STACK} secrets..."
sync_api_keys "$CORE_STACK"
if [ "$CORE_STACK_EXISTED" = false ]; then
  # On a first deploy the secrets were empty while the Mimir registration custom
  # resource ran, so it skipped registration. Deploy once more to register.
  echo "📦 Re-deploying ${CORE_STACK} to register Mimir integrations with the API key..."
  npx cdk deploy "$CORE_STACK" --require-approval never "${MIMIR_AUTH_CONTEXT[@]}"
fi

echo "📦 Deploying ${STACK_PREFIX}-AgentCoreStack (reads secret ARNs from SSM)..."
npx cdk deploy "${STACK_PREFIX}-AgentCoreStack" --require-approval never "${MIMIR_AUTH_CONTEXT[@]}"

echo "📦 Deploying ${STACK_PREFIX}-SagaFeedsStack (imports Mimir API key from SSM)..."
npx cdk deploy "${STACK_PREFIX}-SagaFeedsStack" --require-approval never "${MIMIR_AUTH_CONTEXT[@]}"
echo "🔑 Syncing Saga API key and URL into ${STACK_PREFIX}-SagaFeedsStack secrets..."
sync_api_keys "${STACK_PREFIX}-SagaFeedsStack"

echo "📦 Deploying ${STACK_PREFIX}-McpGatewayStack (AgentCore Gateway + Cognito auth)..."
echo "⏳ Waiting for AgentCore runtimes to warm up..."
sleep 30
npx cdk deploy "${STACK_PREFIX}-McpGatewayStack" --require-approval never "${MIMIR_AUTH_CONTEXT[@]}"

echo "✅ Deployment complete!"
