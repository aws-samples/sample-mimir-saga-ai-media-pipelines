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

async function copyMediaToPlaceholder(apiKey, sourceItemId, targetItemId, mimirInstance = 'us') {
  const url = `https://${mimirInstance}.mjoll.no/api/v1/items/merge`;
  
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'x-mimir-cognito-id-token': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      sourceItemId: sourceItemId,
      targetItemId: targetItemId,
      mediaToCopy: "highRes"
    })
  });
  
  if (!response.ok) {
    throw new Error(`Mimir copy media API error: ${response.status} ${response.statusText}`);
  }
  
  const responseText = await response.text();
  try {
    return JSON.parse(responseText);
  } catch (e) {
    // API returned non-JSON response, return the text
    return { message: responseText };
  }
}

async function updateMimirTitle(apiKey, itemId, newTitle, mimirInstance = 'us') {
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
        formData: {
          default_title: newTitle
        }
      }
    })
  });
  
  if (!response.ok) {
    throw new Error(`Mimir update title API error: ${response.status} ${response.statusText}`);
  }
  
  return await response.json();
}

exports.handler = async (event) => {
    console.log('=== STEP FUNCTIONS PAYLOAD ===');
    console.log(JSON.stringify(event, null, 2));
    console.log('=== END PAYLOAD ===');
    
    try {
        // Extract data from Step Functions payload
        const { titleExtraction, item, sagaLookup } = event;
        
        if (!sagaLookup?.Item) {
            console.log('No Saga feed item found, skipping merge');
            return {
                statusCode: 200,
                body: JSON.stringify({
                    message: 'No Saga feed item to merge',
                    processed: false
                })
            };
        }
        
        // Extract key data for merge
        const mimirItemId = sagaLookup.Item.mimirItemId?.S;
        const newSagaItemId = item.id;
        const slugline = sagaLookup.Item.slugline?.S;
        
        console.log('Merge operation:', {
            mimirItemId,
            newSagaItemId,
            extractedTitle: titleExtraction.extractedTitle,
            slugline
        });
        
        // Get Mimir API key
        const mimirApiKey = await getMimirApiKey();
        
        // Copy media from existing Mimir item to new Saga item
        console.log(`Copying media from Mimir item ${mimirItemId} to Saga item ${newSagaItemId}`);
        const copyResult = await copyMediaToPlaceholder(mimirApiKey, mimirItemId, newSagaItemId);
        console.log('Media copy result:', JSON.stringify(copyResult, null, 2));
        
        // Update title if slugline exists
        let titleUpdateResult = null;
        if (slugline) {
            console.log(`Updating title for item ${newSagaItemId} to: ${slugline}`);
            titleUpdateResult = await updateMimirTitle(mimirApiKey, newSagaItemId, slugline);
            console.log('Title update result:', JSON.stringify(titleUpdateResult, null, 2));
        }
        
        return {
            statusCode: 200,
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                message: 'Saga feed item merge completed',
                mimirItemId,
                newSagaItemId,
                processed: true,
                copyResult,
                titleUpdateResult,
                updatedTitle: slugline
            })
        };
        
    } catch (error) {
        console.error('Error processing Saga feed merge:', error);
        
        return {
            statusCode: 500,
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                error: 'Failed to process Saga feed merge',
                message: error.message
            })
        };
    }
};
