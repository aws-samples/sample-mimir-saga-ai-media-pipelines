const fs = require('fs');

async function createMimirWebhook() {
  try {
    // Load parameters
    const params = JSON.parse(fs.readFileSync('./parameters.json', 'utf8'));
    const apiKey = params.mimirApiKey;
    
    if (!apiKey) {
      throw new Error('mimirApiKey not found in parameters.json');
    }
    
    const webhookUrl = "https://your-api-gateway-url.execute-api.us-east-1.amazonaws.com/prod/webhook/item-create";
    
    const response = await fetch('https://us.mjoll.no/config/api/v1/config/webhooks', {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'x-mimir-cognito-id-token': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        "protected": false,
        "type": "itemCreation",
        "url": webhookUrl,
        "label": "Item Creation Webhook - Staging",
        "condition": {
          "criteria": "always"
        },
        "headers": [
          {
            "headerField": "Content-Type",
            "headerValue": "application/json"
          },
          {
            "headerField": "x-webhook-source", 
            "headerValue": "mimir-staging"
          }
        ]
      })
    });
    
    const result = await response.json();
    
    if (!response.ok) {
      console.error('Error:', response.status, response.statusText);
      console.error('Response:', result);
    } else {
      console.log('Webhook created successfully:', result);
    }
    
  } catch (error) {
    console.error('Error creating webhook:', error.message);
  }
}

createMimirWebhook();
