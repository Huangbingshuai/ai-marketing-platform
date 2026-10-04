import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadEnvFile } from 'node:process';
import { createHash } from 'node:crypto';
import { Agent } from 'node:https';
import { Client, CopyConditions } from 'minio';
import { Client as PgClient } from 'pg';
import { collectStorageOwners, projectStorageOwner } from './project-storage-scope.mjs';
import { fingerprint, objectStat } from './minio-to-tos.mjs';

// Exact project explicitly authorized for deletion; never name/substring matching.
const projectId = '40d1273a-e1cd-4cae-8f83-02fdaf324dc1';
const root = resolve(
  import.meta.dirname,
  '../../../.local-storage/backups/project-cleanup-final-20261004',
);
const manifestPath = resolve(root, 'cleanup-manifest.json');
loadEnvFile(resolve(import.meta.dirname, '../../../.env'));
const e = process.env;
const bucket = e.MINIO_BUCKET;
const backupBucket = 'ai-marketing-project-trash-20261004';
const source = new Client({
  endPoint: e.MINIO_ENDPOINT,
  port: Number(e.MINIO_PORT),
  useSSL: e.MINIO_USE_SSL === 'true',
  accessKey: e.MINIO_ACCESS_KEY,
  secretKey: e.MINIO_SECRET_KEY,
});
const cloud = new Client({
  endPoint: `tos-s3-${e.TOS_REGION}.volces.com`,
  region: e.TOS_REGION,
  port: 443,
  useSSL: true,
  pathStyle: false,
  accessKey: e.TOS_ACCESS_KEY_ID,
  secretKey: e.TOS_SECRET_ACCESS_KEY,
  transportAgent: new Agent({
    keepAlive: true,
    timeout: 30000,
    maxSockets: 16,
    maxVersion: 'TLSv1.2',
  }),
});
const db = new PgClient({ connectionString: e.DATABASE_URL });
const apply = process.argv.includes('--apply');
const mode = process.argv.find((arg) => arg.startsWith('--mode='))?.slice(7) ?? 'backup';
const parallel = async (rows, action) => {
  let cursor = 0,
    completed = 0;
  await Promise.all(
    Array.from({ length: 12 }, async () => {
      while (cursor < rows.length) {
        await action(rows[cursor++]);
        completed++;
        if (completed % 500 === 0 || completed === rows.length)
          console.log(JSON.stringify({ phase: mode, completed, total: rows.length }));
      }
    }),
  );
};
const check = (condition, code) => {
  if (!condition) throw Object.assign(new Error(code), { code });
};
const sharedFingerprint = async () => {
  const rows = await db.query(
    'SELECT to_jsonb(v)::text AS payload FROM effect_voice_catalog_samples v ORDER BY to_jsonb(v)::text',
  );
  return createHash('sha256')
    .update(rows.rows.map((r) => r.payload).join('\n'))
    .digest('hex');
};
const main = async () => {
  check(['backup', 'database', 'local', 'tos'].includes(mode), 'INVALID_MODE');
  await db.connect();
  if (mode === 'backup') {
    const projects = (await db.query('SELECT id,name FROM projects')).rows;
    check(
      projects.length === 1 && projects[0].id === projectId && projects[0].name === '紫苏梅子酱',
      'PROJECT_IDENTITY_CHANGED',
    );
    const owners = await collectStorageOwners(db);
    const shared = new Set(
      (await db.query('SELECT "storageKey" FROM effect_voice_catalog_samples')).rows.map(
        (r) => r.storageKey,
      ),
    );
    const objects = [];
    let preserved = 0;
    for await (const obj of source.listObjectsV2(bucket, '', true)) {
      if (!obj.name) continue;
      if (obj.name.startsWith('shared/') || shared.has(obj.name)) {
        preserved++;
        continue;
      }
      check(
        projectStorageOwner(obj.name, projects) === projectId ||
          owners.get(obj.name)?.has(projectId),
        'UNKNOWN_OBJECT_OWNER',
      );
      objects.push({ key: obj.name, size: obj.size, sourceEtag: obj.etag });
    }
    console.log(
      JSON.stringify({
        phase: 'inventory',
        projectId,
        objects: objects.length,
        bytes: objects.reduce((n, o) => n + o.size, 0),
        sharedPreserved: preserved,
        apply,
      }),
    );
    if (!apply) return;
    const dump = await readFile(resolve(root, 'database-before-cleanup.dump'));
    check(dump.length > 1000 && dump.subarray(0, 5).toString() === 'PGDMP', 'BACKUP_REQUIRED');
    check(await source.bucketExists(backupBucket), 'BACKUP_BUCKET_REQUIRED');
    await parallel(objects, async (obj) => {
      const stat = await source.statObject(bucket, obj.key);
      check(stat.etag === obj.sourceEtag && stat.size === obj.size, 'SOURCE_CHANGED');
      const condition = new CopyConditions();
      condition.setMatchETag(stat.etag);
      if (!(await objectStat(source, backupBucket, obj.key)))
        await source.copyObject(backupBucket, obj.key, `/${bucket}/${obj.key}`, condition);
      const [original, backup] = await Promise.all([
        fingerprint(await source.getObject(bucket, obj.key)),
        fingerprint(await source.getObject(backupBucket, obj.key)),
      ]);
      check(
        original.sha256 === backup.sha256 && original.size === obj.size && backup.size === obj.size,
        'BACKUP_HASH_MISMATCH',
      );
      obj.sha256 = original.sha256;
      obj.backupEtag = (await source.statObject(backupBucket, obj.key)).etag;
    });
    await writeFile(
      manifestPath,
      JSON.stringify(
        {
          projectId,
          bucket,
          backupBucket,
          objects,
          backedUp: true,
          databaseBackupSha256: createHash('sha256').update(dump).digest('hex'),
        },
        null,
        2,
      ),
    );
    console.log(JSON.stringify({ phase: 'backup_verified', files: objects.length }));
    return;
  }
  check(apply, 'EXPLICIT_APPLY_REQUIRED');
  const m = JSON.parse(await readFile(manifestPath, 'utf8'));
  check(
    m.backedUp &&
      m.projectId === projectId &&
      m.bucket === bucket &&
      m.backupBucket === backupBucket,
    'BACKUP_MANIFEST_MISMATCH',
  );
  const dump = await readFile(resolve(root, 'database-before-cleanup.dump'));
  check(
    createHash('sha256').update(dump).digest('hex') === m.databaseBackupSha256,
    'DATABASE_BACKUP_CHANGED',
  );
  if (mode === 'database') {
    await db.query('BEGIN');
    try {
      await db.query('LOCK TABLE projects IN SHARE ROW EXCLUSIVE MODE');
      const p = (await db.query('SELECT id,name FROM projects')).rows;
      check(
        p.length === 1 && p[0].id === projectId && p[0].name === '紫苏梅子酱',
        'PROJECT_IDENTITY_CHANGED',
      );
      for (const table of [
        'effect_extraction_runs',
        'effect_final_output_runs',
        'effect_packaging_runs',
        'effect_prompt_runs',
        'effect_segment_render_tasks',
        'effect_template_mix_ai_runs',
      ]) {
        const n = await db.query(
          `SELECT count(*)::int AS count FROM ${table} WHERE "projectId"=$1 AND (to_jsonb(${table})->>'status' IN ('QUEUED','RUNNING') OR to_jsonb(${table})->>'repairStatus' IN ('QUEUED','RUNNING'))`,
          [projectId],
        );
        check(n.rows[0].count === 0, 'ACTIVE_TASKS');
      }
      const before = await sharedFingerprint();
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
        await db.query(`DELETE FROM ${table} WHERE "projectId"=$1`, [projectId]);
      await db.query('DELETE FROM projects WHERE id=$1', [projectId]);
      check(before === (await sharedFingerprint()), 'SHARED_RESOURCE_CHANGED');
      const tables = await db.query(
        `SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='projectId'`,
      );
      for (const { table_name: table } of tables.rows) {
        check(/^[a-z_]+$/.test(table), 'INVALID_TABLE');
        const n = await db.query(
          `SELECT count(*)::int AS count FROM "${table}" WHERE "projectId"=$1`,
          [projectId],
        );
        check(n.rows[0].count === 0, 'PROJECT_ROWS_REMAIN');
      }
      await db.query('COMMIT');
      console.log(JSON.stringify({ phase: 'project_deleted', projectsRemaining: 0 }));
    } catch (error) {
      await db.query('ROLLBACK');
      throw error;
    }
    return;
  }
  check(
    (await db.query('SELECT count(*)::int AS count FROM projects')).rows[0].count === 0,
    'DATABASE_DELETE_REQUIRED',
  );
  const protectedKeys = new Set(
    (await db.query('SELECT "storageKey" FROM effect_voice_catalog_samples')).rows.map(
      (r) => r.storageKey,
    ),
  );
  const known = new Set();
  const client = mode === 'tos' ? cloud : source;
  const activeBucket = mode === 'tos' ? e.TOS_BUCKET : bucket;
  for await (const obj of client.listObjectsV2(activeBucket, '', true))
    if (obj.name) known.add(obj.name);
  const keys = new Set(m.objects.map((o) => o.key));
  check(
    [...known].every((key) => keys.has(key) || key.startsWith('shared/') || protectedKeys.has(key)),
    'UNKNOWN_ACTIVE_KEY',
  );
  await parallel(m.objects, async (obj) => {
    check(!obj.key.startsWith('shared/') && !protectedKeys.has(obj.key), 'PROTECTED_KEY');
    const backup = await source.statObject(backupBucket, obj.key);
    check(backup.etag === obj.backupEtag && backup.size === obj.size, 'BACKUP_CHANGED');
    if (!known.has(obj.key)) return;
    const original = await client.statObject(activeBucket, obj.key);
    if (mode === 'local')
      check(
        original.etag === obj.sourceEtag && original.size === obj.size,
        'SOURCE_CHANGED_AFTER_BACKUP',
      );
    // Cloud copies are also authorized for deletion, but only exact backed-up project keys.
    await client.removeObject(activeBucket, obj.key);
  });
  let remainingProjectObjects = 0,
    sharedObjects = 0;
  for await (const obj of client.listObjectsV2(activeBucket, '', true))
    if (obj.name) {
      if (keys.has(obj.name)) remainingProjectObjects++;
      else sharedObjects++;
    }
  check(remainingProjectObjects === 0, 'PROJECT_OBJECTS_REMAIN');
  console.log(
    JSON.stringify({
      phase: 'files_deleted',
      storage: mode,
      projectObjectsRemaining: remainingProjectObjects,
      sharedObjects,
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
  .finally(() => db.end());
