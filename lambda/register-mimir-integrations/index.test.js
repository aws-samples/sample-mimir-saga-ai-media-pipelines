const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  EMBED_WEBHOOK_LABEL,
  isEmbedWebhookLabel,
  parseEmbeddingsFilter,
  buildEmbedWebhooks,
  registerWebhooks,
} = require('./index.js');

const API = 'https://abc.execute-api.us-east-1.amazonaws.com/prod/';
const MIMIR = 'https://us.mjoll.no';

describe('parseEmbeddingsFilter', () => {
  it('returns null for an empty or missing property', () => {
    assert.equal(parseEmbeddingsFilter(undefined), null);
    assert.equal(parseEmbeddingsFilter(''), null);
  });

  it('parses and de-duplicates values', () => {
    assert.deepEqual(
      parseEmbeddingsFilter(JSON.stringify({ field: ' station ', values: ['WXYZ', 'WXYZ', 'KABC'] })),
      { field: 'station', values: ['WXYZ', 'KABC'] },
    );
  });

  it('rejects a field without values and values without a field', () => {
    assert.throws(() => parseEmbeddingsFilter(JSON.stringify({ field: 'station', values: [] })));
    assert.throws(() => parseEmbeddingsFilter(JSON.stringify({ field: '', values: ['WXYZ'] })));
  });
});

describe('buildEmbedWebhooks', () => {
  it('builds the single unfiltered webhook when there is no filter', () => {
    const hooks = buildEmbedWebhooks(API, null);
    assert.equal(hooks.length, 1);
    assert.equal(hooks[0].label, EMBED_WEBHOOK_LABEL);
    assert.equal(hooks[0].type, 'itemCreation');
    assert.equal(hooks[0].url, `${API}webhook/item-embed`);
    assert.deepEqual(hooks[0].condition, { criteria: 'itemTypeEquals', itemType: 'video' });
  });

  it('builds one AND-conditioned webhook per filter value', () => {
    const hooks = buildEmbedWebhooks(API, { field: 'station', values: ['WXYZ', 'KABC'] });
    assert.deepEqual(hooks.map((h) => h.label), [
      'Embed Video Content [station=WXYZ]',
      'Embed Video Content [station=KABC]',
    ]);
    assert.deepEqual(hooks[0].condition, {
      criteria: 'and',
      conditions: [
        { criteria: 'itemTypeEquals', itemType: 'video' },
        { criteria: 'metadataEquals', metadataField: 'station', value: 'WXYZ' },
      ],
    });
    for (const h of hooks) {
      assert.equal(h.type, 'itemCreation');
      assert.equal(h.url, `${API}webhook/item-embed`);
      assert.equal(isEmbedWebhookLabel(h.label), true);
    }
  });

  it('recognises only our labels', () => {
    assert.equal(isEmbedWebhookLabel('Embed Video Content'), true);
    assert.equal(isEmbedWebhookLabel('Embed Video Content [a=b]'), true);
    assert.equal(isEmbedWebhookLabel('Embed Video Content Staging'), false);
    assert.equal(isEmbedWebhookLabel('Item Creation Webhook - Staging'), false);
    assert.equal(isEmbedWebhookLabel(undefined), false);
  });
});

describe('registerWebhooks', () => {
  const originalFetch = global.fetch;
  afterEach(() => { global.fetch = originalFetch; });

  // Fake Mimir webhook config API backed by an in-memory list.
  function fakeMimir(initial, { failPost = false } = {}) {
    const store = initial.map((w) => ({ ...w }));
    const calls = [];
    let nextId = 100;
    global.fetch = async (url, opts) => {
      const method = opts.method;
      const path = url.replace(MIMIR, '');
      calls.push(`${method} ${path}`);
      const reply = (status, data) => ({ status, ok: status < 300, text: async () => JSON.stringify(data) });
      if (method === 'GET') return reply(200, store);
      if (method === 'POST') {
        if (failPost) return reply(500, { error: 'boom' });
        const body = JSON.parse(opts.body);
        const created = { ...body, id: String(nextId++) };
        store.push(created);
        return reply(200, created);
      }
      const id = path.split('/').pop();
      const idx = store.findIndex((w) => w.id === id);
      if (method === 'PUT') { store[idx] = JSON.parse(opts.body); return reply(200, store[idx]); }
      if (method === 'DELETE') { store.splice(idx, 1); return reply(204, {}); }
      throw new Error(`unexpected ${method}`);
    };
    return { store, calls };
  }

  const other = { id: '9', label: 'Item Creation Webhook - Staging', condition: { criteria: 'always' } };
  const unfiltered = { id: '1', label: 'Embed Video Content', condition: { criteria: 'itemTypeEquals', itemType: 'video' } };

  it('updates the unfiltered webhook in place when no filter is set (idempotent)', async () => {
    const { store, calls } = fakeMimir([unfiltered, other]);
    await registerWebhooks('k', MIMIR, API, null);
    assert.deepEqual(calls, ['GET /config/api/v1/config/webhooks', 'PUT /config/api/v1/config/webhooks/1']);
    assert.equal(store.length, 2);
  });

  it('replaces the unfiltered webhook with filtered ones, leaving others alone', async () => {
    const { store, calls } = fakeMimir([unfiltered, other]);
    await registerWebhooks('k', MIMIR, API, { field: 'station', values: ['WXYZ', 'KABC'] });
    assert.deepEqual(calls, [
      'GET /config/api/v1/config/webhooks',
      'POST /config/api/v1/config/webhooks',
      'POST /config/api/v1/config/webhooks',
      'DELETE /config/api/v1/config/webhooks/1',
    ]);
    assert.deepEqual(store.map((w) => w.label).sort(), [
      'Embed Video Content [station=KABC]',
      'Embed Video Content [station=WXYZ]',
      'Item Creation Webhook - Staging',
    ]);
  });

  it('a second deploy with the same filter only updates (no duplicates)', async () => {
    const { store } = fakeMimir([unfiltered, other]);
    const f = { field: 'station', values: ['WXYZ'] };
    await registerWebhooks('k', MIMIR, API, f);
    const after1 = store.map((w) => w.id).sort();
    await registerWebhooks('k', MIMIR, API, f);
    assert.deepEqual(store.map((w) => w.id).sort(), after1);
    assert.equal(store.filter((w) => isEmbedWebhookLabel(w.label)).length, 1);
  });

  it('removes duplicate and dropped-value webhooks', async () => {
    const { store } = fakeMimir([
      { id: '2', label: 'Embed Video Content [station=WXYZ]' },
      { id: '3', label: 'Embed Video Content [station=WXYZ]' },
      { id: '4', label: 'Embed Video Content [station=KABC]' },
      other,
    ]);
    await registerWebhooks('k', MIMIR, API, { field: 'station', values: ['WXYZ'] });
    assert.deepEqual(store.map((w) => w.id).sort(), ['2', '9']);
  });

  it('clearing the filter restores the single unfiltered webhook', async () => {
    const { store } = fakeMimir([{ id: '2', label: 'Embed Video Content [station=WXYZ]' }, other]);
    await registerWebhooks('k', MIMIR, API, null);
    const ours = store.filter((w) => isEmbedWebhookLabel(w.label));
    assert.equal(ours.length, 1);
    assert.equal(ours[0].label, EMBED_WEBHOOK_LABEL);
  });

  it('keeps the existing webhook when creating the filtered one fails', async () => {
    const { store, calls } = fakeMimir([unfiltered, other], { failPost: true });
    await registerWebhooks('k', MIMIR, API, { field: 'station', values: ['WXYZ'] });
    assert.equal(calls.some((c) => c.startsWith('DELETE')), false);
    assert.equal(store.some((w) => w.id === '1'), true);
  });

  it('EnableEmbeddingsWebhook=false removes our webhooks and creates none', async () => {
    const { store, calls } = fakeMimir([unfiltered, { id: '2', label: 'Embed Video Content [station=WXYZ]' }, other]);
    await registerWebhooks('k', MIMIR, API, { field: 'station', values: ['WXYZ'] }, false);
    assert.equal(calls.some((c) => c.startsWith('POST') || c.startsWith('PUT')), false);
    assert.deepEqual(store.map((w) => w.id), ['9']);
  });

  it('throws instead of creating duplicates when the webhook list cannot be read', async () => {
    global.fetch = async () => ({ status: 503, ok: false, text: async () => 'down' });
    await assert.rejects(registerWebhooks('k', MIMIR, API, null), /Could not list Mimir webhooks/);
  });
});
