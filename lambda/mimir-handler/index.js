const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
const { SFNClient, StartExecutionCommand } = require('@aws-sdk/client-sfn');
const { JwtRsaVerifier } = require('aws-jwt-verify');

const secretsClient = new SecretsManagerClient();
const sfnClient = new SFNClient();

let cachedMimirApiKey = null;

// Optional issuer pinning: if MIMIR_ALLOWED_ISSUER is set, only tokens from that
// exact Cognito issuer are accepted. If unset, any AWS Cognito issuer is allowed
// (the token must still be signature-valid, unexpired, and a Cognito ID token).
const ALLOWED_ISSUER = process.env.MIMIR_ALLOWED_ISSUER || '';

// Cache one JWT verifier per issuer (JWKS is fetched and cached by the verifier).
const verifierCache = {};
function getVerifier(issuer) {
  if (!verifierCache[issuer]) {
    verifierCache[issuer] = JwtRsaVerifier.create({
      issuer,
      jwksUri: `${issuer}/.well-known/jwks.json`,
      audience: null, // Mimir app client ID varies per tenant; audience not pinned
    });
  }
  return verifierCache[issuer];
}

/**
 * Validates the Mimir-issued user JWT (sent when a custom action has
 * "Include user's token" enabled). Verifies signature against the issuing
 * Cognito pool's JWKS, plus expiry and token_use. Returns the decoded claims.
 * Throws if the token is missing, malformed, from an unexpected issuer, or invalid.
 */
async function validateMimirUserToken(userToken) {
  if (!userToken || typeof userToken !== 'string') {
    throw new Error('Missing user token');
  }
  // Decode (unverified) to read the issuer so we can locate the right JWKS.
  const parts = userToken.split('.');
  if (parts.length !== 3) throw new Error('Malformed JWT');
  const claims = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf-8'));
  const issuer = claims.iss;

  if (!issuer || !/^https:\/\/cognito-idp\.[a-z0-9-]+\.amazonaws\.com\/[A-Za-z0-9_-]+$/.test(issuer)) {
    throw new Error(`Untrusted token issuer: ${issuer}`);
  }
  if (ALLOWED_ISSUER && issuer !== ALLOWED_ISSUER) {
    throw new Error(`Token issuer not allowed: ${issuer}`);
  }

  // Verify signature + expiry against the issuer's JWKS.
  const payload = await getVerifier(issuer).verify(userToken);
  if (payload.token_use && payload.token_use !== 'id') {
    throw new Error(`Unexpected token_use: ${payload.token_use}`);
  }
  return payload;
}

async function getMimirApiKey() {
  if (cachedMimirApiKey) return cachedMimirApiKey;
  
  const response = await secretsClient.send(
    new GetSecretValueCommand({ SecretId: process.env.MIMIR_API_KEY_SECRET_ARN })
  );
  cachedMimirApiKey = response.SecretString;
  return cachedMimirApiKey;
}

const corsHeaders = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,X-API-Key,Authorization',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
};

exports.handler = async (event) => {
  console.log('Received Mimir request:', JSON.stringify(event, null, 2));
  
  try {
    // Extract action type from the resource path
    const resourcePath = event.resource || event.requestContext?.resourcePath || '';
    console.log('Resource path:', resourcePath);
    
    // Extract action name from path like /actions/{action}
    const actionMatch = resourcePath.match(/\/actions\/([^\/]+)/);
    const actionType = actionMatch ? actionMatch[1] : 'unknown';
    console.log('Action type:', actionType);
    
    const body = JSON.parse(event.body);
    const { items, userToken, actionData, userId, userEmail } = body;

    // Authenticate the request by verifying the Mimir-issued user JWT.
    // This proves the request came from an authenticated Mimir user without
    // relying on a shared API key / Mimir custom-header configuration.
    try {
      const claims = await validateMimirUserToken(userToken);
      console.log(`Authenticated Mimir user: ${claims.email || claims.sub} (tenant: ${claims['mimir:tenant_id'] || claims['custom:tenant_id'] || 'unknown'})`);
    } catch (authErr) {
      console.error('Token validation failed:', authErr.message);
      return {
        statusCode: 401,
        headers: corsHeaders,
        body: JSON.stringify({ message: 'Unauthorized', status: 'error' }),
      };
    }
    
    console.log('Processing action for user:', userEmail);
    console.log('Items received:', items.length);
    console.log('Action type:', actionType);
    
    // Get Mimir API key
    const mimirApiKey = await getMimirApiKey();
    
    // Determine which state machine to use based on action type
    let stateMachineArn;
    let filteredItems = items;
    let extraInput = {};
    
    switch (actionType) {
      case 'summarizer':
        stateMachineArn = process.env.SUMMARIZER_STATE_MACHINE_ARN;
        // Summarizer can work with any item type that has content
        if (filteredItems.length === 0) {
          return {
            statusCode: 200,
            headers: corsHeaders,
            body: JSON.stringify({
              message: 'No items found to process for summarizer',
              status: 'success',
              processedItems: []
            })
          };
        }
        break;
        
      case 'chapterize':
        stateMachineArn = process.env.CHAPTERIZE_STATE_MACHINE_ARN;
        // Filter for video items only for chapterize
        filteredItems = items.filter(item => item.itemType === 'video');
        if (filteredItems.length === 0) {
          return {
            statusCode: 200,
            headers: corsHeaders,
            body: JSON.stringify({
              message: 'No video items found to process for chapterize',
              status: 'success',
              processedItems: []
            })
          };
        }
        break;
        
      case 'vertical-reframe':
      case 'reframe-9-16':
      case 'reframe-1-1':
      case 'reframe-4-5':
        stateMachineArn = process.env.VERTICAL_REFRAME_STATE_MACHINE_ARN;
        // Filter for video items only
        filteredItems = items.filter(item => item.itemType === 'video');
        if (filteredItems.length === 0) {
          return {
            statusCode: 200,
            headers: corsHeaders,
            body: JSON.stringify({
              message: 'No video items found to process for reframe',
              status: 'success',
              processedItems: []
            })
          };
        }
        // Map action type to aspect ratio
        const aspectRatioMap = {
          'vertical-reframe': '9:16',
          'reframe-9-16': '9:16',
          'reframe-1-1': '1:1',
          'reframe-4-5': '4:5'
        };
        extraInput = { aspectRatio: aspectRatioMap[actionType] || '9:16' };
        break;

      case 'reframe-with-graphics': {
        stateMachineArn = process.env.REFRAME_WITH_GRAPHICS_STATE_MACHINE_ARN;
        filteredItems = items.filter(item => item.itemType === 'video');
        if (filteredItems.length === 0) {
          return {
            statusCode: 200,
            headers: corsHeaders,
            body: JSON.stringify({
              message: 'No video items found to process for reframe-with-graphics',
              status: 'success',
              processedItems: []
            })
          };
        }
        // Start one execution per item — each gets its own classification + overlay render
        const graphicsResults = [];
        for (const item of filteredItems) {
          // Extract title — Mimir sends it as item.title directly
          const itemTitle = item.title || item.metadata?.title || item.id || '';
          // Description may be in formData under various field names
          const formData = item.metadata?.formData || {};
          const itemDesc = item.description
            || formData.description
            || formData.default_description
            || formData.synopsis
            || '';
          const execName = `reframe-graphics-${item.id}-${Date.now()}`;
          const execInput = {
            itemId: item.id,
            storyId: item.storyId || null,
            itemDetails: item,
            baseFilename: (item.originalFileName || item.title || item.id).replace(/\.[^/.]+$/, ''),
            title: itemTitle,
            description: itemDesc,
            transcript: '',
            // Per-aspect-ratio template keys — each size has its own Lottie JSON
            lottieTemplates: {
              '9:16': 'templates/graphics-overlay-1080x1920-9x16.json',
              '1:1':  'templates/graphics-overlay-1080x1080-1x1.json',
              '4:5':  'templates/graphics-overlay-1080x1350-4x5.json',
            },
            aspectRatios: ['9:16', '1:1', '4:5'],
            outputPrefix: `reframe-with-graphics/${item.id}/${Date.now()}`,
            mimirApiKey,
            userToken,
            userId,
            userEmail,
          };
          const execCmd = new StartExecutionCommand({
            stateMachineArn,
            name: execName,
            input: JSON.stringify(execInput),
          });
          const execResult = await sfnClient.send(execCmd);
          graphicsResults.push({ itemId: item.id, executionArn: execResult.executionArn });
          console.log(`Started reframe-with-graphics for item ${item.id}: ${execResult.executionArn}`);
        }
        return {
          statusCode: 200,
          headers: corsHeaders,
          body: JSON.stringify({
            message: `Started Reframe + Graphics for ${filteredItems.length} item(s)`,
            status: 'success',
            executions: graphicsResults,
            actionType,
          }),
        };
      }

      case 'reframe-custom': {
        stateMachineArn = process.env.REFRAME_CUSTOM_STATE_MACHINE_ARN;
        filteredItems = items.filter(item => item.itemType === 'video');
        if (filteredItems.length === 0) {
          return {
            statusCode: 200,
            headers: corsHeaders,
            body: JSON.stringify({
              message: 'No video items found to process for reframe-custom',
              status: 'success',
              processedItems: [],
            }),
          };
        }
        const customResults = [];
        for (const item of filteredItems) {
          const itemTitle = item.title || item.metadata?.title || item.id || '';
          const formData = item.metadata?.formData || {};
          const itemDesc = item.description
            || formData.description
            || formData.default_description
            || formData.synopsis
            || '';
          const execName = `reframe-custom-${item.id}-${Date.now()}`;
          const execInput = {
            itemId: item.id,
            storyId: item.storyId || null,
            itemDetails: item,
            baseFilename: (item.originalFileName || item.title || item.id).replace(/\.[^/.]+$/, ''),
            title: itemTitle,
            description: itemDesc,
            transcript: '',
            lottieTemplates: {
              '9:16': 'templates/graphics-overlay-1080x1920-9x16.json',
              '1:1':  'templates/graphics-overlay-1080x1080-1x1.json',
              '4:5':  'templates/graphics-overlay-1080x1350-4x5.json',
            },
            aspectRatios: ['9:16'],
            varianceThreshold: 5000,
            executionTimestamp: Date.now(),
            mimirApiKey,
            userToken,
            userId,
            userEmail,
          };
          const execCmd = new StartExecutionCommand({
            stateMachineArn,
            name: execName,
            input: JSON.stringify(execInput),
          });
          const execResult = await sfnClient.send(execCmd);
          customResults.push({ itemId: item.id, executionArn: execResult.executionArn });
          console.log(JSON.stringify({ action: 'started-reframe-custom', itemId: item.id, executionArn: execResult.executionArn }));
        }
        return {
          statusCode: 200,
          headers: corsHeaders,
          body: JSON.stringify({
            message: `Started Reframe Custom for ${filteredItems.length} item(s)`,
            status: 'success',
            executions: customResults,
            actionType,
          }),
        };
      }
        
      default:
        console.error('Unknown action type:', actionType);
        return {
          statusCode: 400,
          headers: corsHeaders,
          body: JSON.stringify({
            message: `Unknown action type: ${actionType}`,
            status: 'error'
          })
        };
    }
    
    // Start Step Functions execution
    const executionName = `${actionType}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const input = {
      items: filteredItems,
      userToken,
      actionData,
      userId,
      userEmail,
      mimirApiKey,
      actionType,
      ...extraInput
    };
    
    const command = new StartExecutionCommand({
      stateMachineArn: stateMachineArn,
      name: executionName,
      input: JSON.stringify(input)
    });
    
    const result = await sfnClient.send(command);
    
    console.log(`Started Step Functions execution: ${result.executionArn}`);
    
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({
        message: `Started processing ${filteredItems.length} items with ${actionType} action`,
        status: 'success',
        executionArn: result.executionArn,
        itemsToProcess: filteredItems.length,
        actionType: actionType
      })
    };
    
  } catch (error) {
    console.error('Error processing request:', error);
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({
        message: 'Error processing action: ' + error.message,
        status: 'error'
      })
    };
  }
};
