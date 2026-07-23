#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

// Load parameters
const parametersPath = path.join(__dirname, '..', 'parameters.json');
const parameters = JSON.parse(fs.readFileSync(parametersPath, 'utf8'));

async function getContentSourceChoices() {
  try {
    const mimirBaseUrl = 'https://us.mjoll.no';
    
    // Get detailed fields for default MDF
    console.log('Fetching Content_Source field choices...');
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
    
    // Find the Content_Source field
    const contentSourceField = defaultMdf.fields.find(field => field.fieldId === 'Content_Source');
    
    if (!contentSourceField) {
      console.log('Content_Source field not found');
      return;
    }

    console.log('\nContent_Source Field Details:');
    console.log('============================');
    console.log(`Type: ${contentSourceField.type}`);
    console.log(`Required: ${contentSourceField.required}`);
    console.log(`Label: ${contentSourceField.label || 'N/A'}`);
    console.log(`Full field:`, JSON.stringify(contentSourceField, null, 2));
    
    if (contentSourceField.choices) {
      console.log('\nAvailable Choices:');
      console.log('------------------');
      contentSourceField.choices.forEach(choice => {
        console.log(`- Value: "${choice.value}" | Label: "${choice.label}"`);
      });
    } else {
      console.log('\nNo choices found in field definition');
    }

    // Also check if there's a choiceListId that references external choices
    if (contentSourceField.optionListId) {
      console.log(`\nFetching option list: ${contentSourceField.optionListId}`);
      
      const optionListResponse = await fetch(`${mimirBaseUrl}/api/v1/optionLists/${contentSourceField.optionListId}`, {
        headers: {
          'Accept': 'application/json',
          'x-mimir-cognito-id-token': `Bearer ${parameters.mimirApiKey}`
        }
      });

      if (optionListResponse.ok) {
        const optionList = await optionListResponse.json();
        console.log('\nRaw option list response:');
        console.log(JSON.stringify(optionList, null, 2));
        
        console.log('\nAvailable Content_Source Values:');
        console.log('===============================');
        
        if (optionList.alternatives) {
          optionList.alternatives.forEach((path, index) => {
            const pathStr = path.join(' > ');
            const value = path[path.length - 1]; // Last item in path is the value
            console.log(`${index + 1}. Path: "${pathStr}" | Value: "${value}"`);
          });
          
          console.log('\nFor your providers (ABC, FOX), you should use:');
          console.log('- ABC: ["External - Network", "ABC"]');
          console.log('- FOX: ["External - Network", "FOX"]');
        } else if (optionList.options) {
          printOptions(optionList.options);
        } else if (optionList.items) {
          printOptions(optionList.items);
        } else {
          console.log('No options found in response');
        }
      } else {
        console.log(`Failed to fetch option list: ${optionListResponse.status} ${optionListResponse.statusText}`);
      }
    }

  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

getContentSourceChoices();
