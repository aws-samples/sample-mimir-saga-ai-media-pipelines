#!/usr/bin/env node

/**
 * Update the Chapter MDF to add the rule property
 * This will make chapter titles display in the Mimir UI
 */

const https = require('https');

const MIMIR_BASE_URL = 'us.mjoll.no';
const CHAPTER_MDF_ID = 'd4cadfa6-f47d-4c73-83b2-870ebc24b44f';

// Get API key from command line argument
const apiKey = process.argv[2];

if (!apiKey) {
  console.error('Usage: node update-chapter-mdf-rule.js <MIMIR_API_KEY>');
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
    console.log('Fetching current Chapter MDF...');
    const currentMdf = await makeRequest('GET', `/api/v1/mdfs/${CHAPTER_MDF_ID}`);
    
    console.log('Current MDF:', JSON.stringify(currentMdf, null, 2));
    
    console.log('\nUpdating Chapter MDF with rule property...');
    
    const updateBody = {
      label: currentMdf.label || 'Chapter',
      displayName: currentMdf.displayName || 'Chapter',
      active: currentMdf.active !== undefined ? currentMdf.active : true,
      rule: '{title}', // This will display the title field in the UI
      fields: [
        {
          type: 'text',
          required: false,
          fieldId: 'title'
        }
      ],
      views: {
        item: [
          {
            label: 'Title',
            visible: true,
            flex: 12,
            fieldId: 'title'
          }
        ],
        editing: [
          {
            label: 'Title',
            visible: true,
            flex: 12,
            fieldId: 'title'
          }
        ]
      }
    };
    
    console.log('Update payload:', JSON.stringify(updateBody, null, 2));
    
    const updatedMdf = await makeRequest('PUT', `/api/v1/mdfs/${CHAPTER_MDF_ID}`, updateBody);
    
    console.log('\n✅ Successfully updated Chapter MDF!');
    console.log('Updated MDF:', JSON.stringify(updatedMdf, null, 2));
    
    console.log('\n📝 The Chapter MDF now has rule: "{title}"');
    console.log('Chapter titles should now display in the Mimir UI!');
    
  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

main();
