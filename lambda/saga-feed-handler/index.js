const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');

const s3Client = new S3Client();
const secretsClient = new SecretsManagerClient();

let cachedSagaApiKey = null;
let cachedSagaApiUrl = null;

async function getSagaApiKey() {
  if (cachedSagaApiKey) return cachedSagaApiKey;
  
  const response = await secretsClient.send(
    new GetSecretValueCommand({ SecretId: process.env.SAGA_API_KEY_SECRET_ARN })
  );
  cachedSagaApiKey = response.SecretString;
  return cachedSagaApiKey;
}

async function getSagaApiUrl() {
  if (cachedSagaApiUrl) return cachedSagaApiUrl;
  
  const response = await secretsClient.send(
    new GetSecretValueCommand({ SecretId: process.env.SAGA_API_URL_SECRET_ARN })
  );
  cachedSagaApiUrl = response.SecretString;
  return cachedSagaApiUrl;
}

exports.handler = async (event) => {
  console.log('Saga Feed Handler:', JSON.stringify(event, null, 2));
  
  try {
    // Extract mapped feed data and mimir details
    const { mappedFeedData, mimirDetailsResult } = event;
    
    // Use Mimir URLs for video
    let videoSignedUrl = null;
    let thumbnailSignedUrl = null;
    
    if (mimirDetailsResult && mimirDetailsResult.Payload) {
      videoSignedUrl = mimirDetailsResult.Payload.highResUrl;
      thumbnailSignedUrl = mimirDetailsResult.Payload.thumbnailUrl;
    }
    
    // Build Saga feed item from mappedFeedData (DynamoDB attributes)
    const sagaFeedItem = {
      // Required fields - convert DynamoDB format to values
      uri: mappedFeedData.uri?.S || mappedFeedData.uri || 'unknown',
      provider: (mappedFeedData.provider?.S || mappedFeedData.provider || 'ABC').toUpperCase(),
      infosource: mappedFeedData.infosource?.S || mappedFeedData.infosource || 'Pool Feed',
      versioncreated: mappedFeedData.versioncreated?.S || mappedFeedData.versioncreated || new Date().toISOString(),
    };

    // Helper function to convert priority strings to numbers
    const convertPriorityToNumber = (priority) => {
      if (typeof priority === 'number') return priority;
      if (typeof priority === 'string') {
        const priorityMap = {
          'Primary': 1, 'primary': 1,
          'Secondary': 2, 'secondary': 2,
          'Routine': 3, 'routine': 3
        };
        return priorityMap[priority] || parseInt(priority) || 1;
      }
      return 1;
    };

    // Add optional fields from DynamoDB attributes
    const addField = (field, converter = (v) => {
      if (v?.S !== undefined) return v.S;  // DynamoDB string (including empty strings)
      if (v?.N !== undefined) return v.N;  // DynamoDB number
      return v;  // Plain value
    }) => {
      const value = converter(mappedFeedData[field]);
      if (value !== undefined && value !== null) {
        sagaFeedItem[field] = value;
      }
    };

    addField('version');
    addField('firstcreated');
    addField('section');
    addField('urgency', (v) => convertPriorityToNumber(v?.N || v));
    addField('priority', (v) => convertPriorityToNumber(v?.N || v));
    addField('pubstatus');
    addField('ednotes');
    addField('mediatopics');
    addField('headline');
    addField('byline');
    addField('body_text');
    addField('body_html');
    addField('description_text');
    addField('description_html');
    addField('located');
    addField('language');
    addField('slugline');
    addField('copyrightnotice');
    addField('usageterms');
    addField('embargoed');
    addField('ttl', (v) => Number(v?.N || v));
    addField('revision', (v) => Number(v?.N || v));
    
    // Parse JSON arrays from DynamoDB strings
    ['places', 'people', 'keywords'].forEach(field => {
      const value = mappedFeedData[field]?.S || mappedFeedData[field];
      if (value) {
        try {
          sagaFeedItem[field] = JSON.parse(value);
        } catch (e) {
          console.log(`Failed to parse ${field}:`, value);
        }
      }
    });
    
    // Add video association if available
    if (videoSignedUrl) {
      sagaFeedItem.associations = [{
        type: "video",
        renditions: [{
          uri: videoSignedUrl,
          mimetype: "video/mp4",
          format: "fmt:mp4",
          ...(thumbnailSignedUrl && { thumbnailUri: thumbnailSignedUrl })
        }]
      }];
    }

    const sagaFeedPayload = {
      body: [sagaFeedItem],
      provider: sagaFeedItem.provider
    };
    
    // Get Saga API configuration
    const apiKey = await getSagaApiKey();
    const apiUrl = await getSagaApiUrl();
    
    console.log('Payload:', JSON.stringify(sagaFeedPayload, null, 2));
    
    // Send to Saga feeds API
    const sagaResponse = await fetch(`${apiUrl}/feeds`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey
      },
      body: JSON.stringify(sagaFeedPayload)
    });
    
    if (!sagaResponse.ok) {
      throw new Error(`Saga Feeds API error: ${sagaResponse.status} ${sagaResponse.statusText}`);
    }
    
    const responseText = await sagaResponse.text();
    console.log('Saga response:', responseText);
    
    return {
      statusCode: 200,
      message: 'Feed item successfully sent to Saga Feeds API',
      feedUri: sagaFeedItem.uri,
      sagaResponse: responseText
    };
    
  } catch (error) {
    console.error('Error sending to Saga:', error);
    throw error;
  }
};
