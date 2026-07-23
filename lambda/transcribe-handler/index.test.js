const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const { S3Client, ListObjectsV2Command, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const { TranscribeClient, GetTranscriptionJobCommand } = require('@aws-sdk/client-transcribe');

// We mock the S3Client.send and TranscribeClient.send methods
let originalS3Send;
let originalTranscribeSend;
let mockSendFn;
let mockTranscribeSendFn;

beforeEach(() => {
  process.env.VIDEO_STAGING_BUCKET = 'test-staging-bucket';
  originalS3Send = S3Client.prototype.send;
  originalTranscribeSend = TranscribeClient.prototype.send;
  S3Client.prototype.send = async function (command) {
    return mockSendFn(command);
  };
  TranscribeClient.prototype.send = async function (command) {
    return mockTranscribeSendFn(command);
  };
});

afterEach(() => {
  S3Client.prototype.send = originalS3Send;
  TranscribeClient.prototype.send = originalTranscribeSend;
  delete process.env.VIDEO_STAGING_BUCKET;
});

describe('check-video action', () => {
  it('returns exists: true with s3Uri when video is found', async () => {
    mockSendFn = (command) => {
      assert.ok(command instanceof ListObjectsV2Command);
      assert.strictEqual(command.input.Bucket, 'test-staging-bucket');
      assert.strictEqual(command.input.Prefix, 'videos/item-123/');
      assert.strictEqual(command.input.MaxKeys, 1);
      return {
        Contents: [{ Key: 'videos/item-123/1719500000000.mp4' }],
      };
    };

    // Re-require to pick up the mocked send
    delete require.cache[require.resolve('./index')];
    const { handler } = require('./index');

    const result = await handler({ action: 'check-video', itemId: 'item-123' });
    assert.deepStrictEqual(result, {
      exists: true,
      s3Uri: 's3://test-staging-bucket/videos/item-123/1719500000000.mp4',
    });
  });

  it('returns exists: false when no video is found', async () => {
    mockSendFn = (command) => {
      assert.ok(command instanceof ListObjectsV2Command);
      return { Contents: [] };
    };

    delete require.cache[require.resolve('./index')];
    const { handler } = require('./index');

    const result = await handler({ action: 'check-video', itemId: 'item-456' });
    assert.deepStrictEqual(result, { exists: false });
  });

  it('returns exists: false when Contents is undefined', async () => {
    mockSendFn = () => ({});

    delete require.cache[require.resolve('./index')];
    const { handler } = require('./index');

    const result = await handler({ action: 'check-video', itemId: 'item-789' });
    assert.deepStrictEqual(result, { exists: false });
  });

  it('throws when itemId is missing', async () => {
    delete require.cache[require.resolve('./index')];
    const { handler } = require('./index');

    await assert.rejects(
      () => handler({ action: 'check-video' }),
      { message: 'itemId is required' }
    );
  });

  it('throws when VIDEO_STAGING_BUCKET is not set', async () => {
    delete process.env.VIDEO_STAGING_BUCKET;

    delete require.cache[require.resolve('./index')];
    const { handler } = require('./index');

    await assert.rejects(
      () => handler({ action: 'check-video', itemId: 'item-123' }),
      { message: 'VIDEO_STAGING_BUCKET environment variable is not set' }
    );
  });

  it('throws on unknown action', async () => {
    delete require.cache[require.resolve('./index')];
    const { handler } = require('./index');

    await assert.rejects(
      () => handler({ action: 'unknown-action' }),
      { message: 'Unknown action: unknown-action' }
    );
  });
});

describe('convertTranscribeOutput', () => {
  it('converts a simple two-sentence transcript', () => {
    delete require.cache[require.resolve('./index')];
    const { convertTranscribeOutput } = require('./index');

    const rawOutput = {
      results: {
        transcripts: [{ transcript: 'Hello world. Goodbye world.' }],
        items: [
          { type: 'pronunciation', alternatives: [{ content: 'Hello' }], start_time: '0.0', end_time: '0.5' },
          { type: 'pronunciation', alternatives: [{ content: 'world' }], start_time: '0.6', end_time: '1.0' },
          { type: 'punctuation', alternatives: [{ content: '.' }] },
          { type: 'pronunciation', alternatives: [{ content: 'Goodbye' }], start_time: '1.5', end_time: '2.0' },
          { type: 'pronunciation', alternatives: [{ content: 'world' }], start_time: '2.1', end_time: '2.5' },
          { type: 'punctuation', alternatives: [{ content: '.' }] },
        ],
      },
    };

    const result = convertTranscribeOutput(rawOutput);

    assert.strictEqual(result.fullTranscript, 'Hello world. Goodbye world.');
    assert.strictEqual(result.sentences.length, 2);

    assert.strictEqual(result.sentences[0].text, 'Hello world.');
    assert.strictEqual(result.sentences[0].startTime, 0.0);
    assert.strictEqual(result.sentences[0].endTime, 1.0);
    assert.strictEqual(result.sentences[0].words.length, 2);
    assert.strictEqual(result.sentences[0].words[1].word, 'world.');

    assert.strictEqual(result.sentences[1].text, 'Goodbye world.');
    assert.strictEqual(result.sentences[1].startTime, 1.5);
    assert.strictEqual(result.sentences[1].endTime, 2.5);
  });

  it('handles non-sentence-ending punctuation without breaking sentence', () => {
    delete require.cache[require.resolve('./index')];
    const { convertTranscribeOutput } = require('./index');

    const rawOutput = {
      results: {
        transcripts: [{ transcript: 'Well, hello there.' }],
        items: [
          { type: 'pronunciation', alternatives: [{ content: 'Well' }], start_time: '0.0', end_time: '0.3' },
          { type: 'punctuation', alternatives: [{ content: ',' }] },
          { type: 'pronunciation', alternatives: [{ content: 'hello' }], start_time: '0.5', end_time: '0.8' },
          { type: 'pronunciation', alternatives: [{ content: 'there' }], start_time: '0.9', end_time: '1.2' },
          { type: 'punctuation', alternatives: [{ content: '.' }] },
        ],
      },
    };

    const result = convertTranscribeOutput(rawOutput);

    assert.strictEqual(result.sentences.length, 1);
    assert.strictEqual(result.sentences[0].text, 'Well, hello there.');
    assert.strictEqual(result.sentences[0].words[0].word, 'Well,');
    assert.strictEqual(result.sentences[0].words.length, 3);
  });

  it('finalizes remaining words when no sentence-ending punctuation at end', () => {
    delete require.cache[require.resolve('./index')];
    const { convertTranscribeOutput } = require('./index');

    const rawOutput = {
      results: {
        transcripts: [{ transcript: 'Hello world' }],
        items: [
          { type: 'pronunciation', alternatives: [{ content: 'Hello' }], start_time: '0.0', end_time: '0.5' },
          { type: 'pronunciation', alternatives: [{ content: 'world' }], start_time: '0.6', end_time: '1.0' },
        ],
      },
    };

    const result = convertTranscribeOutput(rawOutput);

    assert.strictEqual(result.sentences.length, 1);
    assert.strictEqual(result.sentences[0].text, 'Hello world');
    assert.strictEqual(result.sentences[0].startTime, 0.0);
    assert.strictEqual(result.sentences[0].endTime, 1.0);
  });

  it('handles question marks and exclamation marks as sentence enders', () => {
    delete require.cache[require.resolve('./index')];
    const { convertTranscribeOutput } = require('./index');

    const rawOutput = {
      results: {
        transcripts: [{ transcript: 'Really? Yes!' }],
        items: [
          { type: 'pronunciation', alternatives: [{ content: 'Really' }], start_time: '0.0', end_time: '0.5' },
          { type: 'punctuation', alternatives: [{ content: '?' }] },
          { type: 'pronunciation', alternatives: [{ content: 'Yes' }], start_time: '1.0', end_time: '1.3' },
          { type: 'punctuation', alternatives: [{ content: '!' }] },
        ],
      },
    };

    const result = convertTranscribeOutput(rawOutput);

    assert.strictEqual(result.sentences.length, 2);
    assert.strictEqual(result.sentences[0].text, 'Really?');
    assert.strictEqual(result.sentences[1].text, 'Yes!');
  });

  it('handles empty items array', () => {
    delete require.cache[require.resolve('./index')];
    const { convertTranscribeOutput } = require('./index');

    const rawOutput = {
      results: {
        transcripts: [{ transcript: '' }],
        items: [],
      },
    };

    const result = convertTranscribeOutput(rawOutput);

    assert.strictEqual(result.fullTranscript, '');
    assert.strictEqual(result.sentences.length, 0);
  });
});

describe('poll-transcribe action', () => {
  it('returns IN_PROGRESS when job is still running', async () => {
    mockTranscribeSendFn = (command) => {
      assert.ok(command instanceof GetTranscriptionJobCommand);
      assert.strictEqual(command.input.TranscriptionJobName, 'transcript-item-123-1719500000000');
      return {
        TranscriptionJob: {
          TranscriptionJobStatus: 'IN_PROGRESS',
        },
      };
    };

    delete require.cache[require.resolve('./index')];
    const { handler } = require('./index');

    const result = await handler({
      action: 'poll-transcribe',
      itemId: 'item-123',
      jobName: 'transcript-item-123-1719500000000',
    });

    assert.deepStrictEqual(result, { status: 'IN_PROGRESS' });
  });

  it('returns FAILED with error reason when job fails', async () => {
    mockTranscribeSendFn = (command) => ({
      TranscriptionJob: {
        TranscriptionJobStatus: 'FAILED',
        FailureReason: 'Audio quality too low',
      },
    });

    delete require.cache[require.resolve('./index')];
    const { handler } = require('./index');

    const result = await handler({
      action: 'poll-transcribe',
      itemId: 'item-123',
      jobName: 'transcript-item-123-1719500000000',
    });

    assert.deepStrictEqual(result, {
      status: 'FAILED',
      error: 'Transcription job failed: Audio quality too low',
    });
  });

  it('returns FAILED with default reason when FailureReason is missing', async () => {
    mockTranscribeSendFn = () => ({
      TranscriptionJob: {
        TranscriptionJobStatus: 'FAILED',
      },
    });

    delete require.cache[require.resolve('./index')];
    const { handler } = require('./index');

    const result = await handler({
      action: 'poll-transcribe',
      itemId: 'item-123',
      jobName: 'transcript-item-123-1719500000000',
    });

    assert.deepStrictEqual(result, {
      status: 'FAILED',
      error: 'Transcription job failed: Unknown reason',
    });
  });

  it('reads raw output, converts, writes transcript, and returns COMPLETED on success', async () => {
    const rawTranscribeOutput = {
      results: {
        transcripts: [{ transcript: 'Hello world.' }],
        items: [
          { type: 'pronunciation', alternatives: [{ content: 'Hello' }], start_time: '0.0', end_time: '0.5' },
          { type: 'pronunciation', alternatives: [{ content: 'world' }], start_time: '0.6', end_time: '1.0' },
          { type: 'punctuation', alternatives: [{ content: '.' }] },
        ],
      },
    };

    mockTranscribeSendFn = () => ({
      TranscriptionJob: {
        TranscriptionJobStatus: 'COMPLETED',
      },
    });

    let putObjectCalled = false;
    mockSendFn = (command) => {
      if (command instanceof GetObjectCommand) {
        assert.strictEqual(command.input.Bucket, 'test-staging-bucket');
        assert.strictEqual(command.input.Key, 'transcripts/item-123/raw-output.json');
        return {
          Body: {
            transformToString: async () => JSON.stringify(rawTranscribeOutput),
          },
        };
      }
      if (command instanceof PutObjectCommand) {
        putObjectCalled = true;
        assert.strictEqual(command.input.Bucket, 'test-staging-bucket');
        assert.strictEqual(command.input.Key, 'transcripts/item-123/transcript.json');
        assert.strictEqual(command.input.ContentType, 'application/json');
        const body = JSON.parse(command.input.Body);
        assert.strictEqual(body.fullTranscript, 'Hello world.');
        assert.strictEqual(body.sentences.length, 1);
        assert.strictEqual(body.sentences[0].text, 'Hello world.');
        return {};
      }
      throw new Error(`Unexpected command: ${command.constructor.name}`);
    };

    delete require.cache[require.resolve('./index')];
    const { handler } = require('./index');

    const result = await handler({
      action: 'poll-transcribe',
      itemId: 'item-123',
      jobName: 'transcript-item-123-1719500000000',
    });

    assert.deepStrictEqual(result, {
      status: 'COMPLETED',
      transcriptS3Uri: 's3://test-staging-bucket/transcripts/item-123/transcript.json',
    });
    assert.ok(putObjectCalled, 'PutObjectCommand should have been called');
  });

  it('throws when itemId is missing', async () => {
    delete require.cache[require.resolve('./index')];
    const { handler } = require('./index');

    await assert.rejects(
      () => handler({ action: 'poll-transcribe', jobName: 'some-job' }),
      { message: 'itemId is required' }
    );
  });

  it('throws when jobName is missing', async () => {
    delete require.cache[require.resolve('./index')];
    const { handler } = require('./index');

    await assert.rejects(
      () => handler({ action: 'poll-transcribe', itemId: 'item-123' }),
      { message: 'jobName is required' }
    );
  });

  it('throws when VIDEO_STAGING_BUCKET is not set', async () => {
    delete process.env.VIDEO_STAGING_BUCKET;

    delete require.cache[require.resolve('./index')];
    const { handler } = require('./index');

    await assert.rejects(
      () => handler({ action: 'poll-transcribe', itemId: 'item-123', jobName: 'some-job' }),
      { message: 'VIDEO_STAGING_BUCKET environment variable is not set' }
    );
  });
});
