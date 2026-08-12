/**
 * Vertical Reframe Handler
 * 
 * Creates a MediaConvert job with Smart Cropping (Elemental Inference) to
 * convert landscape video to vertical (9:16) format.
 * 
 * MediaConvert with Smart Cropping is only available in us-west-2.
 */

const { MediaConvertClient, CreateJobCommand, GetJobCommand } = require('@aws-sdk/client-mediaconvert');
const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
const { S3Client, PutObjectCommand, HeadObjectCommand, GetObjectCommand, CopyObjectCommand } = require('@aws-sdk/client-s3');

// MediaConvert must run in us-west-2 for Smart Cropping
const MEDIACONVERT_REGION = 'us-west-2';
const mediaConvertClient = new MediaConvertClient({ region: MEDIACONVERT_REGION });
const s3Client = new S3Client();
const secretsClient = new SecretsManagerClient();

const STAGING_BUCKET = process.env.VIDEO_STAGING_BUCKET;
const OUTPUT_BUCKET = process.env.OUTPUT_BUCKET;
const MEDIACONVERT_ROLE_ARN = process.env.MEDIACONVERT_ROLE_ARN;
const MEDIACONVERT_QUEUE_ARN = process.env.MEDIACONVERT_QUEUE_ARN || '';

let cachedMimirApiKey = null;

async function getMimirApiKey() {
  if (cachedMimirApiKey) return cachedMimirApiKey;
  const response = await secretsClient.send(
    new GetSecretValueCommand({ SecretId: process.env.MIMIR_API_KEY_SECRET_ARN })
  );
  cachedMimirApiKey = response.SecretString;
  return cachedMimirApiKey;
}

/**
 * Resolves video to an S3 location. Downloads from Mimir proxy if needed.
 */
async function resolveVideoLocation(itemDetails) {
  const s3Location = itemDetails.mimirDetails?.storage?.s3?.uri
    || itemDetails.mimirDetails?.media?.original?.s3Uri;

  if (s3Location && s3Location.startsWith('s3://')) {
    const parsed = s3Location.replace('s3://', '').split('/');
    const bucket = parsed[0];
    const key = parsed.slice(1).join('/');
    try {
      await s3Client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      console.log(`Video accessible directly at s3://${bucket}/${key}`);
      return { bucket, key, source: 'direct-s3' };
    } catch (err) {
      console.log(`Cannot access s3://${bucket}/${key} (${err.name}), staging from proxy`);
    }
  }

  // Prefer highRes (full resolution) over proxy (720p) for better quality
  // and to avoid overlay size mismatch errors
  const videoUrl = itemDetails.highResUrl || itemDetails.proxyUrl;
  if (!videoUrl) {
    throw new Error('No video URL available');
  }

  console.log('Downloading video from Mimir proxy...');
  const videoResponse = await fetch(videoUrl);
  if (!videoResponse.ok) {
    throw new Error(`Failed to download video: ${videoResponse.status}`);
  }

  const videoBuffer = Buffer.from(await videoResponse.arrayBuffer());
  console.log(`Video downloaded: ${(videoBuffer.byteLength / (1024 * 1024)).toFixed(1)} MB`);

  const key = `vertical-reframe/input/${itemDetails.id}/${Date.now()}.mp4`;
  await s3Client.send(new PutObjectCommand({
    Bucket: STAGING_BUCKET,
    Key: key,
    Body: videoBuffer,
    ContentType: 'video/mp4'
  }));
  console.log(`Video staged to s3://${STAGING_BUCKET}/${key}`);

  return { bucket: STAGING_BUCKET, key, source: 'staged-from-proxy' };
}

/**
 * Derives a clean base filename from a Mimir originalFileName.
 * e.g. 'IMG_0683.MOV' → 'IMG_0683'
 *      'breaking-news.mp4' → 'breaking-news'
 */
function baseFilename(originalFileName) {
  if (!originalFileName) return 'video';
  return originalFileName.replace(/\.[^/.]+$/, '');
}

/**
 * Creates a MediaConvert smart-crop job (pass 1 of 2).
 * Output key: {itemId}/smart-crop/{basename}_{aspect}.mp4
 */
async function createSmartCropJob(inputBucket, inputKey, outputBucket, itemId, originalFileName, aspectRatio = '9:16', fullCanvas = false) {
  const inputS3Uri = `s3://${inputBucket}/${inputKey}`;
  const aspectSuffix = aspectRatio.replace(':', '-');
  const base = baseFilename(originalFileName);

  // MediaConvert output path strategy:
  // Destination is treated as a KEY PREFIX — MediaConvert always appends the container
  // extension (.mp4). So pass the stem without extension as Destination,
  // and compute the actual output URI by appending .mp4 ourselves.
  const outputStem = `s3://${outputBucket}/${itemId}/smart-crop/${base}_${aspectSuffix}`;
  const outputS3Uri = `${outputStem}.mp4`;

  // Two sizing modes:
  //
  // Native (default) — for the standalone Vertical Reframe action: output at the
  // source's native height so smart-crop crops horizontally WITHOUT upscaling.
  // For a 1920x1080 source, 9:16 = 608x1080. Cropping to native height preserves
  // true sharpness (these deliverables intentionally do not upscale).
  //
  // Full canvas — for the Reframe + Graphics action: output at the full social
  // canvas (9:16 = 1080x1920) so the video fills the frame and the full-size
  // motion-graphics overlay composited in pass 2 fits the input. This upscales
  // the crop, which is the expected behavior for social posts (platforms expect
  // 1080x1920 and upscale sub-spec frames on playback anyway).
  const nativeMap = {
    '9:16': { width: 608,  height: 1080 },
    '1:1':  { width: 1080, height: 1080 },
    '4:5':  { width: 864,  height: 1080 },
    '16:9': { width: 1920, height: 1080 },
  };
  const fullCanvasMap = {
    '9:16': { width: 1080, height: 1920 },
    '1:1':  { width: 1080, height: 1080 },
    '4:5':  { width: 1080, height: 1350 },
    '16:9': { width: 1920, height: 1080 },
  };
  const aspectRatioMap = fullCanvas ? fullCanvasMap : nativeMap;
  const dimensions = aspectRatioMap[aspectRatio] || aspectRatioMap['9:16'];
  console.log(`Smart crop ${aspectRatio} (${fullCanvas ? 'full-canvas' : 'native'}): ${dimensions.width}x${dimensions.height} -> ${outputS3Uri}`);

  const jobSettings = {
    Role: MEDIACONVERT_ROLE_ARN,
    Settings: {
      TimecodeConfig: { Source: 'ZEROBASED' },
      Inputs: [{
        FileInput: inputS3Uri,
        TimecodeSource: 'ZEROBASED',
        AudioSelectors: { 'Audio Selector 1': { DefaultSelection: 'DEFAULT' } },
        VideoSelector: {},
      }],
      OutputGroups: [{
        Name: 'File Group',
        OutputGroupSettings: {
          Type: 'FILE_GROUP_SETTINGS',
          FileGroupSettings: { Destination: outputStem },
        },
        Outputs: [{
          ContainerSettings: { Container: 'MP4', Mp4Settings: {} },
          VideoDescription: {
            Width: dimensions.width,
            Height: dimensions.height,
            CodecSettings: {
              Codec: 'H_264',
              H264Settings: {
                RateControlMode: 'QVBR',
                QvbrSettings: { QvbrQualityLevel: 7 },
                MaxBitrate: 8000000,
                FramerateControl: 'INITIALIZE_FROM_SOURCE',
              },
            },
            ScalingBehavior: 'SMART_CROP',
          },
          AudioDescriptions: [{
            CodecSettings: {
              Codec: 'AAC',
              AacSettings: { Bitrate: 128000, CodingMode: 'CODING_MODE_2_0', SampleRate: 48000 },
            },
          }],
        }],
      }],
    },
    UserMetadata: { itemId, workflow: 'smart-crop', aspectRatio },
  };

  if (MEDIACONVERT_QUEUE_ARN) jobSettings.Queue = MEDIACONVERT_QUEUE_ARN;

  console.log('Creating MediaConvert smart-crop job...');
  const response = await mediaConvertClient.send(new CreateJobCommand(jobSettings));
  console.log(`Smart-crop job created: ${response.Job.Id}`);

  return {
    jobId: response.Job.Id,
    status: response.Job.Status,
    outputUri: outputS3Uri,
  };
}

/**
 * Checks the status of a MediaConvert job.
 */
async function checkJobStatus(jobId, itemId, title, outputUri, aspectRatio) {
  const response = await mediaConvertClient.send(new GetJobCommand({ Id: jobId }));
  return {
    jobId: response.Job.Id,
    status: response.Job.Status,
    errorMessage: response.Job.ErrorMessage || null,
    id: itemId,
    title: title,
    outputUri: outputUri,
    aspectRatio: aspectRatio
  };
}

/**
 * Creates a MediaConvert compositing job (pass 2 of 2).
 * Applies a MOV overlay (qtrle+argb) to an already smart-cropped video.
 * Output key: {itemId}/composited/{basename}_{aspect}.mp4
 */
/**
 * Stage a VTT file from a pre-signed URL to S3 so MediaConvert can read it.
 * Returns the S3 URI of the staged VTT, or null if staging fails.
 */
async function stageVttToS3(vttUrl, outputBucket, itemId) {
  if (!vttUrl) return null;
  try {
    const response = await fetch(vttUrl);
    if (!response.ok) {
      console.log(`VTT fetch failed: ${response.status}`);
      return null;
    }
    const vttContent = await response.text();
    if (!vttContent || vttContent.trim().length < 10) {
      console.log('VTT content empty, skipping captions');
      return null;
    }
    const s3Key = `${itemId}/captions/transcript.vtt`;
    await s3Client.send(new PutObjectCommand({
      Bucket: outputBucket,
      Key: s3Key,
      Body: vttContent,
      ContentType: 'text/vtt',
    }));
    const s3Uri = `s3://${outputBucket}/${s3Key}`;
    console.log(`Staged VTT to ${s3Uri} (${vttContent.length} bytes)`);
    return s3Uri;
  } catch (err) {
    console.log(`Failed to stage VTT: ${err.message}`);
    return null;
  }
}

async function createCompositedJob(croppedVideoUri, overlayS3Uri, outputBucket, itemId, originalFileName, aspectRatio, vttS3Uri = null) {
  const aspectSuffix = aspectRatio.replace(':', '-');
  const base = baseFilename(originalFileName);
  // Full output path — Destination is a key prefix, MediaConvert appends .mp4
  const outputStem = `s3://${outputBucket}/${itemId}/composited/${base}_${aspectSuffix}`;
  const outputS3Uri = `${outputStem}.mp4`;

  const aspectRatioMap = {
    '9:16': { width: 1080, height: 1920 },
    '1:1':  { width: 1080, height: 1080 },
    '4:5':  { width: 1080, height: 1350 },
    '16:9': { width: 1920, height: 1080 },
  };
  const dimensions = aspectRatioMap[aspectRatio] || aspectRatioMap['9:16'];
  console.log(`Compositing ${aspectRatio}: overlay=${overlayS3Uri} → ${outputS3Uri}`);

  const jobSettings = {
    Role: MEDIACONVERT_ROLE_ARN,
    Settings: {
      TimecodeConfig: { Source: 'ZEROBASED' },
      MotionImageInserter: {
        Input: overlayS3Uri,
        InsertionMode: 'MOV',
        Offset: { ImageX: 0, ImageY: 0 },
        Playback: 'REPEAT',
      },
      Inputs: [{
        FileInput: croppedVideoUri,
        TimecodeSource: 'ZEROBASED',
        AudioSelectors: { 'Audio Selector 1': { DefaultSelection: 'DEFAULT' } },
        VideoSelector: {},
        // Add WebVTT captions selector if S3 URI provided
        ...(vttS3Uri ? {
          CaptionSelectors: {
            'Captions Selector 1': {
              SourceSettings: {
                SourceType: 'WEBVTT',
                FileSourceSettings: {
                  SourceFile: vttS3Uri,
                  TimeDelta: 0,
                },
              },
            },
          },
        } : {}),
      }],
      OutputGroups: [{
        Name: 'File Group',
        OutputGroupSettings: {
          Type: 'FILE_GROUP_SETTINGS',
          FileGroupSettings: { Destination: outputStem },
        },
        Outputs: [{
          ContainerSettings: { Container: 'MP4', Mp4Settings: {} },
          VideoDescription: {
            Width: dimensions.width,
            Height: dimensions.height,
            CodecSettings: {
              Codec: 'H_264',
              H264Settings: {
                RateControlMode: 'QVBR',
                QvbrSettings: { QvbrQualityLevel: 7 },
                MaxBitrate: 8000000,
                FramerateControl: 'INITIALIZE_FROM_SOURCE',
              },
            },
          },
          AudioDescriptions: [{
            CodecSettings: {
              Codec: 'AAC',
              AacSettings: { Bitrate: 128000, CodingMode: 'CODING_MODE_2_0', SampleRate: 48000 },
            },
          }],
          // Burn-in captions if VTT S3 URI provided
          ...(vttS3Uri ? {
            CaptionDescriptions: [{
              CaptionSelectorName: 'Captions Selector 1',
              DestinationSettings: {
                DestinationType: 'BURN_IN',
                BurninDestinationSettings: {
                  Alignment: 'CENTERED',
                  BackgroundColor: 'NONE',
                  BackgroundOpacity: 0,
                  FontColor: 'WHITE',
                  FontOpacity: 255,
                  FontResolution: 96,
                  FontSize: 28,
                  OutlineColor: 'BLACK',
                  OutlineSize: 3,
                  ShadowColor: 'BLACK',
                  ShadowOpacity: 160,
                  ShadowXOffset: 2,
                  ShadowYOffset: 2,
                  TeletextSpacing: 'AUTO',
                  // Deliberately no XPosition/YPosition. Both are measured in
                  // PIXELS from the top-left of the output frame, not percent.
                  // Omitting them makes MediaConvert place the captions at the
                  // bottom centre (per Alignment above), which is what we want
                  // and stays correct across every output size this function
                  // renders (1080x1920, 1080x1080, 1080x1350, 1920x1080).
                  // Setting YPosition: 85 here previously pinned the captions
                  // 85px from the TOP of the frame, over the location bug.
                  StylePassthrough: 'DISABLED',
                },
              },
            }],
          } : {}),
        }],
      }],
    },
    UserMetadata: { itemId, workflow: 'composited', aspectRatio },
  };

  if (MEDIACONVERT_QUEUE_ARN) jobSettings.Queue = MEDIACONVERT_QUEUE_ARN;

  console.log('Creating MediaConvert compositing job...');
  const response = await mediaConvertClient.send(new CreateJobCommand(jobSettings));
  console.log(`Compositing job created: ${response.Job.Id}`);

  return {
    jobId: response.Job.Id,
    status: response.Job.Status,
    outputUri: outputS3Uri,
  };
}

exports.handler = async (event) => {
  console.log('Vertical reframe handler received:', JSON.stringify(event, null, 2));

  const action = event.action || 'start';

  try {
    if (action === 'start') {
      // Pass 1: Smart crop only — no overlay.
      // Input: full-res source video from Mimir.
      // Output: {itemId}/smart-crop/{basename}_{aspect}.mp4
      const { itemDetails, mimirDetails, aspectRatio } = event;

      if (itemDetails.itemType !== 'video') {
        return { id: itemDetails.id, status: 'skipped', reason: 'Not a video item' };
      }

      const enrichedItemDetails = {
        ...itemDetails,
        mimirDetails: mimirDetails || itemDetails.mimirDetails,
        highResUrl: (mimirDetails || itemDetails.mimirDetails)?.highRes || itemDetails.highResUrl,
        proxyUrl: (mimirDetails || itemDetails.mimirDetails)?.proxy || itemDetails.proxyUrl,
      };

      const videoLocation = await resolveVideoLocation(enrichedItemDetails);
      const originalFileName = (mimirDetails || itemDetails.mimirDetails)?.originalFileName || itemDetails.id;

      const job = await createSmartCropJob(
        videoLocation.bucket,
        videoLocation.key,
        OUTPUT_BUCKET,
        itemDetails.id,
        originalFileName,
        aspectRatio || '9:16',
        event.fullCanvas === true,
      );

      return {
        id: itemDetails.id,
        title: itemDetails.title || (mimirDetails || itemDetails.mimirDetails)?.title || 'Video',
        originalFileName,
        jobId: job.jobId,
        status: job.status,
        outputUri: job.outputUri,
        aspectRatio: aspectRatio || '9:16',
        videoSource: videoLocation.source,
        timestamp: new Date().toISOString(),
      };

    } else if (action === 'start-overlay-only') {
      // Pass 2: Composite MOV overlay onto smart-cropped video.
      // Input: croppedVideoUri (output of pass 1).
      // Overlay: overlayS3Uri — QuickTime MOV (qtrle + argb).
      // Captions: vttUrl (Mimir pre-signed URL) — staged to S3 for MediaConvert.
      // Output: {itemId}/composited/{basename}_{aspect}.mp4
      const { croppedVideoUri, overlayS3Uri, aspectRatio, itemId, originalFileName, vttUrl } = event;

      // Stage VTT from Mimir pre-signed URL to S3 so MediaConvert can read it
      const vttS3Uri = await stageVttToS3(vttUrl, OUTPUT_BUCKET, itemId);

      const job = await createCompositedJob(
        croppedVideoUri,
        overlayS3Uri,
        OUTPUT_BUCKET,
        itemId,
        originalFileName || itemId,
        aspectRatio || '9:16',
        vttS3Uri,
      );

      return {
        id: itemId,
        title: event.title || itemId,
        originalFileName: originalFileName || itemId,
        jobId: job.jobId,
        status: job.status,
        outputUri: job.outputUri,
        aspectRatio: aspectRatio || '9:16',
        timestamp: new Date().toISOString(),
      };

    } else if (action === 'poll') {
      const { jobId, id, title, outputUri, aspectRatio, originalFileName } = event;
      const status = await checkJobStatus(jobId, id, title, outputUri, aspectRatio);
      return { ...status, originalFileName };

    } else if (action === 'upload') {
      // Upload composited video to Mimir as a new item.
      // - Creates a new video item
      // - Uploads the composited MP4 from S3
      // - Relates it to the original item
      // - Adds it to the same story folder as the original (if storyId provided)
      // - Copies metadata from the original
      const { itemId, storyId, outputUri, mimirApiKey, title } = event;
      const apiKey = mimirApiKey || await getMimirApiKey();
      const mimirBaseUrl = process.env.MIMIR_API_BASE || 'https://us.mjoll.no';
      const aspectLabel = event.aspectRatio || '9:16';

      const outputParsed = outputUri.replace('s3://', '').split('/');
      const outputBucket = outputParsed[0];
      const outputKey = outputParsed.slice(1).join('/');
      const outputFilename = outputKey.split('/').pop();

      console.log(`Uploading composited video to Mimir: s3://${outputBucket}/${outputKey}`);

      // Fetch the original item up front to get its authoritative metadata title.
      // We prefer the Mimir metadata title over any filename-derived value so the
      // reframed clip is named "<original title> - <aspect ratio>".
      let originalItem = null;
      try {
        const origResp = await fetch(`${mimirBaseUrl}/api/v1/items/${itemId}`, {
          headers: { 'Accept': 'application/json', 'x-mimir-cognito-id-token': `Bearer ${apiKey}` }
        });
        if (origResp.ok) originalItem = await origResp.json();
      } catch (e) {
        console.warn(`Could not fetch original item title (non-fatal): ${e.message}`);
      }
      const originalTitle =
        originalItem?.metadata?.formData?.default_title ||
        originalItem?.title ||
        title ||
        'Video';
      const reframedTitle = `${originalTitle} - ${aspectLabel}`;
      console.log(`Reframed item title: "${reframedTitle}" (original: "${originalTitle}")`);

      // Step 1: Create new Mimir item
      const createResponse = await fetch(`${mimirBaseUrl}/api/v1/items`, {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          'x-mimir-cognito-id-token': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          title: reframedTitle,
          itemType: 'video'
        })
      });
      if (!createResponse.ok) {
        throw new Error(`Mimir create item failed: ${createResponse.status} ${createResponse.statusText}`);
      }
      const newItem = await createResponse.json();
      console.log(`Created Mimir item: ${newItem.id}`);

      // Step 2: Get file size from S3
      const headResponse = await s3Client.send(new HeadObjectCommand({ Bucket: outputBucket, Key: outputKey }));
      const fileSize = headResponse.ContentLength;

      // Step 3: Get upload lock
      const lockResponse = await fetch(`${mimirBaseUrl}/api/v1/items/${newItem.id}/upload`, {
        method: 'PUT',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          'x-mimir-cognito-id-token': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          lockOwnerInstanceId: crypto.randomUUID(),
          fileSize,
          fileName: outputFilename,
        })
      });
      if (!lockResponse.ok) {
        throw new Error(`Upload lock failed: ${lockResponse.status} ${lockResponse.statusText}`);
      }
      const { uploadSignedUrl } = await lockResponse.json();
      console.log('Got upload signed URL');

      // Step 4: Stream from S3 to Mimir signed URL
      const s3Response = await s3Client.send(new GetObjectCommand({ Bucket: outputBucket, Key: outputKey }));
      const uploadResponse = await fetch(uploadSignedUrl, {
        method: 'PUT',
        body: s3Response.Body,
        duplex: 'half',
        headers: { 'Content-Length': fileSize.toString() }
      });
      if (!uploadResponse.ok) {
        throw new Error(`Upload to Mimir failed: ${uploadResponse.status} ${uploadResponse.statusText}`);
      }
      console.log('Video uploaded to Mimir successfully');

      // Step 5: Relate new item to original
      const relationResponse = await fetch(`${mimirBaseUrl}/api/v1/items/${newItem.id}/relations/related`, {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          'x-mimir-cognito-id-token': `Bearer ${apiKey}`
        },
        body: JSON.stringify({ relatedItemId: itemId })
      });
      if (relationResponse.ok) {
        console.log(`Created relation: ${newItem.id} → ${itemId}`);
      } else {
        console.warn(`Failed to create relation: ${relationResponse.status} ${await relationResponse.text()}`);
      }

      // Step 6: Add to the same story folder as the original (if storyId provided)
      if (storyId) {
        const storyResponse = await fetch(`${mimirBaseUrl}/api/v1/stories/${storyId}/items`, {
          method: 'POST',
          headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json',
            'x-mimir-cognito-id-token': `Bearer ${apiKey}`
          },
          body: JSON.stringify({ itemId: newItem.id })
        });
        if (storyResponse.ok) {
          console.log(`Added ${newItem.id} to story ${storyId}`);
        } else {
          console.warn(`Failed to add to story: ${storyResponse.status} ${await storyResponse.text()}`);
        }
      }

      // Step 7: Copy metadata from the original item (fetched above), setting the
      // title metadata to "<original title> - <aspect ratio>" so it carries the
      // original clip's metadata but is distinguishable from the source.
      try {
        const formData = originalItem?.metadata?.formData;
        const formId = originalItem?.metadata?.formId || 'default';
        if (formData) {
          const copiedFormData = { ...formData };
          if (copiedFormData.default_title !== undefined) {
            copiedFormData.default_title = reframedTitle;
          }
          await fetch(`${mimirBaseUrl}/api/v1/itemMetadata/${newItem.id}`, {
            method: 'PATCH',
            headers: {
              'Accept': 'application/json',
              'Content-Type': 'application/json',
              'x-mimir-cognito-id-token': `Bearer ${apiKey}`
            },
            body: JSON.stringify({ metadataDelta: { formId, formData: copiedFormData } })
          });
          console.log('Copied metadata from original to new item');
        }
      } catch (metaErr) {
        console.warn(`Failed to copy metadata (non-fatal): ${metaErr.message}`);
      }

      return {
        itemId,
        newItemId: newItem.id,
        outputUri,
        status: 'complete',
        timestamp: new Date().toISOString()
      };
    }

  } catch (error) {
    console.error('Error in vertical reframe handler:', error);
    return {
      id: event.itemDetails?.id || event.itemId || 'unknown',
      status: 'error',
      error: true,
      errorMessage: error.message,
      timestamp: new Date().toISOString()
    };
  }
};
