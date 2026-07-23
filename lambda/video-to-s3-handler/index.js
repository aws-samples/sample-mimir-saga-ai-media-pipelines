const { S3Client } = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');

const s3Client = new S3Client();

exports.handler = async (event) => {
  const { proxyUrl, id: itemId } = event;
  const bucket = process.env.VIDEO_STAGING_BUCKET;

  if (!bucket) {
    throw new Error('VIDEO_STAGING_BUCKET environment variable is not set');
  }
  if (!proxyUrl) {
    throw new Error('proxyUrl is required');
  }
  if (!itemId) {
    throw new Error('itemId (id) is required');
  }

  console.log(`Streaming video for item ${itemId} from proxy URL to S3`);

  // Fetch the video stream from the proxy URL
  let response;
  try {
    response = await fetch(proxyUrl);
  } catch (err) {
    throw new Error(`Failed to fetch video: ${err.message}`);
  }

  if (!response.ok) {
    throw new Error(`Video download failed: HTTP ${response.status} ${response.statusText}`);
  }

  // Generate S3 key with timestamp
  const timestamp = Date.now();
  const key = `videos/${itemId}/${timestamp}.mp4`;

  // Stream the response body directly to S3 via multipart upload
  try {
    const upload = new Upload({
      client: s3Client,
      params: {
        Bucket: bucket,
        Key: key,
        Body: response.body,
        ContentType: 'video/mp4',
      },
    });

    await upload.done();
  } catch (err) {
    throw new Error(`S3 upload failed: ${err.name} - ${err.message}`);
  }

  const s3Uri = `s3://${bucket}/${key}`;
  console.log(`Video staged to ${s3Uri}`);

  return { s3Uri, bucket, key };
};
