const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');

const secretsClient = new SecretsManagerClient();
let cachedMimirApiKey = null;

async function getMimirApiKey() {
  if (cachedMimirApiKey) return cachedMimirApiKey;
  
  const response = await secretsClient.send(
    new GetSecretValueCommand({ SecretId: process.env.MIMIR_API_KEY_SECRET_ARN })
  );
  cachedMimirApiKey = response.SecretString;
  return cachedMimirApiKey;
}

async function getMimirItemDetails(apiKey, itemId, mimirInstance = 'us') {
  const url = `https://${mimirInstance}.mjoll.no/api/v1/items/${itemId}`;
  
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Accept': 'application/json',
      'x-mimir-cognito-id-token': `Bearer ${apiKey}`
    }
  });
  
  if (!response.ok) {
    throw new Error(`Mimir API error: ${response.status} ${response.statusText}`);
  }
  
  return await response.json();
}

exports.handler = async (event) => {
  console.log('Getting Mimir details for item:', event.id);
  
  try {
    const mimirApiKey = event.mimirApiKey || await getMimirApiKey();
    const details = await getMimirItemDetails(mimirApiKey, event.id);
    
    console.log('Mimir API response:', JSON.stringify(details, null, 2));
    
    return {
      ...event,
      proxyUrl: details.proxy,
      highRes: details.highRes,
      highResUrl: details.highRes,
      thumbnailUrl: details.thumbnail,
      ingestSourceS3Bucket: details.ingestSourceS3Bucket || '',
      ingestSourceFullPath: details.ingestSourceFullPath || '',
      sourceFileLocation: details.sourceFileLocation || details.source?.scheme || '',
      mimirDetails: details
    };
  } catch (error) {
    console.error('Error getting Mimir details:', error);
    throw error;
  }
};
