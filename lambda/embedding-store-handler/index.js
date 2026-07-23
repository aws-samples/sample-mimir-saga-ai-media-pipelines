const { S3Client, ListObjectsV2Command, GetObjectCommand } = require('@aws-sdk/client-s3');
const { S3VectorsClient, PutVectorsCommand } = require('@aws-sdk/client-s3vectors');

const s3Client = new S3Client();
const s3VectorsClient = new S3VectorsClient();

/**
 * Parses an S3 URI into bucket and key components.
 */
function parseS3Uri(s3Uri) {
  const match = s3Uri.match(/^s3:\/\/([^/]+)\/(.+)$/);
  if (!match) {
    throw new Error(`Invalid S3 URI: ${s3Uri}`);
  }
  return { bucket: match[1], prefix: match[2] };
}

/**
 * Parses JSONL content into an array of segment objects.
 * Each line is expected to be a JSON object with embedding, startTimeMs, endTimeMs.
 */
function parseJsonl(content) {
  return content
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

/**
 * Builds the vectors array for the PutVectors API call.
 * Nova JSONL format: { embedding, status, segmentMetadata: { segmentIndex, segmentStartSeconds, segmentEndSeconds } }
 */
function buildVectors(segments, itemId, title, createdAt) {
  return segments
    .filter((segment) => segment.status === 'SUCCESS')
    .map((segment) => {
      const meta = segment.segmentMetadata || {};
      return {
        key: `${itemId}/segment-${meta.segmentIndex ?? 0}`,
        data: { float32: segment.embedding },
        metadata: {
          itemId,
          title,
          segmentIndex: meta.segmentIndex ?? 0,
          startTimeSeconds: meta.segmentStartSeconds ?? 0,
          endTimeSeconds: meta.segmentEndSeconds ?? 0,
          createdAt,
        },
      };
    });
}

exports.handler = async (event) => {
  const { outputS3Uri, itemId, title } = event;
  const vectorBucketName = process.env.VECTOR_BUCKET_NAME;
  const indexName = process.env.VECTOR_INDEX_NAME;

  if (!vectorBucketName) {
    throw new Error('VECTOR_BUCKET_NAME environment variable is not set');
  }
  if (!indexName) {
    throw new Error('VECTOR_INDEX_NAME environment variable is not set');
  }
  if (!outputS3Uri) {
    throw new Error('outputS3Uri is required');
  }
  if (!itemId) {
    throw new Error('itemId is required');
  }

  console.log(`Storing embeddings for item ${itemId} from ${outputS3Uri}`);

  // Parse the output S3 URI to get bucket and prefix
  const { bucket, prefix } = parseS3Uri(outputS3Uri);

  // List objects under the output prefix to find the JSONL file
  const listResponse = await s3Client.send(
    new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix })
  );

  const jsonlObject = (listResponse.Contents || []).find((obj) =>
    obj.Key.endsWith('.jsonl')
  );

  if (!jsonlObject) {
    throw new Error(`No JSONL file found under ${outputS3Uri}`);
  }

  console.log(`Found JSONL file: ${jsonlObject.Key}`);

  // Read and parse the JSONL file
  const getResponse = await s3Client.send(
    new GetObjectCommand({ Bucket: bucket, Key: jsonlObject.Key })
  );
  const content = await getResponse.Body.transformToString();
  const segments = parseJsonl(content);

  console.log(`Parsed ${segments.length} segments`);

  if (segments.length === 0) {
    console.log('No segments found, nothing to store');
    return { vectorsStored: 0, itemId };
  }

  // Build vectors and store them
  const createdAt = new Date().toISOString();
  const vectors = buildVectors(segments, itemId, title || '', createdAt);

  // PutVectors supports up to 500 vectors per call, batch if needed
  const BATCH_SIZE = 500;
  for (let i = 0; i < vectors.length; i += BATCH_SIZE) {
    const batch = vectors.slice(i, i + BATCH_SIZE);
    await s3VectorsClient.send(
      new PutVectorsCommand({
        vectorBucketName,
        indexName,
        vectors: batch,
      })
    );
    console.log(`Stored batch of ${batch.length} vectors (${i + batch.length}/${vectors.length})`);
  }

  console.log(`Successfully stored ${vectors.length} vectors for item ${itemId}`);

  return { vectorsStored: vectors.length, itemId };
};

// Export helpers for testing
exports.parseS3Uri = parseS3Uri;
exports.parseJsonl = parseJsonl;
exports.buildVectors = buildVectors;
