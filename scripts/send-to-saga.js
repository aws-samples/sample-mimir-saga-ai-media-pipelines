#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

// Load parameters from parameters.json
const parametersPath = path.join(__dirname, '..', 'parameters.json');
let parameters = {};

if (fs.existsSync(parametersPath)) {
  parameters = JSON.parse(fs.readFileSync(parametersPath, 'utf8'));
  console.log('Loaded parameters:', Object.keys(parameters));
} else {
  console.log('parameters.json not found at:', parametersPath);
}

async function sendToSaga(payload) {
  try {
    const apiKey = parameters.sagaApiKey;
    const apiUrl = parameters.sagaApiUrl;
    
    if (!apiKey || !apiUrl) {
      throw new Error('sagaApiKey and sagaApiUrl must be set in parameters.json');
    }
    
    console.log('Sending payload to Saga:', JSON.stringify(payload, null, 2));
    
    const response = await fetch(`${apiUrl}/feeds`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey
      },
      body: JSON.stringify(payload)
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Saga API error: ${response.status} ${response.statusText} - ${errorText}`);
    }
    
    const responseText = await response.text();
    console.log('Saga response:', responseText);
    
    return responseText;
    
  } catch (error) {
    console.error('Error sending to Saga:', error);
    throw error;
  }
}

// Main execution
async function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0) {
    console.log('Usage: node send-to-saga.js <payload-file.json>');
    console.log('   or: node send-to-saga.js \'{"body": [...], "provider": "ABC"}\'');
    process.exit(1);
  }
  
  let payload;
  const input = args[0];
  
  // Check if input is a file path or JSON string
  if (input.startsWith('{')) {
    // Direct JSON string
    try {
      payload = JSON.parse(input);
    } catch (error) {
      console.error('Invalid JSON string:', error.message);
      process.exit(1);
    }
  } else {
    // File path
    const filePath = path.resolve(input);
    if (!fs.existsSync(filePath)) {
      console.error('File not found:', filePath);
      process.exit(1);
    }
    
    try {
      const fileContent = fs.readFileSync(filePath, 'utf8');
      payload = JSON.parse(fileContent);
    } catch (error) {
      console.error('Error reading/parsing file:', error.message);
      process.exit(1);
    }
  }
  
  // Validate payload structure
  if (!payload.body || !Array.isArray(payload.body)) {
    console.error('Payload must have a "body" array');
    process.exit(1);
  }
  
  if (!payload.provider) {
    console.error('Payload must have a "provider" field');
    process.exit(1);
  }
  
  try {
    await sendToSaga(payload);
    console.log('Successfully sent to Saga!');
  } catch (error) {
    console.error('Failed to send to Saga:', error.message);
    process.exit(1);
  }
}

main().catch(console.error);
