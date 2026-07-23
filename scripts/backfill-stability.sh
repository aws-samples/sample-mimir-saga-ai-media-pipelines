#!/bin/bash
# Backfills camera-stability analysis for already-ingested clips.
# For each item id: finds the staged video in the staging bucket and invokes
# msai-stability-analysis-handler async. Poll for results with -w.
set -e

# Derive account/region-specific names (override via env if needed)
REGION="${AWS_REGION:-$(aws configure get region || echo us-east-1)}"
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
PREFIX="${RESOURCE_PREFIX:-msai}"
BUCKET="${STAGING_BUCKET:-${PREFIX}-video-embedding-staging-${ACCOUNT}-${REGION}}"
FN="${PREFIX}-stability-analysis-handler"

if [ "$1" == "-w" ]; then
  shift
  echo "Waiting for stability files..."
  for id in "$@"; do
    if aws s3 ls "s3://$BUCKET/stability/$id/segments.json" --region $REGION >/dev/null 2>&1; then
      echo "  DONE  $id"
    else
      echo "  ....  $id"
    fi
  done
  exit 0
fi

for id in "$@"; do
  key=$(aws s3 ls "s3://$BUCKET/videos/$id/" --region $REGION 2>/dev/null | head -1 | awk '{print $4}')
  if [ -z "$key" ]; then
    echo "SKIP  $id (no staged video)"
    continue
  fi
  printf '{"action":"analyze","itemId":"%s","s3Uri":"s3://%s/videos/%s/%s"}' \
    "$id" "$BUCKET" "$id" "$key" > /tmp/sb_payload.json
  aws lambda invoke --function-name $FN --region $REGION \
    --invocation-type Event \
    --cli-binary-format raw-in-base64-out \
    --payload file:///tmp/sb_payload.json /dev/null >/dev/null 2>&1
  echo "SENT  $id (videos/$id/$key)"
done
