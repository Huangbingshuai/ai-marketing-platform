import { createHash } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const fingerprint = async (stream) => {
  const hash = createHash('sha256');
  const md5 = createHash('md5');
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    hash.update(chunk);
    md5.update(chunk);
  }
  return { sha256: hash.digest('hex'), md5: md5.digest('hex'), size };
};

const missing = (error) => ['NotFound', 'NoSuchKey', 'NoSuchObject'].includes(error?.code);

export const objectStat = async (client, bucket, key) => {
  try {
    return await client.statObject(bucket, key);
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
};

const check = (condition, code) => {
  if (!condition) throw Object.assign(new Error(code), { code });
};

/** Copy only, never rename or delete either side. A conflicting target is never overwritten. */
export const copyObject = async ({
  source,
  target,
  sourceBucket,
  targetBucket,
  key,
  checkpoint,
  verifySimpleTosEtag = false,
}) => {
  const before = await source.statObject(sourceBucket, key);
  const existing = await objectStat(target, targetBucket, key);
  if (
    existing &&
    checkpoint?.sourceEtag === before.etag &&
    checkpoint?.targetEtag === existing.etag &&
    checkpoint?.size === before.size &&
    existing.size === before.size
  ) {
    return { ...checkpoint, resumed: true };
  }

  let sourceHash;
  if (existing) {
    check(existing.size === before.size, 'TARGET_CONFLICT');
    sourceHash = await fingerprint(await source.getObject(sourceBucket, key));
  } else {
    const hash = createHash('sha256');
    const md5 = createHash('md5');
    let size = 0;
    const meter = new Transform({
      transform(chunk, _encoding, callback) {
        hash.update(chunk);
        md5.update(chunk);
        size += chunk.length;
        callback(null, chunk);
      },
    });
    const input = await source.getObject(sourceBucket, key);
    try {
      await Promise.all([
        pipeline(input, meter),
        target.putObject(targetBucket, key, meter, before.size, before.metaData),
      ]);
    } catch (error) {
      input.destroy();
      meter.destroy();
      throw error;
    }
    sourceHash = { size, sha256: hash.digest('hex'), md5: md5.digest('hex') };
  }

  const stored = await target.statObject(targetBucket, key);
  // TOS documents MD5 ETags for simple uploads. This opt-in is ONLY for TOS:
  // multipart/nonmatching ETags still require a full remote SHA-256 read.
  const simpleTosMatch =
    verifySimpleTosEtag &&
    /^[a-f0-9]{32}$/i.test(stored.etag) &&
    stored.etag.toLowerCase() === sourceHash.md5 &&
    stored.size === before.size;
  const targetHash = simpleTosMatch
    ? sourceHash
    : await fingerprint(await target.getObject(targetBucket, key));
  const after = await source.statObject(sourceBucket, key);
  check(before.etag === after.etag && before.size === after.size, 'SOURCE_CHANGED');
  check(sourceHash.size === before.size && targetHash.size === before.size, 'SIZE_MISMATCH');
  check(sourceHash.sha256 === targetHash.sha256, existing ? 'TARGET_CONFLICT' : 'HASH_MISMATCH');
  // Do not assume ETags are content hashes: multipart layouts may differ between services.
  return {
    key,
    sourceEtag: after.etag,
    targetEtag: stored.etag,
    size: before.size,
    sha256: sourceHash.sha256,
    verification: simpleTosMatch ? 'tos-single-part-md5' : 'remote-sha256',
    resumed: false,
  };
};
