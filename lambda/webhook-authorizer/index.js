/**
 * API Gateway REQUEST authorizer for the Mimir Webhooks API.
 *
 * Mimir webhooks can only send static custom headers (no request signing), so
 * every webhook registered by register-mimir-integrations carries the shared
 * token from the MimirWebhookToken secret in the WEBHOOK_TOKEN_HEADER header.
 * This authorizer compares that header to the secret in constant time.
 *
 * Fails closed:
 *  - header missing       -> API Gateway answers 401 itself (identity source),
 *                            and the handler below also denies.
 *  - header wrong         -> Deny policy -> 403.
 *  - secret unreadable or
 *    empty                -> Deny policy -> 403.
 * No integration (Lambda or Step Functions) runs unless this returns Allow.
 *
 * The header value and the secret are never logged.
 */

const crypto = require('crypto');
const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');

const WEBHOOK_TOKEN_HEADER = 'x-mimir-webhook-token';
// Re-read the secret at most this often so a rotated value is picked up
// without a redeploy.
const SECRET_CACHE_MS = 5 * 60 * 1000;
// Generated secrets are 64 characters; anything this short is treated as
// unset so an empty or placeholder secret can never authorize a request.
const MIN_TOKEN_LENGTH = 32;

const secretsClient = new SecretsManagerClient();
let cachedToken = null;
let cachedAt = 0;

async function getExpectedToken() {
  if (cachedToken && Date.now() - cachedAt < SECRET_CACHE_MS) return cachedToken;
  const res = await secretsClient.send(new GetSecretValueCommand({ SecretId: process.env.WEBHOOK_TOKEN_SECRET_ARN }));
  cachedToken = res.SecretString || '';
  cachedAt = Date.now();
  return cachedToken;
}

function headerValue(headers, name) {
  if (!headers) return undefined;
  const key = Object.keys(headers).find((h) => h.toLowerCase() === name);
  return key === undefined ? undefined : headers[key];
}

/**
 * Constant-time string comparison. Hashing both sides first gives equal-length
 * buffers, so neither the content nor the length of the expected token leaks
 * through timing.
 */
function tokensMatch(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string') return false;
  if (expected.length < MIN_TOKEN_LENGTH || provided.length === 0) return false;
  const a = crypto.createHash('sha256').update(provided, 'utf8').digest();
  const b = crypto.createHash('sha256').update(expected, 'utf8').digest();
  return crypto.timingSafeEqual(a, b);
}

/**
 * Policy on every method of this API stage, not just event.methodArn: the
 * result is cached per token (resultsCacheTtl), and a cached policy scoped to
 * one route would wrongly deny the other webhook routes.
 */
function policy(effect, methodArn) {
  // methodArn: arn:aws:execute-api:<region>:<account>:<apiId>/<stage>/<verb>/<path>
  const [arnPrefix, stage] = String(methodArn).split('/');
  return {
    principalId: 'mimir-webhook',
    policyDocument: {
      Version: '2012-10-17',
      Statement: [{
        Action: 'execute-api:Invoke',
        Effect: effect,
        Resource: stage ? `${arnPrefix}/${stage}/*/*` : String(methodArn),
      }],
    },
  };
}

exports.handler = async (event) => {
  const provided = headerValue(event.headers, WEBHOOK_TOKEN_HEADER);
  let expected;
  try {
    expected = await getExpectedToken();
  } catch (err) {
    console.error(`Webhook authorizer: could not read token secret (${err.name}); denying`);
    return policy('Deny', event.methodArn);
  }
  if (tokensMatch(provided, expected)) return policy('Allow', event.methodArn);
  console.warn(`Webhook authorizer: ${provided === undefined ? 'missing' : 'invalid'} ${WEBHOOK_TOKEN_HEADER} header; denying`);
  return policy('Deny', event.methodArn);
};

module.exports.WEBHOOK_TOKEN_HEADER = WEBHOOK_TOKEN_HEADER;
module.exports.tokensMatch = tokensMatch;
module.exports._resetCache = () => { cachedToken = null; cachedAt = 0; };
