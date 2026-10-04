import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadEnvFile } from 'node:process';
import { createHash } from 'node:crypto';
import { Agent } from 'node:https';
import { Client, CopyConditions } from 'minio';
import { Client as PgClient } from 'pg';
import { classifyStorageKey, collectStorageOwners } from './project-storage-scope.mjs';
import { fingerprint, objectStat } from './minio-to-tos.mjs';

loadEnvFile(resolve(import.meta.dirname, '../../../.env'));
const keepProjectId = '40d1273a-e1cd-4cae-8f83-02fdaf324dc1';
const backupRoot = resolve(
  import.meta.dirname,
  '../../../.local-storage/backups/project-cleanup-20261004',
);
const manifestPath = resolve(backupRoot, 'cleanup-manifest.json');
const e = process.env;
const sourceBucket = e.MINIO_BUCKET;
const quarantineBucket = 'ai-marketing-project-trash-20261004';
const source = new Client({
  endPoint: e.MINIO_ENDPOINT,
  port: Number(e.MINIO_PORT),
  useSSL: e.MINIO_USE_SSL === 'true',
  accessKey: e.MINIO_ACCESS_KEY,
  secretKey: e.MINIO_SECRET_KEY,
});
const target = new Client({
  endPoint: `tos-s3-${e.TOS_REGION}.volces.com`,
  region: e.TOS_REGION,
  port: 443,
  useSSL: true,
  pathStyle: false,
  accessKey: e.TOS_ACCESS_KEY_ID,
  secretKey: e.TOS_SECRET_ACCESS_KEY,
  transportAgent: new Agent({
    keepAlive: true,
    timeout: 120000,
    maxVersion: 'TLSv1.2',
    maxSockets: 32,
  }),
});
const database = new PgClient({ connectionString: e.DATABASE_URL });
const apply = process.argv.includes('--apply');
const erase = process.argv.includes('--erase-files');
const deleteDatabase = process.argv.includes('--delete-database');

const parallel = async (rows, operation, concurrency = 12) => {
  let cursor = 0,
    completed = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (cursor < rows.length) {
        await operation(rows[cursor++]);
        completed++;
        if (completed % 250 === 0 || completed === rows.length)
          console.log(JSON.stringify({ completed, total: rows.length }));
      }
    }),
  );
};
const projectFingerprint = async () => {
  const tables = await database.query(
    `SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='projectId' ORDER BY table_name`,
  );
  const hash = createHash('sha256');
  const counts = {};
  const project = await database.query(
    'SELECT to_jsonb(p)::text payload FROM projects p WHERE id=$1',
    [keepProjectId],
  );
  hash.update(project.rows[0].payload);
  for (const { table_name: table } of tables.rows) {
    if (!/^[a-z_]+$/.test(table)) throw new Error('Invalid table');
    const rows = await database.query(
      `SELECT to_jsonb(t)::text payload FROM "${table}" t WHERE "projectId"=$1 ORDER BY to_jsonb(t)::text`,
      [keepProjectId],
    );
    counts[table] = rows.rowCount;
    hash.update(table);
    for (const row of rows.rows) hash.update(row.payload);
  }
  return { sha256: hash.digest('hex'), counts };
};

const main = async () => {
  await database.connect();
  if (erase || deleteDatabase) {
    if (!apply) throw new Error('Explicit --apply required');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    if (
      manifest.keepProjectId !== keepProjectId ||
      manifest.sourceBucket !== sourceBucket ||
      manifest.quarantineBucket !== quarantineBucket ||
      !manifest.backedUp
    )
      throw new Error('Verified backup manifest required');
    const keep = await database.query('SELECT name FROM projects WHERE id=$1', [keepProjectId]);
    if (keep.rows[0]?.name !== '紫苏梅子酱') throw new Error('Retained project identity changed');
    if (deleteDatabase) {
      const before = await projectFingerprint();
      await database.query('BEGIN');
      try {
        await database.query('LOCK TABLE projects IN SHARE ROW EXCLUSIVE MODE');
        const activeTables = [
          'effect_extraction_runs',
          'effect_final_output_runs',
          'effect_packaging_runs',
          'effect_prompt_runs',
          'effect_segment_render_tasks',
          'effect_template_mix_ai_runs',
        ];
        for (const table of activeTables) {
          const active = await database.query(
            `SELECT count(*)::int count FROM ${table} WHERE to_jsonb(${table})->>'status' IN ('QUEUED','RUNNING') OR to_jsonb(${table})->>'repairStatus' IN ('QUEUED','RUNNING')`,
          );
          if (active.rows[0].count) throw new Error('Active tasks prevent cleanup');
        }
        // Restrict references must be removed before their parent cascades; never disable FK checks.
        for (const table of [
          'working_artifact_dependencies',
          'working_artifact_files',
          'working_artifact_revision_files',
          'effect_final_output_items',
          'effect_packaging_files',
          'effect_voice_previews',
          'effect_import_materials',
          'effect_import_upload_items',
          'effect_import_products',
          'asset_operation_receipts',
          'asset_versions',
          'assets',
          'workflow_runs',
        ])
          await database.query(`DELETE FROM ${table} WHERE "projectId"=ANY($1::uuid[])`, [
            manifest.deleteProjectIds,
          ]);
        const removed = await database.query(
          'DELETE FROM projects WHERE id=ANY($1::uuid[]) AND id<>$2 RETURNING id',
          [manifest.deleteProjectIds, keepProjectId],
        );
        const after = await projectFingerprint();
        if (before.sha256 !== after.sha256) throw new Error('Retained project changed; rollback');
        await database.query('COMMIT');
        console.log(
          JSON.stringify({
            phase: 'database_deleted',
            deletedProjects: removed.rowCount,
            retainedProjectUnchanged: true,
          }),
        );
      } catch (error) {
        await database.query('ROLLBACK');
        throw error;
      }
    }
    if (erase) {
      const remaining = await database.query('SELECT id FROM projects');
      if (remaining.rows.length !== 1 || remaining.rows[0].id !== keepProjectId)
        throw new Error('Project deletion must finish first');
      const protectedOwners = await collectStorageOwners(database);
      const cloudKeys = new Set();
      for await (const object of target.listObjectsV2(e.TOS_BUCKET, '', true))
        if (object.name) cloudKeys.add(object.name);
      const migrationJournalId = createHash('sha256')
        .update(
          `${e.MINIO_ENDPOINT}:${sourceBucket}:${e.TOS_ENDPOINT.replace(/^https?:\/\//, '').replace(/\/$/, '')}:${e.TOS_BUCKET}`,
        )
        .digest('hex')
        .slice(0, 24);
      const verifiedCloud = new Map();
      try {
        for (const line of (
          await readFile(
            resolve(backupRoot, `../../migrations/minio-tos-${migrationJournalId}.jsonl`),
            'utf8',
          )
        ).split('\n')) {
          try {
            const row = JSON.parse(line);
            verifiedCloud.set(row.key, row);
          } catch {
            /* No completed checkpoint. */
          }
        }
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      console.log(
        JSON.stringify({
          phase: 'erase_verified_test_files',
          files: manifest.deleteObjects.length,
        }),
      );
      await parallel(
        manifest.deleteObjects,
        async (object) => {
          if (
            protectedOwners.get(object.key)?.has(keepProjectId) ||
            object.key.startsWith('shared/')
          )
            throw new Error('Protected key');
          const saved = await source.statObject(quarantineBucket, object.key);
          if (saved.size !== object.size || saved.etag !== object.backupEtag)
            throw new Error('Backup changed');
          const original = await objectStat(source, sourceBucket, object.key);
          if (original) {
            if (original.size !== object.size || original.etag !== object.sourceEtag)
              throw new Error('Source changed after backup');
            await source.removeObject(sourceBucket, object.key);
          }
          const cloud = cloudKeys.has(object.key)
            ? await objectStat(target, e.TOS_BUCKET, object.key)
            : null;
          if (cloud) {
            const checkpoint = verifiedCloud.get(object.key);
            if (
              checkpoint?.targetEtag !== cloud.etag ||
              checkpoint?.sha256 !== object.sha256 ||
              cloud.size !== object.size
            ) {
              const actual = await fingerprint(await target.getObject(e.TOS_BUCKET, object.key));
              if (actual.sha256 !== object.sha256 || actual.size !== object.size)
                throw new Error('Cloud object changed; not deleting');
            }
            await target.removeObject(e.TOS_BUCKET, object.key);
          }
        },
        16,
      );
      console.log(
        JSON.stringify({
          phase: 'test_files_removed',
          files: manifest.deleteObjects.length,
          recoverableFrom: quarantineBucket,
        }),
      );
    }
    return;
  }
  const projects = (await database.query('SELECT id,name FROM projects ORDER BY id')).rows;
  if (projects.find((p) => p.id === keepProjectId)?.name !== '紫苏梅子酱')
    throw new Error('Retained project identity changed');
  const owners = await collectStorageOwners(database);
  const deleteObjects = [],
    keepObjects = [],
    unknown = [];
  for await (const obj of source.listObjectsV2(sourceBucket, '', true)) {
    if (!obj.name) continue;
    const disposition = classifyStorageKey(obj.name, keepProjectId, projects, owners);
    if (disposition === 'DELETE')
      deleteObjects.push({ key: obj.name, size: obj.size, sourceEtag: obj.etag });
    else if (disposition === 'KEEP') keepObjects.push({ key: obj.name, size: obj.size });
    else unknown.push({ key: obj.name, size: obj.size });
  }
  console.log(
    JSON.stringify({
      phase: 'cleanup_inventory',
      deleteProjects: projects.length - 1,
      deleteObjects: deleteObjects.length,
      deleteBytes: deleteObjects.reduce((s, x) => s + x.size, 0),
      keepObjects: keepObjects.length,
      keepBytes: keepObjects.reduce((s, x) => s + x.size, 0),
      unknownObjects: unknown.length,
      apply,
    }),
  );
  if (!apply) return;
  if (unknown.length) throw new Error('Unknown ownership prevents deletion');
  const dump = await readFile(resolve(backupRoot, 'database-before-cleanup.dump'));
  if (dump.length < 1000 || dump.subarray(0, 5).toString() !== 'PGDMP')
    throw new Error('Database backup missing');
  if (!(await source.bucketExists(quarantineBucket))) await source.makeBucket(quarantineBucket);
  console.log(JSON.stringify({ phase: 'backup_test_files' }));
  await parallel(deleteObjects, async (object) => {
    const before = await source.statObject(sourceBucket, object.key);
    if (before.etag !== object.sourceEtag || before.size !== object.size)
      throw new Error('Source changed');
    const condition = new CopyConditions();
    condition.setMatchETag(before.etag);
    const existing = await objectStat(source, quarantineBucket, object.key);
    if (!existing)
      await source.copyObject(
        quarantineBucket,
        object.key,
        `/${sourceBucket}/${object.key}`,
        condition,
      );
    const [original, backup] = await Promise.all([
      fingerprint(await source.getObject(sourceBucket, object.key)),
      fingerprint(await source.getObject(quarantineBucket, object.key)),
    ]);
    if (
      original.sha256 !== backup.sha256 ||
      original.size !== object.size ||
      backup.size !== object.size
    )
      throw new Error('Backup hash mismatch');
    object.sha256 = original.sha256;
    object.backupEtag = (await source.statObject(quarantineBucket, object.key)).etag;
  });
  await writeFile(
    manifestPath,
    JSON.stringify(
      {
        keepProjectId,
        sourceBucket,
        quarantineBucket,
        backedUp: true,
        databaseBackupSha256: createHash('sha256').update(dump).digest('hex'),
        deleteProjectIds: projects.filter((p) => p.id !== keepProjectId).map((p) => p.id),
        deleteObjects,
        keepObjects,
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      phase: 'backup_verified',
      deleteProjects: projects.length - 1,
      files: deleteObjects.length,
      sourceDeleted: false,
    }),
  );
};
main()
  .catch((error) => {
    console.error(
      JSON.stringify({
        phase: 'cleanup_failed',
        code: error.code ?? 'CLEANUP_FAILED',
        constraint: error.constraint,
        table: error.table,
      }),
    );
    process.exitCode = 1;
  })
  .finally(() => database.end());
