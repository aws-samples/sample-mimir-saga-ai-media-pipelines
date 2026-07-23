#!/bin/bash
# Rerun timed-out EmbedVideoContent executions with the same input.
# Usage: ./scripts/rerun-timed-out-embeddings.sh

set -e

AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
STATE_MACHINE_ARN="arn:aws:states:us-east-1:${AWS_ACCOUNT_ID}:stateMachine:EmbedVideoContent"

# Replace these with your own timed-out execution ARNs
EXECUTIONS=(
  "arn:aws:states:us-east-1:${AWS_ACCOUNT_ID}:execution:EmbedVideoContent:EXECUTION_ID_1"
  "arn:aws:states:us-east-1:${AWS_ACCOUNT_ID}:execution:EmbedVideoContent:EXECUTION_ID_2"
)

for EXEC_ARN in "${EXECUTIONS[@]}"; do
  echo "Getting input from: $EXEC_ARN"
  INPUT=$(aws stepfunctions describe-execution --execution-arn "$EXEC_ARN" --query "input" --output text)

  NEW_NAME="retry-$(date +%s)-$(echo $EXEC_ARN | grep -o '[^:]*$' | cut -c1-8)"
  echo "Starting new execution: $NEW_NAME"

  aws stepfunctions start-execution \
    --state-machine-arn "$STATE_MACHINE_ARN" \
    --name "$NEW_NAME" \
    --input "$INPUT"

  echo "Started: $NEW_NAME"
  echo ""
done

echo "All 4 executions restarted."
