import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { Agent } from 'node:https';
import { loadEnvFile } from 'node:process';
import { Client } from 'minio';
import { Client as PgClient } from 'pg';

import { copyObject } from './minio-to-tos.mjs';

loadEnvFile(resolve(import.meta.dirname, '../../../.env'));
const required = (name) => {
  const value = process.env[name]?.trim();
  if (!value) throw Object.assign(new Error(`Missing ${name}`), { code: `MISSING_${name}` });
  return value;
};
const apply = process.argv.includes('--apply');
const concurrency = Number(
  process.argv.find((arg) => arg.startsWith('--concurrency='))?.split('=')[1] ?? 4,
);
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16)
  throw new Error('Invalid concurrency');
const sourceBucket = required('MINIO_BUCKET');
const targetBucket = required('TOS_BUCKET');
const region = required('TOS_REGION');
const endpoint = new URL(
  required('TOS_ENDPOINT').includes('://')
    ? required('TOS_ENDPOINT')
    : `https://${required('TOS_ENDPOINT')}`,
);
if (
  endpoint.protocol !== 'https:' ||
  endpoint.pathname !== '/' ||
  endpoint.search ||
  endpoint.hash ||
  endpoint.username ||
  endpoint.password ||
  endpoint.port ||
  ![`tos-${region}.volces.com`, `tos-s3-${region}.volces.com`].includes(endpoint.hostname)
)
  throw new Error('Invalid TOS endpoint');
const source = new Client({
  endPoint: required('MINIO_ENDPOINT'),
  port: Number(required('MINIO_PORT')),
  useSSL: required('MINIO_USE_SSL') === 'true',
  accessKey: required('MINIO_ACCESS_KEY'),
  secretKey: required('MINIO_SECRET_KEY'),
});
const target = new Client({
  endPoint: `tos-s3-${region}.volces.com`,
  region,
  port: 443,
  useSSL: true,
  pathStyle: false,
  accessKey: required('TOS_ACCESS_KEY_ID'),
  secretKey: required('TOS_SECRET_ACCESS_KEY'),
  // Keep connections across copy/verification phases; this network rejects some TLS 1.3 handshakes.
  transportAgent: new Agent({
    keepAlive: true,
    timeout: 120000,
    maxSockets: 32,
    maxFreeSockets: 32,
    maxVersion: 'TLSv1.2',
  }),
});
const stateDir = resolve(import.meta.dirname, '../../../.local-storage/migrations');
const stateId = createHash('sha256')
  .update(`${required('MINIO_ENDPOINT')}:${sourceBucket}:${endpoint.hostname}:${targetBucket}`)
  .digest('hex')
  .slice(0, 24);
const journalPath = resolve(stateDir, `minio-tos-${stateId}.jsonl`);
const checkpoints = new Map();

const main = async () => {
  if (!(await target.bucketExists(targetBucket)))
    throw Object.assign(new Error('Target missing'), { code: 'TARGET_BUCKET_UNAVAILABLE' });
  const objects = [];
  for await (const object of source.listObjectsV2(sourceBucket, '', true)) {
    if (object.name) objects.push(object);
  }
  console.log(
    JSON.stringify({
      phase: 'inventory',
      apply,
      objects: objects.length,
      bytes: objects.reduce((sum, obj) => sum + obj.size, 0),
    }),
  );
  if (!apply) return;
  await mkdir(stateDir, { recursive: true });
  try {
    for (const line of (await readFile(journalPath, 'utf8')).split('\n')) {
      try {
        const record = JSON.parse(line);
        if (record.key) checkpoints.set(record.key, record);
      } catch {
        /* Interrupted final journal line is not a checkpoint. */
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  let cursor = 0,
    completed = 0,
    bytes = 0,
    resumed = 0,
    failed = 0;
  let journalWrite = Promise.resolve();
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (cursor < objects.length) {
        const object = objects[cursor++];
        try {
          let record;
          for (let attempt = 0; attempt < 3; attempt++) {
            try {
              record = await copyObject({
                source,
                target,
                sourceBucket,
                targetBucket,
                key: object.name,
                checkpoint: checkpoints.get(object.name),
                verifySimpleTosEtag: true,
              });
              break;
            } catch (error) {
              const transient = [
                'ECONNRESET',
                'ETIMEDOUT',
                'EPIPE',
                'EAI_AGAIN',
                'ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION',
                'SlowDown',
                'InternalError',
                'ServiceUnavailable',
              ].includes(error.code);
              if (!transient || attempt === 2) throw error;
              await new Promise((resolveRetry) => setTimeout(resolveRetry, 500 * 2 ** attempt));
            }
          }
          if (!record) throw new Error('Copy did not return a checkpoint');
          checkpoints.set(record.key, record);
          if (record.resumed) resumed++;
          else {
            journalWrite = journalWrite.then(() =>
              appendFile(journalPath, `${JSON.stringify(record)}\n`),
            );
            await journalWrite;
          }
          completed++;
          bytes += record.size;
          if (completed % 50 === 0 || completed === objects.length)
            console.log(
              JSON.stringify({
                phase: 'copy_verify',
                completed,
                total: objects.length,
                bytes,
                resumed,
                failed,
              }),
            );
        } catch (error) {
          failed++;
          console.log(
            JSON.stringify({
              phase: 'object_failed',
              keyHash: createHash('sha256').update(object.name).digest('hex').slice(0, 16),
              code: /^[A-Za-z0-9_]+$/.test(error.code ?? '') ? error.code : 'COPY_FAILED',
            }),
          );
        }
      }
    }),
  );
  await journalWrite;
  if (failed) throw Object.assign(new Error('Copy errors'), { code: 'COPY_INCOMPLETE' });
  // Fresh inventory prevents publishing success after an upload/delete during the copy.
  let currentCount = 0;
  for await (const object of source.listObjectsV2(sourceBucket, '', true)) {
    if (!object.name) continue;
    currentCount++;
    const saved = checkpoints.get(object.name);
    if (!saved || saved.sourceEtag !== object.etag || saved.size !== object.size)
      throw Object.assign(new Error('Inventory changed'), { code: 'SOURCE_INVENTORY_CHANGED' });
  }
  if (currentCount !== objects.length)
    throw Object.assign(new Error('Inventory changed'), { code: 'SOURCE_INVENTORY_CHANGED' });
  const database = new PgClient({ connectionString: required('DATABASE_URL') });
  await database.connect();
  try {
    const rows = await database.query(
      'SELECT "storageKey", "sizeBytes", sha256 FROM file_objects WHERE status = \'AVAILABLE\'',
    );
    for (const row of rows.rows) {
      const record = checkpoints.get(row.storageKey);
      if (!record || record.size !== row.sizeBytes || record.sha256 !== row.sha256)
        throw Object.assign(new Error('Database reference not verified'), {
          code: 'DATABASE_REFERENCE_UNVERIFIED',
        });
    }
    // Formal assets and shared samples may predate FileObject backfill.
    const references = await database.query(`
      SELECT "storageKey", "sizeBytes", NULL::text AS sha256 FROM assets WHERE "storageKey" IS NOT NULL
      UNION ALL SELECT "storageKey", "sizeBytes", NULL::text FROM asset_versions WHERE "storageKey" IS NOT NULL
      UNION ALL SELECT "storageKey", "sizeBytes", sha256 FROM effect_voice_catalog_samples WHERE "storageKey" IS NOT NULL
      UNION ALL SELECT "storageKey", "sizeBytes", NULL::text FROM working_artifacts WHERE "storageKey" IS NOT NULL AND availability = 'AVAILABLE'
      UNION ALL SELECT "storageKey", "sizeBytes", NULL::text FROM effect_extraction_artifacts WHERE "storageKey" IS NOT NULL
      UNION ALL SELECT "storageKey", "sizeBytes", NULL::text FROM effect_manifest_staged_files WHERE "storageKey" IS NOT NULL
    `);
    for (const row of references.rows) {
      const record = checkpoints.get(row.storageKey);
      if (
        !record ||
        (row.sizeBytes !== null && record.size !== row.sizeBytes) ||
        (row.sha256 && record.sha256 !== row.sha256)
      )
        throw Object.assign(new Error('Asset reference not verified'), {
          code: 'ASSET_REFERENCE_UNVERIFIED',
        });
    }
    console.log(
      JSON.stringify({
        phase: 'complete',
        completed,
        bytes,
        resumed,
        verifiedDatabaseFiles: rows.rowCount,
        verifiedAssetReferences: references.rowCount,
        sourceDeleted: false,
        databaseChanged: false,
        storageSwitched: false,
      }),
    );
  } finally {
    await database.end();
  }
};
main().catch((error) => {
  // Never print SDK errors/messages/stacks, credentials, object names or signed URLs.
  console.error(
    JSON.stringify({
      phase: 'failed',
      code: /^[A-Za-z0-9_]+$/.test(error.code ?? '') ? error.code : 'MIGRATION_FAILED',
    }),
  );
  process.exitCode = 1;
});
