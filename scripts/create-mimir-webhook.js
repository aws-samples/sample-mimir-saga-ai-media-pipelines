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

    // The webhook API rejects calls without this header. Export the value of
    // the MimirWebhookToken secret (SSM /infrastructure/webhook-token-secret-arn)
    // as MIMIR_WEBHOOK_TOKEN before running; it is never printed.
    const webhookToken = process.env.MIMIR_WEBHOOK_TOKEN;
    if (!webhookToken) {
      throw new Error('MIMIR_WEBHOOK_TOKEN is not set');
    }
    
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
          },
          {
            "headerField": "x-mimir-webhook-token",
            "headerValue": webhookToken
          }
        ]
      })
    });
    
    const result = await response.json();
    // The response echoes the headers, token included: mask them before printing.
    if (result && Array.isArray(result.headers)) {
      result.headers = result.headers.map((h) => ({ ...h, headerValue: '***' }));
    }
    
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
