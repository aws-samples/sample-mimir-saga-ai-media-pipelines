const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');

const secretsClient = new SecretsManagerClient();

let cachedMimirApiKey = null;

async function getMimirApiKey() {
  if (cachedMimirApiKey) return cachedMimirApiKey;
  
  const response = await secretsClient.send(
    new GetSecretValueCommand({ SecretId: process.env.MIMIR_API_KEY_SECRET_ARN })
  );
  cachedMimirApiKey = response.SecretString;
  return cachedMimirApiKey;
}

exports.handler = async (event) => {
  console.log('Mimir update handler received:', JSON.stringify(event, null, 2));
  
  try {
    const { itemId, mimirApiKey, formId, formData, summary } = event;
    
    if (!itemId) {
      throw new Error('Missing required parameter: itemId');
    }

    // Support both generic formData and legacy summary field.
    // SUMMARY_FIELD_NAME env var controls which metadata field the summary is written to.
    // Default: 'description' (universally available in Mimir).
    const summaryFieldName = process.env.SUMMARY_FIELD_NAME || 'description';
    const updateFormData = formData || (summary ? { [summaryFieldName]: summary } : null);
    if (!updateFormData) {
      throw new Error('Missing required parameter: formData or summary');
    }
    
    const apiKey = mimirApiKey || await getMimirApiKey();
    
    const updatePayload = {
      metadataDelta: {
        formId: formId || 'default',
        formData: updateFormData,
      }
    };
    
    console.log(`Updating Mimir item ${itemId} with:`, JSON.stringify(updateFormData));
    
    const response = await fetch(`${process.env.MIMIR_API_BASE || 'https://us.mjoll.no'}/api/v1/itemMetadata/${itemId}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'x-mimir-cognito-id-token': `Bearer ${apiKey}`
      },
      body: JSON.stringify(updatePayload)
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Mimir API error: ${response.status} - ${errorText}`);
    }
    
    const result = await response.json();
    console.log('Mimir update successful:', result);
    
    return {
      itemId,
      status: 'updated',
      updatedFields: Object.keys(updateFormData),
      timestamp: new Date().toISOString()
    };
    
  } catch (error) {
    console.error('Error updating Mimir item:', error);
    throw error;
  }
};
