const fs = require('fs');

async function searchMimirItems(apiKey, searchString, mimirInstance = 'us') {
  const url = `https://${mimirInstance}.mjoll.no/api/v1/search?searchString=${encodeURIComponent(searchString)}&itemsPerPage=10&from=0`;
  
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
    const searchString = process.argv[2];
    if (!searchString) {
      console.error('Usage: node search-mimir-items.js <search-string>');
      process.exit(1);
    }
    
    const params = JSON.parse(fs.readFileSync('./parameters.json', 'utf8'));
    
    console.log('Searching Mimir for:', searchString);
    
    const apiKey = params.mimirApiKey;
    const results = await searchMimirItems(apiKey, searchString);
    
    console.log(JSON.stringify(results, null, 2));
  } catch (error) {
    console.error('Error:', error.message);
  }
}

main();
