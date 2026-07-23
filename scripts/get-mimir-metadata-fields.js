#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

// Load parameters
const parametersPath = path.join(__dirname, '..', 'parameters.json');
const parameters = JSON.parse(fs.readFileSync(parametersPath, 'utf8'));

async function getMimirMetadataFields() {
  try {
    const mimirBaseUrl = 'https://us.mjoll.no';
    
    // Get all MDFs
    console.log('Fetching all metadata forms...');
    const mdfsResponse = await fetch(`${mimirBaseUrl}/api/v1/mdfs`, {
      headers: {
        'Accept': 'application/json',
        'x-mimir-cognito-id-token': `Bearer ${parameters.mimirApiKey}`
      }
    });

    if (!mdfsResponse.ok) {
      throw new Error(`Failed to fetch MDFs: ${mdfsResponse.status} ${mdfsResponse.statusText}`);
    }

    const mdfsData = await mdfsResponse.json();
    console.log('\nAvailable Metadata Forms:');
    console.log('========================');
    
    for (const mdf of mdfsData._embedded.collection) {
      console.log(`- ${mdf.label} (ID: ${mdf.id}) - Active: ${mdf.active}`);
    }

    // Get detailed fields for default MDF
    console.log('\nFetching detailed fields for default MDF...');
    const defaultMdfResponse = await fetch(`${mimirBaseUrl}/api/v1/mdfs/default`, {
      headers: {
        'Accept': 'application/json',
        'x-mimir-cognito-id-token': `Bearer ${parameters.mimirApiKey}`
      }
    });

    if (!defaultMdfResponse.ok) {
      throw new Error(`Failed to fetch default MDF: ${defaultMdfResponse.status} ${defaultMdfResponse.statusText}`);
    }

    const defaultMdf = await defaultMdfResponse.json();
    console.log('\nDefault Metadata Fields:');
    console.log('=======================');
    
    for (const field of defaultMdf.fields) {
      console.log(`- ${field.fieldId} (${field.type}) - Required: ${field.required}`);
      if (field.label) console.log(`  Label: ${field.label}`);
      if (field.hint) console.log(`  Hint: ${field.hint}`);
      console.log('');
    }

  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

getMimirMetadataFields();
