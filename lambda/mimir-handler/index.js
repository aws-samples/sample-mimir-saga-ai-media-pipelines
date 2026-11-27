const { SFNClient, StartExecutionCommand } = require('@aws-sdk/client-sfn');
const { JwtRsaVerifier } = require('aws-jwt-verify');

const sfnClient = new SFNClient();

// Required: the Cognito issuer of your Mimir tenant's user pool. Only tokens from
// this exact issuer are accepted. When it is unset, EVERY request is rejected:
// any AWS account can create a Cognito pool and mint valid ID tokens, so
// "any Cognito issuer" is no authentication at all.
const ALLOWED_ISSUER = (process.env.MIMIR_ALLOWED_ISSUER || '').trim();
// Optional: comma-separated Mimir app client IDs (the token's `aud` claim).
// Blank means the audience is not checked.
const ALLOWED_AUDIENCE = (process.env.MIMIR_ALLOWED_AUDIENCE || '')
  .split(',').map((s) => s.trim()).filter(Boolean);
const COGNITO_ISSUER_RE = /^https:\/\/cognito-idp\.[a-z0-9-]+\.amazonaws\.com\/[A-Za-z0-9_-]+$/;

if (!ALLOWED_ISSUER) {
  console.error('MIMIR_ALLOWED_ISSUER is not set: all Mimir custom actions will be rejected (401) until MimirAllowedIssuer is configured and the stack redeployed.');
}

// Recommended: your Mimir tenant id. The regional Mimir user pool and app
// client are shared by every tenant in that region, so the issuer (and
// audience) pin only proves "some Mimir user in this region". When set, the
// verified token's `mimir:tenant_id` must equal it (403 otherwise).
// shortcut: blank still allows any tenant (with a warning) so the issuer
// rollout does not break existing deploys; make it required in a later release.
const ALLOWED_TENANT = (process.env.MIMIR_ALLOWED_TENANT || '').trim();
// Mimir's own web app reads the tenant from `mimir:tenant_id` first. The
// `custom:` claim is a Cognito user attribute, which an app client can allow
// users to write, so it is only cross-checked, never trusted on its own.
const TENANT_CLAIM = 'mimir:tenant_id';
const CUSTOM_TENANT_CLAIM = 'custom:tenant_id';

if (!ALLOWED_TENANT) {
  console.warn('MIMIR_ALLOWED_TENANT is not set: any Mimir user in this region can trigger these custom actions. Set MimirAllowedTenant (see the README).');
}

class ForbiddenError extends Error {}

/**
 * Tenant check on VERIFIED claims. Throws ForbiddenError (-> 403) when the
 * tenant claim is missing, the two tenant claims disagree, or the tenant is
 * not MIMIR_ALLOWED_TENANT. Returns the tenant id.
 */
function checkTenant(claims) {
  const tenant = claims[TENANT_CLAIM];
  const custom = claims[CUSTOM_TENANT_CLAIM];
  if (typeof tenant !== 'string' || tenant === '') {
    throw new ForbiddenError(`Token has no ${TENANT_CLAIM} claim`);
  }
  if (custom !== undefined && custom !== tenant) {
    throw new ForbiddenError(`Token tenant claims disagree (${TENANT_CLAIM} ${quoteIssuer(tenant)}, ${CUSTOM_TENANT_CLAIM} ${quoteIssuer(custom)})`);
  }
  if (!ALLOWED_TENANT) {
    console.warn(`MIMIR_ALLOWED_TENANT is not set; allowing tenant ${quoteIssuer(tenant)}. Set MimirAllowedTenant to this value if it is your Mimir tenant.`);
    return tenant;
  }
  if (tenant !== ALLOWED_TENANT) {
    throw new ForbiddenError(`Tenant not allowed: ${quoteIssuer(tenant)}`);
  }
  return tenant;
}

// Lottie template key per aspect ratio in the templates bucket. The base name
// comes from the GraphicsTemplatePrefix deploy setting (validated at synth);
// 'graphics-overlay' is the reference template the bucket deployment uploads.
function lottieTemplateKeys(prefix = process.env.LOTTIE_TEMPLATE_PREFIX || 'graphics-overlay') {
  return {
    '9:16': `templates/${prefix}-1080x1920-9x16.json`,
    '1:1':  `templates/${prefix}-1080x1080-1x1.json`,
    '4:5':  `templates/${prefix}-1080x1350-4x5.json`,
  };
}

// Cache one JWT verifier per issuer (JWKS is fetched and cached by the verifier).
const verifierCache = {};
function getVerifier(issuer) {
  if (!verifierCache[issuer]) {
    verifierCache[issuer] = JwtRsaVerifier.create({
      issuer,
      jwksUri: `${issuer}/.well-known/jwks.json`,
      audience: ALLOWED_AUDIENCE.length ? ALLOWED_AUDIENCE : null,
    });
  }
  return verifierCache[issuer];
}

// Issuer strings come from an unverified token: quote and cap them in messages.
const quoteIssuer = (iss) => JSON.stringify(String(iss).slice(0, 200));

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

  if (!ALLOWED_ISSUER) {
    // Fail closed. The (unverified) issuer is logged so an operator can find
    // their tenant's value; confirm it belongs to your Mimir tenant first.
    throw new Error(`MIMIR_ALLOWED_ISSUER is not configured; rejecting token (unverified iss ${quoteIssuer(issuer)})`);
  }
  if (!issuer || issuer !== ALLOWED_ISSUER || !COGNITO_ISSUER_RE.test(issuer)) {
    throw new Error(`Token issuer not allowed: ${quoteIssuer(issuer)}`);
  }

  // Verify signature + expiry against the issuer's JWKS.
  const payload = await getVerifier(issuer).verify(userToken);
  if (payload.token_use && payload.token_use !== 'id') {
    throw new Error(`Unexpected token_use: ${payload.token_use}`);
  }
  return payload;
}

// Redact credentials before logging the raw API Gateway event: the body
// carries the caller's Mimir ID token (`userToken`) and the headers may carry
// an Authorization / X-API-Key value.
const REDACTED = '***REDACTED***';
const SENSITIVE_HEADERS = new Set(['authorization', 'x-api-key', 'cookie', 'x-mimir-cognito-id-token']);
function redactEventForLog(event) {
  const redacted = { ...event };
  for (const field of ['headers', 'multiValueHeaders']) {
    if (event[field]) {
      redacted[field] = {};
      for (const [k, v] of Object.entries(event[field])) {
        redacted[field][k] = SENSITIVE_HEADERS.has(k.toLowerCase()) ? REDACTED : v;
      }
    }
  }
  if (typeof event.body === 'string') {
    try {
      const body = JSON.parse(event.body);
      if (body && typeof body === 'object' && 'userToken' in body) body.userToken = REDACTED;
      redacted.body = body;
    } catch {
      redacted.body = '[unparseable body omitted]';
    }
  }
  return redacted;
}

const corsHeaders = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,X-API-Key,Authorization',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
};

/**
 * Normalise producer-supplied overrides from the Mimir custom-action metadata
 * form into the shape the Reframe + Graphics state machine expects. The form
 * posts raw field keys (`title`, `summary`, `gfx_template`, `toa`); downstream
 * Lambdas read a stable camelCase object off `$$.Execution.Input.userMetadata`.
 *
 * String fields are trimmed and empty strings collapse to null so the
 * classifier can treat them as "no override, use AI-generated value".
 * `burnCaptions` is strictly a boolean — anything other than the exact value
 * `true` for `toa` resolves to `false` so captions stay off by default when
 * the checkbox is unchecked or the field is absent.
 */
function buildReframeGraphicsOverrides(actionData) {
  const d = actionData && typeof actionData === 'object' ? actionData : {};
  const trimOrNull = (v) => {
    if (typeof v !== 'string') return null;
    const t = v.trim();
    return t === '' ? null : t;
  };
  return {
    title:        trimOrNull(d.title),
    summary:      trimOrNull(d.summary),
    gfxTemplate:  trimOrNull(d.gfx_template),
    burnCaptions: d.toa === true,
  };
}

// Exported for unit tests
module.exports.buildReframeGraphicsOverrides = buildReframeGraphicsOverrides;
module.exports.redactEventForLog = redactEventForLog;
module.exports.validateMimirUserToken = validateMimirUserToken;
module.exports.checkTenant = checkTenant;
module.exports._getVerifier = getVerifier;
module.exports.lottieTemplateKeys = lottieTemplateKeys;

/**
 * Check the raw API Gateway body before any token or Mimir work. Returns
 * `{ body }` for a JSON object with an `items` array, else `{ error }` with a
 * short reason. The reason never echoes the body.
 */
function parseActionBody(rawBody) {
  if (typeof rawBody !== 'string' || rawBody.trim() === '') {
    return { error: 'Request body is required' };
  }
  let body;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return { error: 'Request body must be valid JSON' };
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'Request body must be a JSON object' };
  }
  if (!Array.isArray(body.items)) {
    return { error: 'items must be an array' };
  }
  return { body };
}

module.exports.parseActionBody = parseActionBody;

exports.handler = async (event) => {
  // Malformed requests (scanners send empty bodies) get a 400 before anything
  // else, and the body is not logged.
  const parsed = parseActionBody(event?.body);
  if (parsed.error) {
    console.warn('Rejected request:', JSON.stringify({ resource: event?.resource || null, reason: parsed.error }));
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({ message: parsed.error, status: 'error' }),
    };
  }

  console.log('Received Mimir request:', JSON.stringify(redactEventForLog(event), null, 2));
  
  try {
    // Extract action type from the resource path
    const resourcePath = event.resource || event.requestContext?.resourcePath || '';
    console.log('Resource path:', resourcePath);
    
    // Extract action name from path like /actions/{action}
    const actionMatch = resourcePath.match(/\/actions\/([^\/]+)/);
    const actionType = actionMatch ? actionMatch[1] : 'unknown';
    console.log('Action type:', actionType);
    
    const { items, userToken, actionData, userId, userEmail } = parsed.body;

    // Authenticate the request by verifying the Mimir-issued user JWT.
    // This proves the request came from an authenticated Mimir user without
    // relying on a shared API key / Mimir custom-header configuration.
    try {
      const claims = await validateMimirUserToken(userToken);
      const tenant = checkTenant(claims);
      console.log(`Authenticated Mimir user: ${claims.email || claims.sub} (tenant: ${tenant})`);
    } catch (authErr) {
      const forbidden = authErr instanceof ForbiddenError;
      console.error(`Token validation failed${forbidden ? ' (tenant)' : ''}:`, authErr.message);
      return {
        statusCode: forbidden ? 403 : 401,
        headers: corsHeaders,
        body: JSON.stringify({ message: forbidden ? 'Forbidden' : 'Unauthorized', status: 'error' }),
      };
    }
    
    console.log('Processing action for user:', userEmail);
    console.log('Items received:', items.length);
    console.log('Action type:', actionType);
    
    // The Mimir API key and the caller's userToken are deliberately NOT put in
    // the Step Functions execution input: input is stored in execution history
    // (readable via DescribeExecution / GetExecutionHistory and the console for
    // 90 days). Downstream Lambdas read the key from Secrets Manager
    // (MIMIR_API_KEY_SECRET_ARN); no downstream state uses userToken, which is
    // only needed for the authentication check above.

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
        // Producer-supplied overrides from the Mimir custom-action metadata
        // form (keyed by the field `key` values defined in
        // register-mimir-integrations). Always built as an object so the state
        // machine `$$.Execution.Input.userMetadata.*` paths always resolve —
        // null entries read as "no override, use AI-generated value".
        const userMetadata = buildReframeGraphicsOverrides(actionData);
        console.log('reframe-with-graphics overrides:', JSON.stringify(userMetadata));
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
            lottieTemplates: lottieTemplateKeys(),
            aspectRatios: ['9:16', '1:1', '4:5'],
            outputPrefix: `reframe-with-graphics/${item.id}/${Date.now()}`,
            userMetadata,
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
            lottieTemplates: lottieTemplateKeys(),
            aspectRatios: ['9:16'],
            varianceThreshold: 5000,
            executionTimestamp: Date.now(),
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
      actionData,
      userId,
      userEmail,
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
