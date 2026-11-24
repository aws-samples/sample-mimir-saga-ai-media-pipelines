const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { readFilterFromEnv, matchesFilter, pickFormData, handleFilter } = require('./filter.js');

const filter = { field: 'station', values: ['WXYZ', 'KABC'] };

describe('readFilterFromEnv', () => {
  it('returns null when no field is configured', () => {
    assert.equal(readFilterFromEnv({}), null);
    assert.equal(readFilterFromEnv({ EMBEDDINGS_FILTER_FIELD: '  ' }), null);
  });

  it('parses field and JSON values', () => {
    assert.deepEqual(
      readFilterFromEnv({ EMBEDDINGS_FILTER_FIELD: 'station', EMBEDDINGS_FILTER_VALUES: '["WXYZ","KABC"]' }),
      filter,
    );
  });

  it('throws when field is set without values', () => {
    assert.throws(() => readFilterFromEnv({ EMBEDDINGS_FILTER_FIELD: 'station' }), /non-empty/);
    assert.throws(() => readFilterFromEnv({ EMBEDDINGS_FILTER_FIELD: 'station', EMBEDDINGS_FILTER_VALUES: 'WXYZ' }), /JSON array/);
  });
});

describe('matchesFilter', () => {
  it('matches everything when no filter is configured', () => {
    assert.equal(matchesFilter({}, null), true);
    assert.equal(matchesFilter(undefined, null), true);
  });

  it('matches a scalar value in the list', () => {
    assert.equal(matchesFilter({ station: 'WXYZ' }, filter), true);
    assert.equal(matchesFilter({ station: 'KABC' }, filter), true);
  });

  it('is case-sensitive and exact', () => {
    assert.equal(matchesFilter({ station: 'wxyz' }, filter), false);
    assert.equal(matchesFilter({ station: 'WXYZ ' }, filter), false);
  });

  it('rejects missing, null and other values', () => {
    assert.equal(matchesFilter({}, filter), false);
    assert.equal(matchesFilter({ station: null }, filter), false);
    assert.equal(matchesFilter({ station: 'KXYZ' }, filter), false);
    assert.equal(matchesFilter(undefined, filter), false);
  });

  it('matches array values when any element is in the list', () => {
    assert.equal(matchesFilter({ station: ['External - Network', 'WXYZ'] }, filter), true);
    assert.equal(matchesFilter({ station: ['External - Network', 'ABC'] }, filter), false);
    assert.equal(matchesFilter({ station: [] }, filter), false);
  });

  it('compares numbers and booleans by their string form', () => {
    assert.equal(matchesFilter({ channel: 7 }, { field: 'channel', values: ['7'] }), true);
    assert.equal(matchesFilter({ flag: true }, { field: 'flag', values: ['true'] }), true);
  });
});

describe('pickFormData', () => {
  it('prefers freshly fetched item metadata over the webhook payload', () => {
    const event = {
      metadata: { formData: { station: 'OLD' } },
      mimirDetails: { metadata: { formData: { station: 'WXYZ' } } },
    };
    assert.deepEqual(pickFormData(event), { station: 'WXYZ' });
  });

  it('falls back to the webhook payload, then to an empty object', () => {
    assert.deepEqual(pickFormData({ metadata: { formData: { station: 'WXYZ' } }, mimirDetails: {} }), { station: 'WXYZ' });
    assert.deepEqual(pickFormData({}), {});
  });
});

describe('handleFilter', () => {
  const env = { EMBEDDINGS_FILTER_FIELD: 'station', EMBEDDINGS_FILTER_VALUES: '["WXYZ"]' };

  it('returns match true for a matching item', () => {
    const event = { itemId: 'item-1', mimirDetails: { metadata: { formData: { station: 'WXYZ' } } } };
    assert.deepEqual(handleFilter(event, env), { match: true });
  });

  it('returns match false and logs only the item id on mismatch', () => {
    const logs = [];
    const original = console.log;
    console.log = (msg) => logs.push(msg);
    try {
      const event = { itemId: 'item-2', mimirDetails: { metadata: { formData: { station: 'SECRET-OTHER' } } } };
      assert.deepEqual(handleFilter(event, env), { match: false });
    } finally {
      console.log = original;
    }
    assert.deepEqual(logs, ['skipped: filter mismatch item=item-2']);
  });

  it('returns match true when no filter is configured', () => {
    assert.deepEqual(handleFilter({ itemId: 'item-3' }, {}), { match: true });
  });
});
