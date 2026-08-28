import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { Client as MinioClient } from 'minio';
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
const minio =
  storageDriver === 'minio'
    ? new MinioClient({
        endPoint: process.env.MINIO_ENDPOINT ?? 'localhost',
        port: Number(process.env.MINIO_PORT ?? 9000),
        useSSL: String(process.env.MINIO_USE_SSL ?? 'false').toLowerCase() === 'true',
        accessKey: process.env.MINIO_ACCESS_KEY ?? '',
        secretKey: process.env.MINIO_SECRET_KEY ?? '',
      })
    : null;
const bucket = process.env.MINIO_BUCKET ?? 'ai-marketing-assets';
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
      const stream = minio
        ? await minio.getObject(bucket, row.storageKey)
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
