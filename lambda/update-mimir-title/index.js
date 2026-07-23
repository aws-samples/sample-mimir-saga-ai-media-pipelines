const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');

const secretsClient = new SecretsManagerClient();

exports.handler = async (event) => {
    try {
        const { mimirItemId, newTitle } = event;
        
        if (!mimirItemId || !newTitle) {
            throw new Error('Missing required parameters: mimirItemId and newTitle');
        }

        // Get Mimir API key
        const secretResponse = await secretsClient.send(new GetSecretValueCommand({
            SecretId: process.env.MIMIR_API_KEY_SECRET_ARN
        }));
        const mimirApiKey = secretResponse.SecretString;

        // Update Mimir item title
        const response = await fetch(`${process.env.MIMIR_API_BASE || 'https://us.mjoll.no'}/api/v1/itemMetadata/${mimirItemId}`, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json',
                'x-mimir-cognito-id-token': `Bearer ${mimirApiKey}`
            },
            body: JSON.stringify({
                metadataDelta: {
                    formId: 'default',
                    formData: {
                        default_title: newTitle
                    }
                }
            })
        });

        if (!response.ok) {
            throw new Error(`Mimir API error: ${response.status} ${response.statusText}`);
        }

        const result = await response.json();
        
        return {
            statusCode: 200,
            mimirItemId,
            updatedTitle: newTitle,
            mimirResponse: result
        };
    } catch (error) {
        console.error('Error updating Mimir title:', error);
        throw error;
    }
};
