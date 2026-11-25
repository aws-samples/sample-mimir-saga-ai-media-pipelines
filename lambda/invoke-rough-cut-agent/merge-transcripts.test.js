const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { mergeGeneratedTranscripts } = require('./index');

const done = (id, uri) => ({ mimirItemId: id, status: 'completed', transcriptS3Uri: uri });

describe('mergeGeneratedTranscripts', () => {
  it('adds the transcript URI to matching assets only', () => {
    const out = mergeGeneratedTranscripts(
      [{ mimirItemId: 'a', title: 'A' }, { mimirItemId: 'b' }],
      [done('a', 's3://x/a'), { mimirItemId: 'b', status: 'failed', error: 'Error: proxyUrl is required' }],
    );
    assert.deepEqual(out, [{ mimirItemId: 'a', title: 'A', generatedTranscriptS3Uri: 's3://x/a' }, { mimirItemId: 'b' }]);
  });

  it('keeps a one-asset story as an array', () => {
    assert.deepEqual(mergeGeneratedTranscripts([{ mimirItemId: 'a' }], [done('a', 's3://x/a')]),
      [{ mimirItemId: 'a', generatedTranscriptS3Uri: 's3://x/a' }]);
  });

  it('uses the first URI when an asset appears twice in the results', () => {
    const out = mergeGeneratedTranscripts([{ mimirItemId: 'a' }], [done('a', 's3://x/1'), done('a', 's3://x/2')]);
    assert.equal(out[0].generatedTranscriptS3Uri, 's3://x/1');
  });

  it('skips empty URIs and tolerates missing inputs', () => {
    assert.deepEqual(mergeGeneratedTranscripts([{ mimirItemId: 'a' }], [done('a', '')]), [{ mimirItemId: 'a' }]);
    assert.deepEqual(mergeGeneratedTranscripts([{ mimirItemId: 'a' }], undefined), [{ mimirItemId: 'a' }]);
    assert.deepEqual(mergeGeneratedTranscripts(undefined, [done('a', 's3://x/a')]), []);
  });

  it('handles a 300-asset story', () => {
    const assets = Array.from({ length: 300 }, (_, i) => ({ mimirItemId: `m${i}`, timedTranscriptUrl: 'x'.repeat(1500) }));
    const results = assets.map((a) => done(a.mimirItemId, `s3://x/${a.mimirItemId}`));
    const out = mergeGeneratedTranscripts(assets, results);
    assert.equal(out.length, 300);
    assert.equal(out[299].generatedTranscriptS3Uri, 's3://x/m299');
  });
});
