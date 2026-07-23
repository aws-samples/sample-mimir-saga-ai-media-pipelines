#!/usr/bin/env node

/**
 * Create a new Chapter MDF with proper field definitions and rule
 */

const https = require('https');

const MIMIR_BASE_URL = 'us.mjoll.no';

// Get API key from command line argument
const apiKey = process.argv[2];

if (!apiKey) {
  console.error('Usage: node create-chapter-mdf.js <MIMIR_API_KEY>');
  process.exit(1);
}

async function makeRequest(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: MIMIR_BASE_URL,
      port: 443,
      path: path,
      method: method,
      headers: {
        'Content-Type': 'application/json',
        'x-mimir-cognito-id-token': `Bearer ${apiKey}`
      }
    };

    const req = https.request(options, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            resolve(data);
          }
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data}`));
        }
      });
    });

    req.on('error', reject);

    if (body) {
      req.write(JSON.stringify(body));
    }

    req.end();
  });
}

async function main() {
  try {
    console.log('Creating new Chapter MDF...');
    
    // Step 1: Create the MDF with basic structure
    const createBody = {
      label: 'Chapter',
      displayName: 'Chapter',
      flavor: 'timed-metadata',
      active: true,
      fields: []
    };
    
    console.log('Step 1: Creating MDF...');
    const createdMdf = await makeRequest('POST', '/api/v1/mdfs', createBody);
    console.log('✅ MDF created with ID:', createdMdf.id);
    
    // Step 2: Update the MDF with field definition and rule
    console.log('\nStep 2: Adding field definition and rule...');
    const updateBody = {
      label: 'Chapter',
      displayName: 'Chapter',
      active: true,
      rule: '{title}',
      fields: [
        {
          type: 'text',
          required: false,
          fieldId: 'title'
        }
      ]
    };
    
    const updatedMdf = await makeRequest('PUT', `/api/v1/mdfs/${createdMdf.id}`, updateBody);
    
    console.log('\n✅ Successfully created and configured Chapter MDF!');
    console.log('\nMDF Details:');
    console.log('  ID:', updatedMdf.id);
    console.log('  Label:', updatedMdf.label);
    console.log('  Rule:', updatedMdf.rule);
    console.log('  Fields:', JSON.stringify(updatedMdf.fields, null, 2));
    
    console.log('\n📝 Update your Lambda environment variable:');
    console.log(`  CHAPTER_FORM_ID=${updatedMdf.id}`);
    
  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

main();
