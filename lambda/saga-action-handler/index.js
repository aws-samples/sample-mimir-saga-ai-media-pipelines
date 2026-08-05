/**
 * Saga Custom Action Handler
 *
 * Handles custom action requests from Saga (story-level actions).
 * Saga payload format: { event, action, triggeredByUserId, story }
 * Auth: x-api-key header validated against API Gateway key secret.
 */

const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
const { SFNClient, StartExecutionCommand } = require('@aws-sdk/client-sfn');

const secretsClient = new SecretsManagerClient();
const sfnClient = new SFNClient();

let cachedMimirApiKey = null;
let cachedSagaActionsApiKey = null;

async function getSagaActionsApiKey() {
  if (cachedSagaActionsApiKey !== null) return cachedSagaActionsApiKey;
  const response = await secretsClient.send(
    new GetSecretValueCommand({ SecretId: process.env.SAGA_ACTIONS_API_KEY_SECRET_ARN })
  );
  // Secret is generated as JSON: { "apiKey": "..." }
  cachedSagaActionsApiKey = JSON.parse(response.SecretString).apiKey;
  return cachedSagaActionsApiKey;
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
  console.log('Saga action request:', JSON.stringify(event, null, 2));

  try {
    // Authenticate the request via the shared x-api-key that Saga sends.
    // Configure this same value in Saga's "Configure Auth" dialog (Auth type:
    // API key) when creating each Saga custom action. The key is generated at
    // deploy time and stored in Secrets Manager (SagaActionsApiKey).
    const expectedApiKey = await getSagaActionsApiKey();
    // Saga sends the shared key. Prefer the x-api-key header, but also accept it
    // as an `apiKey` query-string parameter, since some Saga custom-action configs
    // can only append the key to the endpoint URL (not send a custom header).
    const headers = event.headers || {};
    const headerKey = Object.keys(headers).find(h => h.toLowerCase() === 'x-api-key');
    const qs = event.queryStringParameters || {};
    const requestApiKey = (headerKey && headers[headerKey]) || qs.apiKey || qs['api-key'];
    if (requestApiKey !== expectedApiKey) {
      console.error('Invalid or missing x-api-key');
      return {
        statusCode: 401,
        headers: corsHeaders,
        body: JSON.stringify({ message: 'Unauthorized', status: 'error' }),
      };
    }

    const body = JSON.parse(event.body);

    // Validate Saga payload
    if (body.event !== 'story' || !body.story) {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({ message: 'Invalid Saga payload: expected event=story with story object', status: 'error' }),
      };
    }

    const storyId = body.story.mId || body.story.mRefId;
    if (!storyId) {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({ message: 'No story ID found in payload', status: 'error' }),
      };
    }

    // Determine action from URL path
    const resourcePath = event.resource || event.requestContext?.resourcePath || '';
    const actionMatch = resourcePath.match(/\/(?:saga-actions|actions)\/([^\/]+)/);
    const actionType = actionMatch ? actionMatch[1] : 'unknown';
    console.log(`Saga action: ${actionType}, story: ${body.story.mTitle} (${storyId})`);

    const mimirApiKey = await getMimirApiKey();

    // Rough-cut variants all run the SAME rough-cut state machine/agent; the
    // action only changes the "roughCutType", which the agent uses to select a
    // prompt/constraint profile (e.g. a stripped-down VO-only cut).
    // Map: action path -> rough cut type.
    const ROUGH_CUT_TYPES = {
      'rough-cut': 'full',
      'rough-cut-simple-vo': 'simple-vo',
    };

    let stateMachineArn;
    let roughCutType;
    if (actionType in ROUGH_CUT_TYPES) {
      stateMachineArn = process.env.ROUGH_CUT_STATE_MACHINE_ARN;
      roughCutType = ROUGH_CUT_TYPES[actionType];
    } else if (actionType === 'story-research') {
      stateMachineArn = process.env.STORY_RESEARCH_STATE_MACHINE_ARN;
    } else {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({ message: `Unknown saga action: ${actionType}`, status: 'error' }),
      };
    }

    const executionName = `${actionType}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const input = {
      storyId,
      sagaApiKeySecretArn: process.env.SAGA_API_KEY_SECRET_ARN,
      sagaApiUrlSecretArn: process.env.SAGA_API_URL_SECRET_ARN,
      mimirApiKey,
      story: body.story,
      triggeredByUserId: body.triggeredByUserId,
      actionType,
      // Only set for rough-cut actions; selects the agent's prompt/constraint profile.
      ...(roughCutType ? { roughCutType } : {}),
    };

    const result = await sfnClient.send(new StartExecutionCommand({
      stateMachineArn,
      name: executionName,
      input: JSON.stringify(input),
    }));

    console.log(`Started execution: ${result.executionArn}`);

    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({
        message: `Started ${actionType} for story: ${body.story.mTitle}`,
        status: 'success',
        executionArn: result.executionArn,
      }),
    };
  } catch (error) {
    console.error('Error:', error);
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({ message: 'Error: ' + error.message, status: 'error' }),
    };
  }
};
