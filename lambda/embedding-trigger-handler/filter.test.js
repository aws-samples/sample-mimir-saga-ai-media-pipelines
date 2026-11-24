const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  readFilterFromEnv, matchesFilter, valueMatches, pickFormData,
  lookupFieldUuid, resolveFieldUuid, handleFilter, clearCache,
} = require('./filter.js');

const STATION_UUID = 'edd3e918-f7e2-476c-b84f-1f8175919991';
const filter = { field: 'station', fieldKey: null, values: ['WXYZ', 'KABC'] };

/** Fake fetch serving MDF definitions; records requested paths and headers. */
function fakeMimir({ defaultFields = [], collection = [], status = 200 } = {}) {
  const calls = [];
  const fetchFn = async (url, opts) => {
    calls.push({ path: new URL(url).pathname, headers: opts.headers });
    const path = new URL(url).pathname;
    const body = path === '/api/v1/mdfs/default'
      ? { id: 'default', fields: defaultFields }
      : { _embedded: { collection } };
    return { ok: status === 200, status, json: async () => body };
  };
  return { fetchFn, calls };
}

const stationDefaultFields = [
  { fieldId: 'title', id: 'aaaa', type: 'text' },
  { fieldId: 'Station', id: STATION_UUID, type: 'choice' },
];

function captureLogs(fn) {
  const logs = [];
  const original = console.log;
  console.log = (msg) => logs.push(msg);
  return Promise.resolve().then(fn).finally(() => { console.log = original; }).then((r) => ({ r, logs }));
}

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

  it('reads the optional explicit formData key', () => {
    const f = readFilterFromEnv({
      EMBEDDINGS_FILTER_FIELD: 'Station', EMBEDDINGS_FILTER_VALUES: '["WKEF"]', EMBEDDINGS_FILTER_FIELD_KEY: ` ${STATION_UUID} `,
    });
    assert.equal(f.fieldKey, STATION_UUID);
  });

  it('throws when field is set without values', () => {
    assert.throws(() => readFilterFromEnv({ EMBEDDINGS_FILTER_FIELD: 'station' }), /non-empty/);
    assert.throws(() => readFilterFromEnv({ EMBEDDINGS_FILTER_FIELD: 'station', EMBEDDINGS_FILTER_VALUES: 'WXYZ' }), /JSON array/);
  });
});

describe('valueMatches (value shapes)', () => {
  const values = ['WKEF'];
  it('plain string', () => {
    assert.equal(valueMatches('WKEF', values), true);
    assert.equal(valueMatches('WBFF', values), false);
  });
  it('is case-sensitive and exact', () => {
    assert.equal(valueMatches('wkef', values), false);
    assert.equal(valueMatches('WKEF ', values), false);
  });
  it('array (multiplechoice / treechoice): any element', () => {
    assert.equal(valueMatches(['WBFF', 'WKEF'], values), true);
    assert.equal(valueMatches(['WBFF'], values), false);
    assert.equal(valueMatches([], values), false);
  });
  it('{value,label} object, matched on value', () => {
    assert.equal(valueMatches({ value: 'WKEF', label: 'WKEF' }, values), true);
    assert.equal(valueMatches({ value: 'WBFF', label: 'WKEF' }, values), false);
    assert.equal(valueMatches({ label: 'WKEF' }, values), false);
  });
  it('array of {value,label} objects', () => {
    assert.equal(valueMatches([{ value: 'WBFF', label: 'WBFF' }, { value: 'WKEF', label: 'WKEF' }], values), true);
  });
  it('missing and null', () => {
    assert.equal(valueMatches(undefined, values), false);
    assert.equal(valueMatches(null, values), false);
    assert.equal(valueMatches([null], values), false);
  });
  it('numbers and booleans by string form', () => {
    assert.equal(valueMatches(7, ['7']), true);
    assert.equal(valueMatches(true, ['true']), true);
  });
});

describe('matchesFilter', () => {
  it('matches everything when no filter is configured', () => {
    assert.equal(matchesFilter({}, null), true);
  });
  it('uses fieldKey when set, else field', () => {
    assert.equal(matchesFilter({ station: 'WXYZ' }, filter), true);
    assert.equal(matchesFilter({ k: 'WXYZ' }, { ...filter, fieldKey: 'k' }), true);
    assert.equal(matchesFilter(undefined, filter), false);
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

describe('lookupFieldUuid', () => {
  it('finds the field in the default MDF with one GET and sends the API key header', async () => {
    const m = fakeMimir({ defaultFields: stationDefaultFields });
    const uuid = await lookupFieldUuid('Station', { fetchFn: m.fetchFn, apiKey: 'k', baseUrl: 'https://us.mjoll.no' });
    assert.equal(uuid, STATION_UUID);
    assert.deepEqual(m.calls.map((c) => c.path), ['/api/v1/mdfs/default']);
    assert.equal(m.calls[0].headers['x-mimir-cognito-id-token'], 'Bearer k');
  });
  it('falls back to inline fields in the MDF list', async () => {
    const m = fakeMimir({ collection: [{ id: 'm1' }, { id: 'm2', fields: [{ fieldId: 'station_select', id: 'u-2' }] }] });
    assert.equal(await lookupFieldUuid('station_select', { fetchFn: m.fetchFn, apiKey: 'k', baseUrl: 'https://x' }), 'u-2');
    assert.deepEqual(m.calls.map((c) => c.path), ['/api/v1/mdfs/default', '/api/v1/mdfs']);
  });
  it('returns null when the field is unknown, throws on HTTP errors', async () => {
    assert.equal(await lookupFieldUuid('Nope', { ...fakeMimir(), apiKey: 'k', baseUrl: 'https://x' }), null);
    await assert.rejects(lookupFieldUuid('Station', { fetchFn: fakeMimir({ status: 500 }).fetchFn, apiKey: 'k', baseUrl: 'https://x' }), /500/);
  });
});

describe('resolveFieldUuid caching', () => {
  beforeEach(() => clearCache());
  it('caches a successful lookup per container', async () => {
    const m = fakeMimir({ defaultFields: stationDefaultFields });
    let keyCalls = 0;
    const deps = { fetchFn: m.fetchFn, getApiKey: async () => { keyCalls++; return 'k'; }, env: { MIMIR_API_BASE: 'https://x' } };
    assert.equal(await resolveFieldUuid('Station', deps), STATION_UUID);
    assert.equal(await resolveFieldUuid('Station', deps), STATION_UUID);
    assert.equal(m.calls.length, 1);
    assert.equal(keyCalls, 1);
  });
  it('does not cache a miss', async () => {
    const m = fakeMimir();
    const deps = { fetchFn: m.fetchFn, getApiKey: async () => 'k', env: {} };
    assert.equal(await resolveFieldUuid('Station', deps), null);
    assert.equal(await resolveFieldUuid('Station', deps), null);
    assert.equal(m.calls.length, 4);
  });
});

describe('handleFilter', () => {
  beforeEach(() => clearCache());
  const env = { EMBEDDINGS_FILTER_FIELD: 'Station', EMBEDDINGS_FILTER_VALUES: '["WKEF"]', MIMIR_API_BASE: 'https://x' };
  const item = (formData) => ({ itemId: 'item-1', mimirDetails: { metadata: { formData } } });
  const depsFor = (m, e = env) => ({ env: e, fetchFn: m.fetchFn, getApiKey: async () => 'k' });

  it('returns match true when no filter is configured (no lookup)', async () => {
    const m = fakeMimir();
    assert.deepEqual(await handleFilter({ itemId: 'i' }, depsFor(m, {})), { match: true });
    assert.equal(m.calls.length, 0);
  });

  it('resolves a real Mimir item keyed by the field UUID (Station=WKEF)', async () => {
    const m = fakeMimir({ defaultFields: stationDefaultFields });
    const formData = { default_title: 'x', [STATION_UUID]: 'WKEF' };
    assert.deepEqual(await handleFilter(item(formData), depsFor(m)), { match: true });
    assert.deepEqual(m.calls.map((c) => c.path), ['/api/v1/mdfs/default']);
  });

  it('skips an item whose UUID-keyed value is another station, logging the id only', async () => {
    const m = fakeMimir({ defaultFields: stationDefaultFields });
    const { r, logs } = await captureLogs(() => handleFilter(item({ [STATION_UUID]: 'WBFF' }), depsFor(m)));
    assert.deepEqual(r, { match: false });
    assert.deepEqual(logs, ['skipped: filter mismatch item=item-1']);
  });

  it('skips an item with the field unset once the field is resolved', async () => {
    const m = fakeMimir({ defaultFields: stationDefaultFields });
    assert.deepEqual(await handleFilter(item({ default_title: 'x' }), depsFor(m)), { match: false });
  });

  it('uses formData[field] then formData[default_field] without a lookup', async () => {
    const m = fakeMimir();
    assert.deepEqual(await handleFilter(item({ Station: 'WKEF' }), depsFor(m)), { match: true });
    assert.deepEqual(await handleFilter(item({ default_Station: 'WKEF' }), depsFor(m)), { match: true });
    assert.deepEqual(await handleFilter(item({ default_Station: 'WBFF' }), depsFor(m)), { match: false });
    assert.equal(m.calls.length, 0);
  });

  it('handles array and {value,label} shapes under the UUID key', async () => {
    const m = fakeMimir({ defaultFields: stationDefaultFields });
    assert.deepEqual(await handleFilter(item({ [STATION_UUID]: ['WBFF', 'WKEF'] }), depsFor(m)), { match: true });
    assert.deepEqual(await handleFilter(item({ [STATION_UUID]: { value: 'WKEF', label: 'WKEF' } }), depsFor(m)), { match: true });
    assert.deepEqual(await handleFilter(item({ [STATION_UUID]: [{ value: 'WBFF', label: 'WBFF' }] }), depsFor(m)), { match: false });
  });

  it('uses EMBEDDINGS_FILTER_FIELD_KEY when set and skips the lookup', async () => {
    const m = fakeMimir();
    const e = { ...env, EMBEDDINGS_FILTER_FIELD_KEY: STATION_UUID };
    assert.deepEqual(await handleFilter(item({ [STATION_UUID]: 'WKEF' }), depsFor(m, e)), { match: true });
    assert.deepEqual(await handleFilter(item({ [STATION_UUID]: 'WBFF', Station: 'WKEF' }), depsFor(m, e)), { match: false });
    assert.equal(m.calls.length, 0);
  });

  it('fails open with one log line when the field is not in any MDF', async () => {
    const m = fakeMimir({ defaultFields: [{ fieldId: 'title', id: 'aaaa' }] });
    const { r, logs } = await captureLogs(() => handleFilter(item({ x: 'WBFF' }), depsFor(m)));
    assert.deepEqual(r, { match: true });
    assert.equal(logs.length, 1);
    assert.match(logs[0], /field=Station item=item-1/);
    assert.match(logs[0], /not found/);
    assert.doesNotMatch(logs[0], /WBFF/);
  });

  it('fails open when the MDF lookup errors (HTTP or API key)', async () => {
    const { r, logs } = await captureLogs(() => handleFilter(item({}), depsFor(fakeMimir({ status: 503 }))));
    assert.deepEqual(r, { match: true });
    assert.match(logs[0], /lookup failed: GET \/api\/v1\/mdfs\/default -> 503/);
    const noKey = { env, fetchFn: fakeMimir().fetchFn, getApiKey: async () => { throw new Error('denied'); } };
    const res2 = await captureLogs(() => handleFilter(item({}), noKey));
    assert.deepEqual(res2.r, { match: true });
    assert.doesNotMatch(res2.logs[0], /Bearer/);
  });
});
