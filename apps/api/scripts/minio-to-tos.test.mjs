import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { copyObject } from './minio-to-tos.mjs';

const fixture = (destination) => {
  let targetBytes = destination;
  let puts = 0,
    sourceReads = 0;
  const content = Buffer.from('audio-video');
  const source = {
    statObject: async () => ({
      size: content.length,
      etag: 'src',
      metaData: { 'content-type': 'video/mp4' },
    }),
    getObject: async () => {
      sourceReads++;
      return Readable.from([content]);
    },
  };
  const target = {
    statObject: async () => {
      if (!targetBytes) throw Object.assign(new Error('missing'), { code: 'NotFound' });
      return { size: targetBytes.length, etag: 'dst' };
    },
    getObject: async () => Readable.from([targetBytes]),
    putObject: async (_bucket, _key, stream, size, metadata) => {
      assert.equal(size, content.length);
      assert.equal(metadata['content-type'], 'video/mp4');
      const chunks = [];
      for await (const chunk of stream) chunks.push(chunk);
      targetBytes = Buffer.concat(chunks);
      puts++;
    },
  };
  return {
    source,
    target,
    sourceBucket: 'source',
    targetBucket: 'target',
    key: '中文素材.mp4',
    counts: () => ({ puts, sourceReads }),
  };
};

test('stream copies, preserves MIME and verifies SHA-256 without deleting anything', async () => {
  const f = fixture();
  const record = await copyObject(f);
  assert.equal(record.sha256, createHash('sha256').update('audio-video').digest('hex'));
  assert.deepEqual(f.counts(), { puts: 1, sourceReads: 1 });
});
test('identical existing targets are verified without overwriting', async () => {
  const f = fixture(Buffer.from('audio-video'));
  await copyObject(f);
  assert.equal(f.counts().puts, 0);
});
test('same-size conflicting target is never overwritten', async () => {
  const f = fixture(Buffer.from('other-video'));
  await assert.rejects(copyObject(f), { code: 'TARGET_CONFLICT' });
  assert.equal(f.counts().puts, 0);
});
test('different-size conflicting target is never overwritten', async () => {
  const f = fixture(Buffer.from('other'));
  await assert.rejects(copyObject(f), { code: 'TARGET_CONFLICT' });
  assert.equal(f.counts().puts, 0);
});
test('matching source and target checkpoint resumes without downloading again', async () => {
  const f = fixture();
  const checkpoint = await copyObject(f);
  const counts = f.counts();
  assert.equal((await copyObject({ ...f, checkpoint })).resumed, true);
  assert.deepEqual(f.counts(), counts);
});
test('source version changes do not produce a verified checkpoint', async () => {
  const f = fixture();
  let reads = 0;
  f.source.statObject = async () => ({
    size: 11,
    etag: reads++ ? 'new' : 'src',
    metaData: { 'content-type': 'video/mp4' },
  });
  await assert.rejects(copyObject(f), { code: 'SOURCE_CHANGED' });
});
test('corrupted upload fails verification without deleting either source or target', async () => {
  const f = fixture();
  f.target.getObject = async () => Readable.from([Buffer.from('other-video')]);
  await assert.rejects(copyObject(f), { code: 'HASH_MISMATCH' });
});
test('permission errors are not treated as a missing target', async () => {
  const f = fixture();
  f.target.statObject = async () => {
    throw Object.assign(new Error('denied'), { code: 'AccessDenied' });
  };
  await assert.rejects(copyObject(f), { code: 'AccessDenied' });
  assert.equal(f.counts().puts, 0);
});

test('explicit TOS simple ETag validates local MD5 without downloading the target', async () => {
  const f = fixture(Buffer.from('audio-video'));
  f.target.statObject = async () => ({
    size: 11,
    etag: createHash('md5').update('audio-video').digest('hex'),
  });
  f.target.getObject = async () => {
    throw new Error('Should not download');
  };
  const record = await copyObject({ ...f, verifySimpleTosEtag: true });
  assert.equal(record.verification, 'tos-single-part-md5');
  assert.equal(record.sha256, createHash('sha256').update('audio-video').digest('hex'));
  assert.equal(f.counts().puts, 0);
});

test('multipart TOS ETags still require remote SHA-256 verification', async () => {
  const f = fixture(Buffer.from('audio-video'));
  f.target.statObject = async () => ({
    size: 11,
    etag: `${createHash('md5').update('audio-video').digest('hex')}-2`,
  });
  const record = await copyObject({ ...f, verifySimpleTosEtag: true });
  assert.equal(record.verification, 'remote-sha256');
});

test('a nonmatching simple TOS ETag cannot hide a same-size conflict', async () => {
  const f = fixture(Buffer.from('other-video'));
  f.target.statObject = async () => ({
    size: 11,
    etag: createHash('md5').update('other-video').digest('hex'),
  });
  await assert.rejects(copyObject({ ...f, verifySimpleTosEtag: true }), {
    code: 'TARGET_CONFLICT',
  });
  assert.equal(f.counts().puts, 0);
});

test('generic storage never assumes simple ETags are MD5 without the TOS opt-in', async () => {
  const f = fixture(Buffer.from('other-video'));
  f.target.statObject = async () => ({
    size: 11,
    etag: createHash('md5').update('audio-video').digest('hex'),
  });
  await assert.rejects(copyObject(f), { code: 'TARGET_CONFLICT' });
});
