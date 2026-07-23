const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
const { S3Client, HeadObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const crypto = require('crypto');

const secretsClient = new SecretsManagerClient();
const s3Client = new S3Client();

let cachedMimirApiKey = null;

async function getMimirApiKey() {
  if (cachedMimirApiKey) return cachedMimirApiKey;
  
  const response = await secretsClient.send(
    new GetSecretValueCommand({ SecretId: process.env.MIMIR_API_KEY_SECRET_ARN })
  );
  cachedMimirApiKey = response.SecretString;
  return cachedMimirApiKey;
}

async function createOrGetFolder(apiKey, folderPath, mimirInstance = 'us') {
  const url = `https://${mimirInstance}.mjoll.no/api/v1/folders/path`;
  
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'x-mimir-cognito-id-token': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      path: `/${folderPath}/`
    })
  });
  
  if (!response.ok) {
    throw new Error(`Mimir create folder error: ${response.status} ${response.statusText}`);
  }
  
  const result = await response.json();
  // The API returns an array of objects with path segments and their IDs
  // We want the last one which is our target folder
  const lastFolder = result[result.length - 1];
  const folderId = Object.values(lastFolder)[0];
  
  return folderId;
}

async function createMimirItem(apiKey, title, provider, mimirInstance = 'us') {
  // Get or create the folder for this provider
  const folderPath = `03_${provider.toUpperCase()}`;
  const folderId = await createOrGetFolder(apiKey, folderPath, mimirInstance);
  
  const url = `https://${mimirInstance}.mjoll.no/api/v1/items`;
  
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'x-mimir-cognito-id-token': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      title: title,
      itemType: 'video',
      folderParents: [folderId],
      // Restrict visibility only when a group mapping is configured;
      // otherwise the item uses the tenant's default visibility.
      ...(getVisibilityGroup(provider)
        ? { visibleTo: { level: 'selected_groups', groups: [getVisibilityGroup(provider)] } }
        : {}),
    })
  });
  
  if (!response.ok) {
    throw new Error(`Mimir create item error: ${response.status} ${response.statusText}`);
  }
  
  return await response.json();
}

async function uploadVideoToMimirFolder(apiKey, title, bucket, key, provider, mimirInstance = 'us') {
  // Create new Mimir item
  const newItem = await createMimirItem(apiKey, title, provider, mimirInstance);
  
  // Get file size
  const headResponse = await s3Client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
  const fileSize = headResponse.ContentLength;
  
  // Get upload lock
  const uploadLockUrl = `https://${mimirInstance}.mjoll.no/api/v1/items/${newItem.id}/upload`;
  const uploadLockBody = {
    lockOwnerInstanceId: crypto.randomUUID(),
    fileSize: fileSize,
    fileName: key.split('/').pop()
  };
  
  console.log('Upload lock request:', {
    url: uploadLockUrl,
    body: uploadLockBody
  });
  
  const lockResponse = await fetch(uploadLockUrl, {
    method: 'PUT',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'x-mimir-cognito-id-token': `Bearer ${apiKey}`
    },
    body: JSON.stringify(uploadLockBody)
  });
  
  if (!lockResponse.ok) {
    throw new Error(`Upload lock error: ${lockResponse.status} ${lockResponse.statusText}`);
  }
  
  const { uploadSignedUrl } = await lockResponse.json();
  
  // Stream from S3 to Mimir
  const s3Response = await s3Client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  
  const uploadResponse = await fetch(uploadSignedUrl, {
    method: 'PUT',
    body: s3Response.Body,
    duplex: 'half',
    headers: {
      'Content-Length': fileSize.toString()
    }
  });
  
  if (!uploadResponse.ok) {
    throw new Error(`Upload error: ${uploadResponse.status} ${uploadResponse.statusText}`);
  }

  return newItem;
}

/**
 * Maps a content provider to a Mimir visibility group, driven by the
 * VISIBILITY_GROUP_MAP environment variable — a JSON object of provider name
 * to group id, e.g. {"ABC": "mytenant:GROUP-ABC", "*": "mytenant:GROUP-DEFAULT"}.
 * "*" is the fallback for unmapped providers. Returns null when no mapping is
 * configured (item visibility is then left to the tenant default).
 */
function getVisibilityGroup(provider) {
  let map = {};
  try {
    map = JSON.parse(process.env.VISIBILITY_GROUP_MAP || '{}');
  } catch {
    console.warn('VISIBILITY_GROUP_MAP is not valid JSON — ignoring');
    return null;
  }
  return map[(provider || '').toUpperCase()] || map['*'] || null;
}

function getContentSourceValue(provider) {
  // Map provider to Content_Source tree choice values
  // Customize these categories based on your organization's content source taxonomy
  const providerMap = {
    'ABC': ['External - Network', 'ABC'],
    'FOX': ['External - Network', 'FOX'],
    'CBS': ['External - Network', 'CBS'],
    'CNN': ['External - Network', 'CNN'],
    'NBC': ['External - Network', 'NBC'],
    'AP': ['External - Network', 'AP'],
    'GETTY': ['External - Network', 'GETTY'],
    'STACKLA': ['External - Network', 'STACKLA']
  };
  
  const upperProvider = provider.toUpperCase();
  return providerMap[upperProvider] || ['External - Network', 'OTHER'];
}

async function updateMimirItemMetadata(apiKey, itemId, metadataFields, mimirInstance = 'us') {
  const url = `https://${mimirInstance}.mjoll.no/api/v1/itemMetadata/${itemId}`;
  
  const response = await fetch(url, {
    method: 'PATCH',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'x-mimir-cognito-id-token': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      metadataDelta: {
        formId: 'default',
        formData: metadataFields
      }
    })
  });
  
  if (!response.ok) {
    throw new Error(`Mimir update metadata error: ${response.status} ${response.statusText}`);
  }
  
  return await response.json();
}

async function createMimirRelation(apiKey, itemId, relatedItemId, relationType = 'related', mimirInstance = 'us') {
  const url = `https://${mimirInstance}.mjoll.no/api/v1/items/${itemId}/relations/${relationType}`;
  
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'x-mimir-cognito-id-token': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      relatedItemId: relatedItemId
    })
  });
  
  if (!response.ok) {
    throw new Error(`Mimir create relation error: ${response.status} ${response.statusText}`);
  }
  
  return await response.json();
}

async function uploadVideoToMimirItem(apiKey, itemId, bucket, key, mimirInstance = 'us') {
  // Get file size
  const headResponse = await s3Client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
  const fileSize = headResponse.ContentLength;
  
  // Get upload lock
  const uploadLockUrl = `https://${mimirInstance}.mjoll.no/api/v1/items/${itemId}/upload`;
  const lockResponse = await fetch(uploadLockUrl, {
    method: 'PUT',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'x-mimir-cognito-id-token': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      fileSize: fileSize,
      originalFileName: key.split('/').pop()
    })
  });
  
  if (!lockResponse.ok) {
    throw new Error(`Upload lock error: ${lockResponse.status} ${lockResponse.statusText}`);
  }
  
  const { uploadSignedUrl } = await lockResponse.json();
  
  // Stream from S3 to Mimir
  const s3Response = await s3Client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  
  const uploadResponse = await fetch(uploadSignedUrl, {
    method: 'PUT',
    body: s3Response.Body,
    duplex: 'half',
    headers: {
      'Content-Length': fileSize.toString()
    }
  });
  
  if (!uploadResponse.ok) {
    throw new Error(`Upload error: ${uploadResponse.status} ${uploadResponse.statusText}`);
  }
}

async function checkS3ObjectExists(bucket, key) {
  try {
    await s3Client.send(new HeadObjectCommand({
      Bucket: bucket,
      Key: key
    }));
    return true;
  } catch (error) {
    if (error.name === 'NotFound') {
      return false;
    }
    throw error;
  }
}

exports.handler = async (event) => {
  console.log('Creating Mimir asset:', JSON.stringify(event, null, 2));
  
  try {
    // For Saga feeds workflow, extract data from the event
    const { feedData, mappedFeedData } = event;
    
    if (!feedData || !feedData.actualMp4Key) {
      throw new Error('No video file found in feed data');
    }
    
    // Get provider from mapped feed data or default to ABC
    const provider = (mappedFeedData?.provider || 'ABC').toUpperCase();
    const title = mappedFeedData?.slugline || mappedFeedData?.headline || feedData.title || mappedFeedData?.fileName || 'Saga Feed Video';
    
    // Check if the video exists in S3
    const bucketName = feedData.destinationBucket;
    const videoKey = feedData.actualMp4Key;
    const objectExists = await checkS3ObjectExists(bucketName, videoKey);
    
    if (!objectExists) {
      throw new Error(`Video not found in S3: ${videoKey}`);
    }
    
    // Get Mimir API key from Secrets Manager
    const apiKey = await getMimirApiKey();
    
    // Upload video to Mimir in provider-specific folder
    const newItem = await uploadVideoToMimirFolder(apiKey, title, bucketName, videoKey, provider);
    
    // Update metadata with Content_Source
    const contentSourceValue = getContentSourceValue(provider);
    await updateMimirItemMetadata(apiKey, newItem.id, {
      Content_Source: contentSourceValue
    });
    
    console.log(`Created new Mimir item: ${newItem.id} in folder 03_${provider} with Content_Source: ${JSON.stringify(contentSourceValue)}`);
    
    return {
      ...event,
      mimirItemId: newItem.id,
      mimirFolderPath: `03_${provider}`,
      mimirUploadStatus: 'success'
    };
    
  } catch (error) {
    console.error('Error creating Mimir asset:', error);
    throw error;
  }
};
