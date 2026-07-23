const { BedrockRuntimeClient, StartAsyncInvokeCommand, GetAsyncInvokeCommand } = require('@aws-sdk/client-bedrock-runtime');
const { S3Client, HeadObjectCommand } = require('@aws-sdk/client-s3');

const bedrockClient = new BedrockRuntimeClient();
const s3Client = new S3Client();

/**
 * Builds the Bedrock startAsyncInvoke request parameters for Nova multimodal embeddings.
 * Exported for testability.
 */
function buildStartAsyncInvokeParams(s3Uri, itemId, bucket) {
  const body = {
    taskType: 'SEGMENTED_EMBEDDING',
    segmentedEmbeddingParams: {
      embeddingPurpose: 'GENERIC_INDEX',
      embeddingDimension: 1024,
      video: {
        format: 'mp4',
        embeddingMode: 'AUDIO_VIDEO_COMBINED',
        source: { s3Location: { uri: s3Uri } },
        segmentationConfig: { durationSeconds: 15 },
      },
    },
  };

  return {
    modelId: 'amazon.nova-2-multimodal-embeddings-v1:0',
    modelInput: body,
    outputDataConfig: {
      s3OutputDataConfig: {
        s3Uri: `s3://${bucket}/embeddings/${itemId}/`,
      },
    },
  };
}

async function handleStart(event) {
  const { s3Uri, itemId } = event;
  const bucket = process.env.VIDEO_STAGING_BUCKET;

  if (!bucket) {
    throw new Error('VIDEO_STAGING_BUCKET environment variable is not set');
  }
  if (!s3Uri) {
    throw new Error('s3Uri is required for start action');
  }
  if (!itemId) {
    throw new Error('itemId is required for start action');
  }

  console.log(`Starting async embedding for item ${itemId} from ${s3Uri}`);

  const params = buildStartAsyncInvokeParams(s3Uri, itemId, bucket);

  const response = await bedrockClient.send(new StartAsyncInvokeCommand(params));

  console.log(`Async invoke started: ${response.invocationArn}`);

  return {
    invocationArn: response.invocationArn,
    status: 'InProgress',
  };
}

async function handlePoll(event) {
  const { invocationArn } = event;

  if (!invocationArn) {
    throw new Error('invocationArn is required for poll action');
  }

  console.log(`Polling async invoke status: ${invocationArn}`);

  const response = await bedrockClient.send(
    new GetAsyncInvokeCommand({ invocationArn })
  );

  const result = {
    invocationArn: response.invocationArn,
    status: response.status,
  };

  if (response.outputDataConfig?.s3OutputDataConfig?.s3Uri) {
    result.outputS3Uri = response.outputDataConfig.s3OutputDataConfig.s3Uri;
  }

  console.log(`Async invoke status: ${response.status}`);

  return result;
}

/**
 * Parses an S3 URI into bucket and key.
 */
function parseS3Uri(s3Uri) {
  const match = s3Uri.match(/^s3:\/\/([^/]+)\/(.+)$/);
  if (!match) return null;
  return { bucket: match[1], key: match[2] };
}

/**
 * Checks if we have read access to an S3 URI by performing a HeadObject call.
 * Returns { accessible: true, s3Uri } if accessible, { accessible: false } otherwise.
 */
async function handleCheckAccess(event) {
  const { s3Uri } = event;

  if (!s3Uri) {
    return { accessible: false, reason: 'no s3Uri provided' };
  }

  const parsed = parseS3Uri(s3Uri);
  if (!parsed) {
    return { accessible: false, reason: 'invalid s3Uri format' };
  }

  try {
    await s3Client.send(new HeadObjectCommand({
      Bucket: parsed.bucket,
      Key: parsed.key,
    }));
    console.log(`S3 access confirmed: ${s3Uri}`);
    return { accessible: true, s3Uri };
  } catch (err) {
    console.log(`S3 access denied for ${s3Uri}: ${err.name} - ${err.message}`);
    return { accessible: false, reason: err.name };
  }
}

exports.handler = async (event) => {
  const { action } = event;

  if (action === 'start') {
    return handleStart(event);
  } else if (action === 'poll') {
    return handlePoll(event);
  } else if (action === 'check-access') {
    return handleCheckAccess(event);
  } else {
    throw new Error(`Unknown action: ${action}. Expected "start", "poll", or "check-access".`);
  }
};

// Export for testing
exports.buildStartAsyncInvokeParams = buildStartAsyncInvokeParams;
exports.parseS3Uri = parseS3Uri;
