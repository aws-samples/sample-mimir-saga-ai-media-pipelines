/**
 * CDK Custom Resource Lambda: Register Mimir Custom Actions & Webhooks
 * 
 * Idempotently creates or updates:
 * - Custom actions (Summarize, Chapterize) in Mimir
 * - Webhooks (item creation → embedding pipeline) in Mimir
 * 
 * On Delete: removes the registered custom actions and webhooks.
 */

const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');

const secretsClient = new SecretsManagerClient();

// ---------------------------------------------------------------------------
// MDF schema for the Reframe + Graphics custom action.
//
// Four producer-editable fields that each override one slot of the auto-
// generated graphics overlay. The `fieldId` values here are the keys Mimir
// posts back on the webhook as `actionData[fieldId]`, so downstream Lambdas
// (mimir-handler, classify-category-handler, vertical-reframe-handler) read
// them by these exact names.
//
// Schema shape follows Mimir's MdfField + LayoutSettings contract:
//   fields[] carry the data model (id/fieldId/type/required/alternatives)
//   view[]   carries the UI layout (id/fieldId/label/visible/flex)
// Labels live on the view entry, not on the field itself. Setting a label on
// the field is silently dropped and the admin UI then shows the Metadata tab
// with empty rows (observed on the first deploy of this action).
//
// Field IDs are deterministic (fixed UUIDs) so re-registering the action in
// place keeps a stable identity.
// ---------------------------------------------------------------------------
const REFRAME_WITH_GRAPHICS_FIELD_IDS = {
  title:       'a1b2c3d4-0000-4000-8000-000000000001',
  summary:     'a1b2c3d4-0000-4000-8000-000000000002',
  gfxTemplate: 'a1b2c3d4-0000-4000-8000-000000000003',
  toa:         'a1b2c3d4-0000-4000-8000-000000000004',
};

// Choice options for `gfx_template`. These values are the ONLY ones the
// classifier Lambda is allowed to pick from when auto-selecting, so what the
// producer sees in the dropdown and what the AI picks always align.
const GFX_TEMPLATE_OPTIONS = [
  'BREAKING NEWS',
  'ENTERTAINMENT NEWS',
  'LOCAL NEWS',
  'NATIONAL NEWS',
  'NEWS & POLITICS',
  'SPORTS',
  'WEATHER',
  'WORLD NEWS',
];

// Exported so tests and the deploy-time dry-run can validate the shape
// without executing the custom-resource handler.
module.exports.REFRAME_WITH_GRAPHICS_FIELD_IDS = REFRAME_WITH_GRAPHICS_FIELD_IDS;
module.exports.GFX_TEMPLATE_OPTIONS = GFX_TEMPLATE_OPTIONS;

const REFRAME_WITH_GRAPHICS_MDF_SCHEMAS = {
  mainSchema: {
    id: 'a1b2c3d4-0000-4000-8000-000000000000',
    label: 'Reframe + Graphics metadata',
    active: true,
    isSubtype: false,
    fields: [
      {
        id: REFRAME_WITH_GRAPHICS_FIELD_IDS.title,
        fieldId: 'title',
        type: 'text',
        required: false,
      },
      {
        id: REFRAME_WITH_GRAPHICS_FIELD_IDS.summary,
        fieldId: 'summary',
        type: 'text',
        required: false,
      },
      {
        id: REFRAME_WITH_GRAPHICS_FIELD_IDS.gfxTemplate,
        fieldId: 'gfx_template',
        type: 'choice',
        required: false,
        alternatives: GFX_TEMPLATE_OPTIONS.map((v) => ({
          value: v,
          label: v,
        })),
      },
      {
        id: REFRAME_WITH_GRAPHICS_FIELD_IDS.toa,
        fieldId: 'toa',
        type: 'checkbox',
        required: false,
      },
    ],
    view: [
      {
        id: REFRAME_WITH_GRAPHICS_FIELD_IDS.title,
        fieldId: 'title',
        visible: true,
        label: 'Title',
        flex: 12,
      },
      {
        id: REFRAME_WITH_GRAPHICS_FIELD_IDS.summary,
        fieldId: 'summary',
        visible: true,
        label: 'Summary',
        flex: 12,
      },
      {
        id: REFRAME_WITH_GRAPHICS_FIELD_IDS.gfxTemplate,
        fieldId: 'gfx_template',
        visible: true,
        label: 'GFX',
        flex: 12,
      },
      {
        id: REFRAME_WITH_GRAPHICS_FIELD_IDS.toa,
        fieldId: 'toa',
        visible: true,
        label: 'Add Text on Scr',
        flex: 12,
      },
    ],
  },
  subTypes: [],
};

module.exports.REFRAME_WITH_GRAPHICS_MDF_SCHEMAS = REFRAME_WITH_GRAPHICS_MDF_SCHEMAS;

async function getMimirApiKey(secretArn) {
  const response = await secretsClient.send(new GetSecretValueCommand({ SecretId: secretArn }));
  return response.SecretString;
}

async function mimirRequest(method, path, apiKey, mimirBaseUrl, body = null) {
  const url = `${mimirBaseUrl}${path}`;
  const options = {
    method,
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'x-mimir-cognito-id-token': `Bearer ${apiKey}`
    }
  };
  if (body) {
    options.body = JSON.stringify(body);
  }
  const response = await fetch(url, options);
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: response.status, ok: response.ok, data };
}

async function registerCustomActions(apiKey, mimirBaseUrl, actionsApiUrl) {
  const customActions = [
    {
      label: 'Summarize',
      tooltip: 'Generate AI summary using Bedrock',
      url: `${actionsApiUrl}summarizer`,
      externalId: 'summarizer',
      icon: '',
      includeJWT: true,
      allowedBy: { type: 'everyone' },
      mdfSchemas: null,
      metadataEnabled: false
    },
    {
      label: 'Chapterize',
      tooltip: 'Generate chapter markers using AI',
      url: `${actionsApiUrl}chapterize`,
      externalId: 'chapterize',
      icon: '',
      includeJWT: true,
      allowedBy: { type: 'everyone' },
      mdfSchemas: null,
      metadataEnabled: false
    },
    {
      label: 'Reframe 9:16',
      tooltip: 'Create vertical (9:16) video using AI Smart Cropping',
      url: `${actionsApiUrl}reframe-9-16`,
      externalId: 'reframe-9-16',
      icon: '',
      includeJWT: true,
      allowedBy: { type: 'everyone' },
      mdfSchemas: null,
      metadataEnabled: false
    },
    {
      label: 'Reframe 1:1',
      tooltip: 'Create square (1:1) video using AI Smart Cropping',
      url: `${actionsApiUrl}reframe-1-1`,
      externalId: 'reframe-1-1',
      icon: '',
      includeJWT: true,
      allowedBy: { type: 'everyone' },
      mdfSchemas: null,
      metadataEnabled: false
    },
    {
      label: 'Reframe 4:5',
      tooltip: 'Create portrait (4:5) video using AI Smart Cropping',
      url: `${actionsApiUrl}reframe-4-5`,
      externalId: 'reframe-4-5',
      icon: '',
      includeJWT: true,
      allowedBy: { type: 'everyone' },
      mdfSchemas: null,
      metadataEnabled: false
    },
    {
      label: 'Reframe + Graphics',
      tooltip: 'Reframe video and add broadcast graphics overlay (AI category + headline)',
      url: `${actionsApiUrl}reframe-with-graphics`,
      externalId: 'reframe-with-graphics',
      icon: '',
      includeJWT: true,
      allowedBy: { type: 'everyone' },
      // Optional producer-supplied overrides for the graphics overlay.
      // When a field is left blank the pipeline falls back to the AI-generated
      // value (category, kicker lines, headline) for that slot. `toa` is a
      // strict opt-in — captions are only burned in when the box is checked.
      metadataEnabled: true,
      mdfSchemas: REFRAME_WITH_GRAPHICS_MDF_SCHEMAS,
    },
    {
      label: 'Reframe Custom',
      tooltip: 'Per-scene intelligent reframe: AI scene detection, CROP or TILE layout decision, broadcast graphics overlay',
      url: `${actionsApiUrl}reframe-custom`,
      externalId: 'reframe-custom',
      icon: '',
      includeJWT: true,
      allowedBy: { type: 'everyone' },
      mdfSchemas: null,
      metadataEnabled: false
    }
  ];

  // Get existing custom actions
  const existing = await mimirRequest('GET', '/config/api/v1/config/customActions', apiKey, mimirBaseUrl);
  const existingActions = existing.ok && Array.isArray(existing.data) ? existing.data : [];

  const results = [];

  for (const action of customActions) {
    const match = existingActions.find(a => a.externalId === action.externalId);

    if (match) {
      // Update existing action
      const updated = { ...action, id: match.id };
      const res = await mimirRequest('PUT', `/config/api/v1/config/customActions/${match.id}`, apiKey, mimirBaseUrl, updated);
      results.push({ action: action.externalId, operation: 'updated', status: res.status });
      console.log(`Updated custom action: ${action.externalId} (id: ${match.id}) → ${res.status}`);
    } else {
      // Create new action
      const res = await mimirRequest('POST', '/config/api/v1/config/customActions', apiKey, mimirBaseUrl, { ...action, id: '' });
      results.push({ action: action.externalId, operation: 'created', status: res.status });
      console.log(`Created custom action: ${action.externalId} → ${res.status}`);
    }
  }

  return results;
}

async function registerWebhooks(apiKey, mimirBaseUrl, webhookApiUrl) {
  const webhooks = [
    {
      type: 'itemCreation',
      label: 'Embed Video Content',
      url: `${webhookApiUrl}webhook/item-embed`,
      condition: { criteria: 'itemTypeEquals', itemType: 'video' },
      headers: [
        { headerField: 'Content-Type', headerValue: 'application/json' }
      ],
      protected: false
    }
  ];

  // Get existing webhooks
  const existing = await mimirRequest('GET', '/config/api/v1/config/webhooks', apiKey, mimirBaseUrl);
  const existingWebhooks = existing.ok && Array.isArray(existing.data) ? existing.data : [];

  const results = [];

  for (const webhook of webhooks) {
    // Match by label (webhooks don't have externalId)
    const match = existingWebhooks.find(w => w.label === webhook.label);

    if (match) {
      // Update existing webhook
      const res = await mimirRequest('PUT', `/config/api/v1/config/webhooks/${match.id}`, apiKey, mimirBaseUrl, { ...webhook, id: match.id });
      results.push({ webhook: webhook.label, operation: 'updated', status: res.status });
      console.log(`Updated webhook: ${webhook.label} (id: ${match.id}) → ${res.status}`);
    } else {
      // Create new webhook
      const res = await mimirRequest('POST', '/config/api/v1/config/webhooks', apiKey, mimirBaseUrl, webhook);
      results.push({ webhook: webhook.label, operation: 'created', status: res.status });
      console.log(`Created webhook: ${webhook.label} → ${res.status}`);
    }
  }

  return results;
}

async function deleteCustomActions(apiKey, mimirBaseUrl) {
  const existing = await mimirRequest('GET', '/config/api/v1/config/customActions', apiKey, mimirBaseUrl);
  const existingActions = existing.ok && Array.isArray(existing.data) ? existing.data : [];

  const ourExternalIds = ['summarizer', 'chapterize', 'vertical-reframe', 'reframe-9-16', 'reframe-1-1', 'reframe-4-5', 'reframe-with-graphics', 'reframe-custom'];

  for (const action of existingActions) {
    if (ourExternalIds.includes(action.externalId)) {
      await mimirRequest('DELETE', `/config/api/v1/config/customActions/${action.id}`, apiKey, mimirBaseUrl);
      console.log(`Deleted custom action: ${action.externalId} (id: ${action.id})`);
    }
  }
}

async function deleteWebhooks(apiKey, mimirBaseUrl) {
  const existing = await mimirRequest('GET', '/config/api/v1/config/webhooks', apiKey, mimirBaseUrl);
  const existingWebhooks = existing.ok && Array.isArray(existing.data) ? existing.data : [];

  const ourLabels = ['Embed Video Content'];

  for (const webhook of existingWebhooks) {
    if (ourLabels.includes(webhook.label)) {
      await mimirRequest('DELETE', `/config/api/v1/config/webhooks/${webhook.id}`, apiKey, mimirBaseUrl);
      console.log(`Deleted webhook: ${webhook.label} (id: ${webhook.id})`);
    }
  }
}

async function sendResponse(event, context, status, reason, data = {}) {
  const responseBody = {
    Status: status,
    Reason: reason,
    PhysicalResourceId: 'mimir-integrations-registration',
    StackId: event.StackId,
    RequestId: event.RequestId,
    LogicalResourceId: event.LogicalResourceId,
    Data: data
  };

  const { default: https } = await import('https');
  const url = new URL(event.ResponseURL);

  return new Promise((resolve, reject) => {
    const body = JSON.stringify(responseBody);
    const options = {
      hostname: url.hostname,
      port: 443,
      path: url.pathname + url.search,
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    };

    const req = https.request(options, (res) => resolve(res.statusCode));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

exports.handler = async (event, context) => {
  console.log('Event:', JSON.stringify(event, null, 2));

  const props = event.ResourceProperties;
  const mimirApiKeySecretArn = props.MimirApiKeySecretArn;
  const mimirBaseUrl = props.MimirBaseUrl;
  const actionsApiUrl = props.ActionsApiUrl;
  const webhookApiUrl = props.WebhookApiUrl;

  try {
    const apiKey = await getMimirApiKey(mimirApiKeySecretArn);

    if (event.RequestType === 'Create' || event.RequestType === 'Update') {
      console.log(`Registering Mimir integrations (${event.RequestType})...`);
      console.log(`  Mimir: ${mimirBaseUrl}`);
      console.log(`  Actions API: ${actionsApiUrl}`);
      console.log(`  Webhook API: ${webhookApiUrl}`);

      const actionResults = await registerCustomActions(apiKey, mimirBaseUrl, actionsApiUrl);
      const webhookResults = await registerWebhooks(apiKey, mimirBaseUrl, webhookApiUrl);

      await sendResponse(event, context, 'SUCCESS', 'Mimir integrations registered', {
        CustomActions: JSON.stringify(actionResults),
        Webhooks: JSON.stringify(webhookResults)
      });

    } else if (event.RequestType === 'Delete') {
      console.log('Removing Mimir integrations...');
      await deleteCustomActions(apiKey, mimirBaseUrl);
      await deleteWebhooks(apiKey, mimirBaseUrl);
      await sendResponse(event, context, 'SUCCESS', 'Mimir integrations removed');
    }

  } catch (error) {
    console.error('Error:', error);
    // Don't fail the stack on registration errors — Mimir might be unreachable
    await sendResponse(event, context, 'SUCCESS', `Warning: ${error.message}`);
  }
};
