const { BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');
const { S3VectorsClient, QueryVectorsCommand, ListVectorsCommand } = require('@aws-sdk/client-s3vectors');

const bedrockClient = new BedrockRuntimeClient();
const s3VectorsClient = new S3VectorsClient();

const VECTOR_BUCKET_NAME = `video-embeddings-${process.env.AWS_ACCOUNT || 'YOUR_ACCOUNT_ID'}`;
const INDEX_NAME = 'video-embeddings-index';

async function embedText(text) {
  const response = await bedrockClient.send(new InvokeModelCommand({
    modelId: 'amazon.nova-2-multimodal-embeddings-v1:0',
    contentType: 'application/json',
    accept: 'application/json',
    body: JSON.stringify({
      taskType: 'SINGLE_EMBEDDING',
      singleEmbeddingParams: {
        embeddingPurpose: 'VIDEO_RETRIEVAL',
        embeddingDimension: 1024,
        text: {
          truncationMode: 'END',
          value: text,
        },
      },
    }),
  }));

  const result = JSON.parse(new TextDecoder().decode(response.body));
  return result.embeddings[0].embedding;
}

async function listStoredVectors() {
  console.log('\n=== Stored Vectors ===');
  const response = await s3VectorsClient.send(new ListVectorsCommand({
    vectorBucketName: VECTOR_BUCKET_NAME,
    indexName: INDEX_NAME,
  }));

  if (!response.vectors || response.vectors.length === 0) {
    console.log('No vectors found.');
    return;
  }

  console.log(`Found ${response.vectors.length} vectors:`);
  for (const v of response.vectors) {
    console.log(`  ${v.key} - metadata:`, JSON.stringify(v.metadata));
  }
}

async function searchByText(query) {
  console.log(`\n=== Searching: "${query}" ===`);
  console.log('Embedding query text...');
  const queryEmbedding = await embedText(query);
  console.log(`Got ${queryEmbedding.length}-dim embedding`);

  console.log('Querying vector index...');
  const response = await s3VectorsClient.send(new QueryVectorsCommand({
    vectorBucketName: VECTOR_BUCKET_NAME,
    indexName: INDEX_NAME,
    queryVector: { float32: queryEmbedding },
    topK: 5,
    returnMetadata: true,
    returnDistance: true,
  }));

  if (!response.vectors || response.vectors.length === 0) {
    console.log('No results found.');
    return;
  }

  console.log(`\nTop ${response.vectors.length} results:`);
  for (const result of response.vectors) {
    console.log(`  Score: ${result.distance?.toFixed(4)} | Key: ${result.key}`);
    if (result.metadata) {
      console.log(`    itemId: ${result.metadata.itemId}, segment: ${result.metadata.segmentIndex}`);
      console.log(`    time: ${result.metadata.startTimeSeconds}s - ${result.metadata.endTimeSeconds}s`);
    }
  }
}

async function main() {
  const command = process.argv[2] || 'list';
  const query = process.argv.slice(3).join(' ') || 'news broadcast';

  if (command === 'list') {
    await listStoredVectors();
  } else if (command === 'search') {
    await searchByText(query);
  } else {
    console.log('Usage:');
    console.log('  node test-vector-search.js list              # List stored vectors');
    console.log('  node test-vector-search.js search <query>    # Search by text');
  }
}

main().catch(console.error);
