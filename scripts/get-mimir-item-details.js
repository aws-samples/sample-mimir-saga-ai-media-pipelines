const fs = require('fs');

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
    
    const params = JSON.parse(fs.readFileSync('./parameters.json', 'utf8'));
    
    console.log('Getting Mimir details for item:', itemId);
    
    const apiKey = params.mimirApiKey;
    const details = await getMimirItemDetails(apiKey, itemId);
    
    console.log(JSON.stringify(details, null, 2));
  } catch (error) {
    console.error('Error:', error.message);
  }
}

main();
