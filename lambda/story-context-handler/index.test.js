const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { callSagaApi, checkTranscript, enrichAssets } = require('./index.js');

// Helper to mock global fetch
function mockFetch(handler) {
  const calls = [];
  global.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return handler(url, opts);
  };
  return calls;
}

describe('callSagaApi', () => {
  it('returns parsed JSON on 200 response', async () => {
    const expected = { id: '123', title: 'Test Story' };
    mockFetch(() => ({
      ok: true,
      status: 200,
      json: async () => expected,
    }));

    const result = await callSagaApi('https://api.saga.test', '/stories/123', 'test-key');
    assert.deepStrictEqual(result, expected);
  });

  it('throws error containing endpoint path and status code on 404', async () => {
    mockFetch(() => ({
      ok: false,
      status: 404,
      json: async () => ({}),
    }));

    await assert.rejects(
      () => callSagaApi('https://api.saga.test', '/stories/123/assets', 'test-key'),
      (err) => {
        assert.ok(err.message.includes('/stories/123/assets'), 'Error should contain endpoint path');
        assert.ok(err.message.includes('404'), 'Error should contain status code');
        return true;
      }
    );
  });

  it('throws error containing endpoint path and status code on 500', async () => {
    mockFetch(() => ({
      ok: false,
      status: 500,
      json: async () => ({}),
    }));

    await assert.rejects(
      () => callSagaApi('https://api.saga.test', '/stories/456/notes', 'key'),
      (err) => {
        assert.ok(err.message.includes('/stories/456/notes'));
        assert.ok(err.message.includes('500'));
        return true;
      }
    );
  });

  it('throws error containing endpoint path and status code on 403', async () => {
    mockFetch(() => ({
      ok: false,
      status: 403,
      json: async () => ({}),
    }));

    await assert.rejects(
      () => callSagaApi('https://api.saga.test', '/stories/789/instances', 'key'),
      (err) => {
        assert.ok(err.message.includes('/stories/789/instances'));
        assert.ok(err.message.includes('403'));
        return true;
      }
    );
  });

  it('sends x-api-key header with the provided API key', async () => {
    const calls = mockFetch(() => ({
      ok: true,
      status: 200,
      json: async () => ({}),
    }));

    await callSagaApi('https://api.saga.test', '/stories/1', 'my-secret-key');
    assert.equal(calls[0].opts.headers['x-api-key'], 'my-secret-key');
  });

  it('constructs the full URL from baseUrl and path', async () => {
    const calls = mockFetch(() => ({
      ok: true,
      status: 200,
      json: async () => ({}),
    }));

    await callSagaApi('https://api.saga.test', '/stories/42/assets', 'key');
    assert.equal(calls[0].url, 'https://api.saga.test/stories/42/assets');
  });
});

describe('checkTranscript', () => {
  it('returns hasTranscript true when timedTranscriptUrl is present', async () => {
    mockFetch(() => ({
      ok: true,
      status: 200,
      json: async () => ({ timedTranscriptUrl: 'https://cdn.example.com/transcript.json' }),
    }));

    const result = await checkTranscript('item-123', 'mimir-key');
    assert.equal(result.hasTranscript, true);
    assert.equal(result.timedTranscriptUrl, 'https://cdn.example.com/transcript.json');
  });

  it('returns hasTranscript false when timedTranscriptUrl is empty string', async () => {
    mockFetch(() => ({
      ok: true,
      status: 200,
      json: async () => ({ timedTranscriptUrl: '' }),
    }));

    const result = await checkTranscript('item-123', 'mimir-key');
    assert.equal(result.hasTranscript, false);
    assert.equal(result.timedTranscriptUrl, undefined);
  });

  it('returns hasTranscript false when timedTranscriptUrl is missing', async () => {
    mockFetch(() => ({
      ok: true,
      status: 200,
      json: async () => ({ id: 'item-123', title: 'Some Video' }),
    }));

    const result = await checkTranscript('item-123', 'mimir-key');
    assert.equal(result.hasTranscript, false);
  });

  it('returns hasTranscript false on Mimir API error', async () => {
    mockFetch(() => ({
      ok: false,
      status: 500,
    }));

    const result = await checkTranscript('item-123', 'mimir-key');
    assert.equal(result.hasTranscript, false);
  });

  it('returns hasTranscript false on network error', async () => {
    global.fetch = async () => { throw new Error('Network error'); };

    const result = await checkTranscript('item-123', 'mimir-key');
    assert.equal(result.hasTranscript, false);
  });

  it('sends correct Mimir auth header', async () => {
    const calls = mockFetch(() => ({
      ok: true,
      status: 200,
      json: async () => ({}),
    }));

    await checkTranscript('item-456', 'my-mimir-key');
    assert.equal(calls[0].opts.headers['x-mimir-cognito-id-token'], 'Bearer my-mimir-key');
  });

  it('calls the correct Mimir API URL', async () => {
    const calls = mockFetch(() => ({
      ok: true,
      status: 200,
      json: async () => ({}),
    }));

    await checkTranscript('item-789', 'key');
    assert.equal(calls[0].url, 'https://us.mjoll.no/api/v1/items/item-789');
  });
});

describe('enrichAssets', () => {
  // Set env vars for checkEmbeddings (it will fail gracefully since no real S3 Vectors client)
  beforeEach(() => {
    process.env.VECTOR_BUCKET_NAME = 'test-bucket';
    process.env.VECTOR_INDEX_NAME = 'test-index';
  });

  it('returns enriched list with same length as input', async () => {
    // Mock fetch for Mimir API calls (checkTranscript)
    mockFetch(() => ({
      ok: true,
      status: 200,
      json: async () => ({ timedTranscriptUrl: 'https://cdn.example.com/t.json' }),
    }));

    const assets = [
      { id: 'a1', mimirItemId: 'mimir-1', title: 'Video 1', itemType: 'video' },
      { id: 'a2', mimirItemId: 'mimir-2', title: 'Video 2', itemType: 'video' },
    ];

    // checkEmbeddings will fail gracefully (no real S3 Vectors client) → hasEmbeddings: false
    const result = await enrichAssets(assets, 'mimir-key');
    assert.equal(result.length, assets.length);
  });

  it('includes all required fields in enriched assets', async () => {
    mockFetch(() => ({
      ok: true,
      status: 200,
      json: async () => ({ timedTranscriptUrl: 'https://cdn.example.com/t.json' }),
    }));

    const assets = [
      { id: 'a1', mimirItemId: 'mimir-1', title: 'Video 1', itemType: 'video' },
    ];

    const result = await enrichAssets(assets, 'key');
    const enriched = result[0];

    assert.equal(enriched.id, 'a1');
    assert.equal(enriched.mimirItemId, 'mimir-1');
    assert.equal(enriched.title, 'Video 1');
    assert.equal(enriched.itemType, 'video');
    assert.equal(typeof enriched.hasEmbeddings, 'boolean');
    assert.equal(typeof enriched.hasTranscript, 'boolean');
  });

  it('sets warning when both hasEmbeddings and hasTranscript are false', async () => {
    // Mimir returns no transcript
    mockFetch(() => ({
      ok: true,
      status: 200,
      json: async () => ({}),
    }));

    const assets = [
      { id: 'a1', mimirItemId: 'mimir-1', title: 'Video 1', itemType: 'video' },
    ];

    // checkEmbeddings will fail gracefully → false, checkTranscript → false (no timedTranscriptUrl)
    const result = await enrichAssets(assets, 'key');
    assert.equal(result[0].hasEmbeddings, false);
    assert.equal(result[0].hasTranscript, false);
    assert.ok(result[0].warning, 'Should have a warning message');
    assert.ok(result[0].warning.includes('no embeddings or transcript'), 'Warning should mention limited searchability');
  });

  it('does not set warning when hasTranscript is true', async () => {
    mockFetch(() => ({
      ok: true,
      status: 200,
      json: async () => ({ timedTranscriptUrl: 'https://cdn.example.com/t.json' }),
    }));

    const assets = [
      { id: 'a1', mimirItemId: 'mimir-1', title: 'Video 1', itemType: 'video' },
    ];

    const result = await enrichAssets(assets, 'key');
    assert.equal(result[0].hasTranscript, true);
    assert.equal(result[0].warning, undefined);
  });

  it('handles empty asset list', async () => {
    const result = await enrichAssets([], 'key');
    assert.equal(result.length, 0);
  });
});
