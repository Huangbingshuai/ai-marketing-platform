import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { TosClient } from '@volcengine/tos-sdk';
import pg from 'pg';

const args = new Set(process.argv.slice(2));
const apply = args.has('--apply');
const reportArgument = process.argv.slice(2).find((value) => value.startsWith('--report='));
const reportPath = resolve(
  process.cwd(),
  reportArgument?.slice('--report='.length) ??
    '../../docs/project-assets/reports/working-file-backfill-report.json',
);

const loadEnvFile = async (path) => {
  if (!existsSync(path)) return;
  const lines = (await readFile(path, 'utf8')).split(/\r?\n/);
  for (const line of lines) {
    const match = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!match || process.env[match[1]] !== undefined) continue;
    const value = match[2].replace(/^(['"])(.*)\1$/, '$2');
    process.env[match[1]] = value;
  }
};

await loadEnvFile(resolve(process.cwd(), '../../.env'));
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');

const storageDriver = process.env.STORAGE_DRIVER ?? 'local';
const tosRegion = process.env.TOS_REGION;
const tosBucket = process.env.TOS_BUCKET;
const tosEndpoint = process.env.TOS_ENDPOINT;
if (storageDriver === 'tos') {
  if (
    !tosRegion ||
    !tosBucket ||
    !tosEndpoint ||
    !process.env.TOS_ACCESS_KEY_ID ||
    !process.env.TOS_SECRET_ACCESS_KEY
  ) {
    throw new Error('TOS region, endpoint, bucket, and credentials are required');
  }
  const endpointUrl = new URL(tosEndpoint.includes('://') ? tosEndpoint : `https://${tosEndpoint}`);
  if (
    endpointUrl.protocol !== 'https:' ||
    ![`tos-${tosRegion}.volces.com`, `tos-s3-${tosRegion}.volces.com`].includes(
      endpointUrl.hostname,
    )
  ) {
    throw new Error('TOS_ENDPOINT must be an HTTPS regional endpoint matching TOS_REGION');
  }
}
const storageClient =
  storageDriver === 'tos'
    ? new TosClient({
        endpoint: `tos-${tosRegion}.volces.com`,
        region: tosRegion,
        secure: true,
        enableVerifySSL: true,
        accessKeyId: process.env.TOS_ACCESS_KEY_ID?.trim() ?? '',
        accessKeySecret: process.env.TOS_SECRET_ACCESS_KEY?.trim() ?? '',
        maxConnections: 8,
      })
    : null;
if (storageClient) storageClient.axiosInst.defaults.proxy = false;
if (storageDriver !== 'local' && storageDriver !== 'tos') {
  throw new Error('STORAGE_DRIVER must be local or tos');
}
const bucket = tosBucket;
const localRoot = resolve(process.cwd(), process.env.LOCAL_STORAGE_ROOT ?? '../../.local-storage');

const sha256Stream = (stream) =>
  new Promise((resolveHash, reject) => {
    const hash = createHash('sha256');
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolveHash(hash.digest('hex')));
  });

const database = new pg.Client({ connectionString: databaseUrl });
await database.connect();
const startedAt = new Date().toISOString();
const report = {
  startedAt,
  mode: apply ? 'apply' : 'dry-run',
  total: 0,
  readable: 0,
  updated: 0,
  failures: [],
};
try {
  const result = await database.query(
    'SELECT "id", "projectId", "storageKey", "sha256" FROM "file_objects" ORDER BY "createdAt", "id"',
  );
  report.total = result.rows.length;
  for (const row of result.rows) {
    try {
      const stream = storageClient
        ? (await storageClient.getObjectV2({ bucket, key: row.storageKey, dataType: 'stream' }))
            .data.content
        : createReadStream(resolve(localRoot, ...String(row.storageKey).split('/')));
      const checksum = await sha256Stream(stream);
      report.readable += 1;
      if (apply && checksum !== row.sha256) {
        await database.query(
          'UPDATE "file_objects" SET "sha256" = $1, "updatedAt" = CURRENT_TIMESTAMP WHERE "projectId" = $2::uuid AND "id" = $3::uuid',
          [checksum, row.projectId, row.id],
        );
        report.updated += 1;
      }
    } catch (error) {
      report.failures.push({
        fileObjectId: row.id,
        projectId: row.projectId,
        storageKey: row.storageKey,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
} finally {
  await database.end();
}
report.completedAt = new Date().toISOString();
await mkdir(dirname(reportPath), { recursive: true });
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
process.stdout.write(
  JSON.stringify({
    reportPath,
    mode: report.mode,
    total: report.total,
    readable: report.readable,
    updated: report.updated,
    failures: report.failures.length,
  }),
);
if (report.failures.length) process.exitCode = 2;
