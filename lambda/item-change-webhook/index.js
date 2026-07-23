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

async function searchMimirItems(apiKey, searchString, mimirInstance = 'us', folderId = null) {
  let url = `https://${mimirInstance}.mjoll.no/api/v1/search?searchString=${encodeURIComponent(searchString)}&itemsPerPage=10&from=0`;
  
  // Add folder restriction if provided
  if (folderId) {
    url += `&folderId=${encodeURIComponent(folderId)}&includeSubfolders=true`;
  }
  
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Accept': 'application/json',
      'x-mimir-cognito-id-token': `Bearer ${apiKey}`
    }
  });
  
  if (!response.ok) {
    throw new Error(`Mimir search API error: ${response.status} ${response.statusText}`);
  }
  
  return await response.json();
}

async function getFolderIdByPath(apiKey, folderPath, mimirInstance = 'us') {
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
    throw new Error(`Mimir folder path lookup error: ${response.status} ${response.statusText}`);
  }
  
  const result = await response.json();
  const lastFolder = result[result.length - 1];
  return Object.values(lastFolder)[0];
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
    throw new Error(`Mimir item details API error: ${response.status} ${response.statusText}`);
  }
  
  return await response.json();
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
  
  return await response.json();
}

exports.handler = async (event) => {
  console.log('Item Change Webhook received:', JSON.stringify(event, null, 2));
  
  try {
    // Parse the webhook body
    const webhookData = JSON.parse(event.body);
    
    // Only process item_changed events
    if (webhookData.event === 'item_changed' && webhookData.item && webhookData.item.id) {
      const itemId = webhookData.item.id;
      // Get title from either direct field or nested metadata
      const title = webhookData.item.title || webhookData.item.metadata?.formData?.title;
      
      if (!title) {
        console.log('Ignoring event - no title found in item.title or item.metadata.formData.title');
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: 'Event ignored - no title found' })
        };
      }
      
      // Only process items that don't have media yet (placeholders)
      if (webhookData.item.doesItemHaveMedia === true) {
        console.log(`Ignoring event - item ${itemId} already has media`);
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: 'Event ignored - item already has media' })
        };
      }
      
      console.log(`Processing item_changed event for item: ${itemId} with title: ${title}`);
      
      // Get Mimir API key
      const mimirApiKey = await getMimirApiKey();
      
      // Get folder ID for ABC provider folder
      const folderPath = '03_ABC';
      console.log(`Looking up folder ID for path: ${folderPath}`);
      const folderId = await getFolderIdByPath(mimirApiKey, folderPath);
      console.log(`Found folder ID: ${folderId}`);
      
      // Search for items with the same originalFileName in the provider folder
      console.log(`Searching for items with originalFileName "${title}.mp4" in folder ${folderId}`);
      const searchResults = await searchMimirItems(mimirApiKey, `${title}.mp4`, 'us', folderId);
      console.log('Search results:', JSON.stringify(searchResults, null, 2));
      
      // Find the complete item (not the current item)
      const completeItem = searchResults._embedded?.collection?.find(item => 
        item.itemState === 'complete' && item.id !== itemId
      );
      
      if (completeItem) {
        console.log(`Found complete item ${completeItem.id}, fetching full details...`);
        
        // Get full item details to access highRes URL
        const itemDetails = await getMimirItemDetails(mimirApiKey, completeItem.id);
        console.log(`Item details - highRes: ${itemDetails.highRes ? 'Available' : 'Not available'}`);
        
        // Copy media from complete item to placeholder
        const copyResult = await copyMediaToPlaceholder(mimirApiKey, completeItem.id, itemId);
        console.log('Media copy result:', JSON.stringify(copyResult, null, 2));
      } else {
        console.log('No complete item found to copy media from');
      }
      
    } else {
      console.log('Ignoring event - missing required fields (event, item.id, or item.title)');
    }
    
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        message: 'Item change webhook processed successfully',
        timestamp: new Date().toISOString()
      })
    };
    
  } catch (error) {
    console.error('Error processing webhook:', error);
    
    return {
      statusCode: 500,
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        error: 'Failed to process webhook',
        message: error.message
      })
    };
  }
};
