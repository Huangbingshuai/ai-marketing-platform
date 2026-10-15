// Isolated verifier: all PostgreSQL fixtures roll back, storage is local, no model calls.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PrismaService } from '../dist/database/prisma.service.js';
import { ProjectDeletionRepository } from '../dist/platform/project/project-deletion.repository.js';
import { ProjectDeletionService } from '../dist/platform/project/project-deletion.service.js';
import { LocalStorageAdapter } from '../dist/platform/file/local-storage.adapter.js';
import { ProjectDeletionCacheService } from '../dist/platform/project/project-deletion-cache.service.js';
import { RedisConnectionService } from '../dist/platform/cache/redis-connection.service.js';
import { ProjectRepository } from '../dist/platform/project/project.repository.js';
import { ProjectService } from '../dist/platform/project/project.service.js';
const config = { get: (key) => process.env[key], getOrThrow: (key) => process.env[key] };
const prisma = new PrismaService(config),
  projectId = randomUUID(),
  otherId = randomUUID(),
  checks = [];
const root = resolve('.tmp-import-qa', 'project-delete-storage-' + projectId),
  local = new LocalStorageAdapter({ get: () => root });
const redis = new RedisConnectionService(config),
  cache = new ProjectDeletionCacheService(redis, config);
const schema = readFileSync('apps/api/prisma/schema.prisma', 'utf8');
const blocks = [...schema.matchAll(/model (\w+) \{([\s\S]*?)\n\}/g)];
const enums = [...schema.matchAll(/enum (\w+) \{([\s\S]*?)\n\}/g)].map((m) => ({
  name: m[1],
  values: m[2]
    .trim()
    .split(/\s+/)
    .map((name) => ({ name })),
}));
const models = blocks.map(([, name, body]) => ({
  name,
  fields: [...body.matchAll(/^\s*(\w+)\s+(\w+)(\?|\[\])?([^\n]*)/gm)].map((m) => ({
    name: m[1],
    type: m[2],
    kind: blocks.some((b) => b[1] === m[2])
      ? 'object'
      : enums.some((e) => e.name === m[2])
        ? 'enum'
        : 'scalar',
    isList: m[3] === '[]',
    isRequired: m[3] !== '?',
    hasDefaultValue: m[4].includes('@default'),
    isUpdatedAt: m[4].includes('@updatedAt'),
    nativeType: m[4].includes('@db.Uuid') ? ['Uuid'] : [],
    relationFromFields: (m[4].match(/fields: \[([^\]]+)\]/)?.[1] || '')
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean),
    relationToFields: (m[4].match(/references: \[([^\]]+)\]/)?.[1] || '')
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean),
  })),
}));
const rows = new Map(),
  written = [],
  owned = [];
const check = (ok, name) => {
  assert.ok(ok, name);
  checks.push(name);
};
const delegate = (name) => name[0].toLowerCase() + name.slice(1);
async function create(tx, model, override = {}) {
  const data = {};
  for (const field of model.fields) {
    if (field.kind === 'object' || field.hasDefaultValue || field.isUpdatedAt || !field.isRequired)
      continue;
    if (field.isList) data[field.name] = [];
    else if (field.kind === 'enum')
      data[field.name] = enums.find((e) => e.name === field.type).values[0].name;
    else if (field.type === 'String')
      data[field.name] =
        field.nativeType?.[0] === 'Uuid'
          ? randomUUID()
          : field.name.toLowerCase().includes('hash') ||
              field.name.toLowerCase().includes('fingerprint')
            ? 'a'.repeat(64)
            : 'qa';
    else if (field.type === 'Json') data[field.name] = {};
    else if (field.type === 'Int' || field.type === 'Float') data[field.name] = 1;
    else if (field.type === 'DateTime') data[field.name] = new Date('2030-01-01T00:00:00Z');
    else if (field.type === 'Boolean') data[field.name] = false;
  }
  for (const relation of model.fields.filter(
    (f) => f.kind === 'object' && f.isRequired && f.relationFromFields.length,
  )) {
    const target = rows.get(relation.type);
    assert.ok(target, model.name + ' needs ' + relation.type);
    relation.relationFromFields.forEach(
      (field, i) => (data[field] = target[relation.relationToFields[i]]),
    );
  }
  if (model.fields.some((f) => f.name === 'projectId')) data.projectId = projectId;
  const status = model.fields.find((f) => f.name === 'status');
  if (status) {
    const opts =
      status.kind === 'enum'
        ? enums.find((e) => e.name === status.type).values.map((v) => v.name)
        : ['COMPLETED'];
    data.status = opts.includes('COMPLETED')
      ? 'COMPLETED'
      : opts.includes('READY')
        ? 'READY'
        : opts[0];
  }
  for (const field of model.fields.filter(
    (f) => /storageKey$/i.test(f.name) && f.type === 'String',
  )) {
    const key = 'owned-' + owned.length;
    data[field.name] = key;
    owned.push(key);
    await fs.writeFile(resolve(root, key), 'isolated deletion fixture');
    written.push(key);
  }
  Object.assign(data, override);
  const row = await tx[delegate(model.name)].create({ data });
  rows.set(model.name, row);
  return row;
}
(async () => {
  await fs.mkdir(root, { recursive: true });
  try {
    await prisma.$transaction(
      async (tx) => {
        const project = await tx.project.create({
          data: { id: projectId, name: '永久删除数据库隔离验收（事务回滚）' },
        });
        rows.set('Project', project);
        await tx.project.create({ data: { id: otherId, name: '删除隔离保护（事务回滚）' } });
        const scoped = models.filter(
          (m) =>
            m.name !== 'ProjectDeletionCleanup' && m.fields.some((f) => f.name === 'projectId'),
        );
        const pending = [...scoped];
        while (pending.length) {
          const index = pending.findIndex((m) =>
            m.fields
              .filter((f) => f.kind === 'object' && f.isRequired && f.relationFromFields.length)
              .every((f) => rows.has(f.type)),
          );
          assert.ok(index >= 0, 'fixture dependency graph can be built');
          const model = pending.splice(index, 1)[0];
          await create(
            tx,
            model,
            model.name === 'WorkflowRun' ? { workflow: 'EFFECT', workflowSpace: 'EFFECT' } : {},
          );
        }
        check(rows.size > 35, 'populated all ' + scoped.length + ' project-scoped tables');
        const run = rows.get('WorkflowRun');
        await tx.workflowRun.create({
          data: {
            projectId,
            workflow: 'EFFECT',
            workflowSpace: 'EFFECT',
            activeKey: null,
            parentWorkflowRunId: run.id,
            currentNodeId: 'SOURCE_IMPORT',
          },
        });
        await tx.workflowRun.create({
          data: {
            projectId,
            workflow: 'CUSTOMIZED',
            workflowSpace: 'CUSTOMIZED_PROJECT',
            currentNodeId: 'SOURCE_IMPORT',
          },
        });
        await tx.workflowRun.create({
          data: {
            projectId,
            workflow: 'FISSION',
            workflowSpace: 'FISSION_CLONE',
            currentNodeId: 'SOURCE_IMPORT',
          },
        });
        const product = rows.get('EffectImportProduct'),
          manifest = rows.get('EffectManifestImport');
        await tx.effectImportProduct.update({
          where: { id: product.id },
          data: { sourceManifestImportId: manifest.id },
        });
        const artifact = rows.get('WorkingArtifact');
        await tx.workingArtifactDependency.updateMany({
          where: { projectId },
          data: { sourceArtifactId: artifact.id },
        });
        const asset = rows.get('Asset');
        await tx.asset.update({ where: { id: asset.id }, data: { archivedAt: new Date() } });
        const protectedKey = asset.storageKey;
        await tx.asset.create({
          data: {
            projectId: otherId,
            name: '共享引用保护',
            directory: 'SOURCE_MATERIALS',
            type: 'SOURCE_MATERIAL',
            originalFileName: 'qa.txt',
            mimeType: 'text/plain',
            sizeBytes: 1,
            storageKey: protectedKey,
          },
        });
        const sharedKey = 'shared/isolated-' + projectId;
        await fs.mkdir(resolve(root, 'shared'), { recursive: true });
        await fs.writeFile(resolve(root, sharedKey), 'shared');
        written.push(sharedKey);
        await tx.asset.create({
          data: {
            projectId,
            name: '共享音色引用',
            directory: 'SOURCE_MATERIALS',
            type: 'SOURCE_MATERIAL',
            originalFileName: 'qa.wav',
            mimeType: 'audio/wav',
            sizeBytes: 1,
            storageKey: sharedKey,
          },
        });
        const repo = new ProjectDeletionRepository({
          $transaction: (fn) => fn(tx),
          projectDeletionCleanup: tx.projectDeletionCleanup,
          project: tx.project,
        });
        // A real active task must reject atomically, with no cleanup manifest or file deletion.
        await tx.effectSegmentRenderTask.updateMany({
          where: { projectId },
          data: { repairStatus: 'RUNNING' },
        });
        await assert.rejects(() => repo.enqueue(projectId), /项目仍有生成或上传任务/);
        check(
          (await tx.project.count({ where: { id: projectId } })) === 1 &&
            !(await repo.hasPending(projectId)),
          'active repair rejects deletion without changing DB',
        );
        await tx.effectSegmentRenderTask.updateMany({
          where: { projectId },
          data: { repairStatus: 'READY' },
        });
        const namespace = process.env.EFFECT_READ_CACHE_NAMESPACE || 'amp:effect-read:v1';
        const cacheKey = namespace + ':' + projectId + ':EFFECT:isolated-qa',
          otherCache = namespace + ':' + otherId + ':EFFECT:isolated-qa';
        await redis.execute(async (client) => {
          await client.set(cacheKey, 'isolated', { EX: 60 });
          await client.set(otherCache, 'protected', { EX: 60 });
        });
        let fail = true;
        const storage = {
          delete: async (key) => {
            if (fail) {
              fail = false;
              throw Error('isolated failure');
            }
            return local.delete(key);
          },
        };
        const service = new ProjectDeletionService(repo, storage, cache);
        await assert.rejects(
          () => service.remove(projectId, { currentProjectId: projectId }),
          /当前项目不可删除/,
        );
        check(
          !(await repo.hasPending(projectId)),
          'current project rejects submission without creating a job',
        );
        const first = await service.remove(projectId);
        check(
          first.status === 'QUEUED' && !first.deleted,
          'request returns queued before heavy DB/file deletion',
        );
        check(
          (await tx.fileObject.count({ where: { projectId } })) > 0 &&
            (await tx.asset.count({ where: { projectId } })) > 0,
          'queued request preserves rows for the background worker',
        );
        const projects = new ProjectService(new ProjectRepository(tx));
        await assert.rejects(() => projects.get(projectId), /项目正在删除/);
        check(
          (await projects.list()).some(
            (p) => p.id === projectId && p.deletion?.status === 'QUEUED',
          ),
          'queued state restored from the project list',
        );
        await service.remove(projectId);
        check(
          (await tx.projectDeletionCleanup.count({ where: { projectId } })) === 1,
          'duplicate submission reuses one persistent job',
        );
        await tx.projectDeletionCleanup.update({ where: { projectId }, data: { attempts: 2 } });
        const exhaustedToken = randomUUID();
        await repo.claim(projectId, exhaustedToken);
        await repo.fail(projectId, exhaustedToken, '隔离测试数据库故障', false);
        check(
          (await tx.project.findUnique({ where: { id: projectId } })).deletionState === 'FAILED',
          'database retry exhaustion preserves rows and exposes failure',
        );
        check(
          (await projects.list()).some(
            (p) => p.id === projectId && p.deletion?.status === 'FAILED',
          ),
          'failure state survives a fresh list read',
        );
        await service.remove(projectId);
        await repo.fail(projectId, exhaustedToken, 'late failure must not overwrite retry', true);
        check(
          (await tx.project.findUnique({ where: { id: projectId } })).deletionState === 'QUEUED',
          'manual retry resets job and rejects old-token failure',
        );
        const crashedToken = randomUUID();
        await repo.claim(projectId, crashedToken);
        await tx.projectDeletionCleanup.update({
          where: { projectId },
          data: { nextAttemptAt: new Date(0) },
        });
        // A fresh instance resumes the durable DATABASE lease after an simulated crash.
        const restarted = new ProjectDeletionService(repo, storage, cache);
        await restarted.cleanup(projectId);
        check(
          (await service.status(projectId)).storageCleanup === 'PENDING',
          'storage failure retains independent cleanup manifest after project deletion',
        );
        check(
          (await projects.list({ workflow: 'EFFECT', space: 'EFFECT' })).some(
            (p) => p.id === projectId && p.deletion?.phase === 'FILES',
          ),
          'project remains visible during file cleanup after its database row is gone',
        );
        check(
          !(await repo.remove(projectId, crashedToken)),
          'old DATABASE lease cannot advance deletion after recovery',
        );
        for (const model of scoped)
          check(
            (await tx[delegate(model.name)].count({ where: { projectId } })) === 0,
            'deleted ' + model.name,
          );
        check((await tx.project.count({ where: { id: projectId } })) === 0, 'project deleted');
        check(
          (await tx.project.count({ where: { id: otherId } })) === 1,
          'other project preserved',
        );
        await tx.projectDeletionCleanup.update({
          where: { projectId },
          data: { nextAttemptAt: new Date(0) },
        });
        const lease = randomUUID(),
          leased = await repo.claim(projectId, lease);
        check(
          leased.keys.length === 1 && (await repo.claim(projectId, randomUUID())) === null,
          'cleanup lease rejects duplicate claim',
        );
        await repo.finish(projectId, randomUUID(), [], true);
        check(
          await repo.hasPending(projectId),
          'late wrong-token completion cannot remove cleanup manifest',
        );
        await repo.finish(projectId, lease, leased.keys, true);
        await tx.projectDeletionCleanup.update({
          where: { projectId },
          data: { nextAttemptAt: new Date(0) },
        });
        await restarted.cleanup(projectId);
        check(
          (await service.status(projectId)).storageCleanup === 'COMPLETED',
          'repeat deletion resumes failed file and completes',
        );
        for (const key of owned.filter((k) => k !== protectedKey))
          await assert.rejects(() => fs.stat(resolve(root, key)), { code: 'ENOENT' });
        check(
          !!(await fs.stat(resolve(root, protectedKey))) &&
            !!(await fs.stat(resolve(root, sharedKey))),
          'other-project references and shared files preserved',
        );
        check(
          (await redis.execute((c) => c.get(cacheKey))) === null,
          'project read caches deleted',
        );
        check(
          (await redis.execute((c) => c.get(otherCache))) === 'protected',
          'other project cache preserved',
        );
        await redis.execute((c) => c.del(otherCache));
        check(!(await repo.hasPending(projectId)), 'cleanup manifest removed after success');
        check(
          !(await projects.list()).some((p) => p.id === projectId),
          'completion removes the project and its temporary list snapshot',
        );
        check(
          (await service.remove(projectId)).storageCleanup === 'COMPLETED',
          'third deletion is idempotent',
        );
        // Missing scoped parents reject any late task writes.
        await assert.rejects(() =>
          tx.workflowRun.create({
            data: {
              projectId,
              workflow: 'CUSTOMIZED',
              workflowSpace: 'CUSTOMIZED_PROJECT',
              currentNodeId: 'SOURCE_IMPORT',
            },
          }),
        );
        throw Error('DELETE_QA_ROLLBACK');
      },
      { timeout: 60000 },
    );
  } catch (e) {
    if (e.message !== 'DELETE_QA_ROLLBACK') throw e;
  }
  check(
    (await prisma.project.count({ where: { id: { in: [projectId, otherId] } } })) === 0,
    'all test rows rolled back; user projects untouched',
  );
  console.log(
    JSON.stringify({
      checks,
      modelCalls: 0,
      storageDriver: 'isolated LocalStorageAdapter',
      allDatabaseFixturesRolledBack: true,
    }),
  );
})()
  .catch((e) => {
    console.error(e.name + ': ' + e.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    redis.onModuleDestroy();
    await prisma.$disconnect();
    for (const key of written) await fs.rm(resolve(root, key), { force: true });
  });
