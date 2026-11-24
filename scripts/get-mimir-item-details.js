const { getMimirApiKey, getMimirInstance } = require('./mimir-config');

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

async function main() {
  try {
    const itemId = process.argv[2];
    if (!itemId) {
      console.error('Usage: node get-mimir-item-details.js <item-id>');
      process.exit(1);
    }
    
    console.log('Getting Mimir details for item:', itemId);
    
    const details = await getMimirItemDetails(getMimirApiKey(), itemId, getMimirInstance());
    
    console.log(JSON.stringify(details, null, 2));
  } catch (error) {
    console.error('Error:', error.message);
  }
}

main();
