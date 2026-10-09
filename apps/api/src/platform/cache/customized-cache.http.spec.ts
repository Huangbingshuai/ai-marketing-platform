import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ModulesContainer, NestFactory } from '@nestjs/core';
import { expect, it, vi } from 'vitest';
import {
  emptyCustomizedImportDraft,
  type WorkflowRunOverviewData,
  type WorkflowNodeState,
  type CustomizedWorkflowBranchTreeData,
} from '@ai-marketing/contracts';
import { AppModule } from '../../app.module';
import { HttpExceptionFilter } from '../../common/http-exception.filter';
import { ResponseEnvelopeInterceptor } from '../../common/response-envelope.interceptor';
import { PrismaService } from '../../database/prisma.service';
import { JobOutboxDispatcher } from '../job/job-outbox.dispatcher';
import { EffectExtractionLeaseRecovery } from '../../workflows/effect/information-extraction/effect-extraction-lease-recovery';
import { EffectPromptLeaseRecovery } from '../../workflows/effect/prompt-generation/effect-prompt-lease-recovery';
import { EffectSegmentRenderLeaseRecovery } from '../../workflows/effect/segment-render/effect-segment-render-lease-recovery';
import { EffectSegmentImportService } from '../../workflows/effect/segment-render/effect-segment-import.service';
import { EffectWorkingCleanupProcessor } from '../../workflows/effect/source-import/effect-working-cleanup.processor';
import { EffectTemplateMixLeaseRecovery } from '../../workflows/effect/template-mix/effect-template-mix-lease-recovery';
import { EffectReadCacheService } from './effect-read-cache.service';
import { EffectCacheRevisionService } from './effect-cache-revision.service';
import { RedisConnectionService } from './redis-connection.service';

// Real HTTP + PostgreSQL + Redis + local files. No Worker or external storage/model calls.
it.skipIf(process.env.CUSTOMIZED_CACHE_DATABASE_TEST !== '1')(
  'restores customized imports from Redis across saves, editing, publication and branch switches',
  async () => {
    const localRoot = await mkdtemp(join(tmpdir(), 'customized-cache-'));
    const envKeys = [
      'STORAGE_DRIVER',
      'LOCAL_STORAGE_ROOT',
      'REDIS_URL',
      'EFFECT_READ_CACHE_NAMESPACE',
      'EFFECT_READ_CACHE_TIMEOUT_MS',
      'EFFECT_READ_CACHE_MIN_LOAD_MS',
      'EFFECT_READ_CACHE_ENABLED',
    ];
    const oldEnv = new Map(envKeys.map((key) => [key, process.env[key]]));
    process.env.STORAGE_DRIVER = 'local';
    process.env.LOCAL_STORAGE_ROOT = localRoot;
    const hooks = [
      JobOutboxDispatcher,
      EffectExtractionLeaseRecovery,
      EffectPromptLeaseRecovery,
      EffectSegmentRenderLeaseRecovery,
      EffectSegmentImportService,
      EffectWorkingCleanupProcessor,
      EffectTemplateMixLeaseRecovery,
    ].map((provider) => vi.spyOn(provider.prototype, 'onModuleInit').mockImplementation(() => {}));
    const app = await NestFactory.create(AppModule, { logger: false, forceCloseConnections: true });
    // Also silence optional background deletion when testing a checkout that includes it.
    // The import cache must not depend on that independently developed module.
    for (const module of app.get(ModulesContainer).values()) {
      for (const provider of module.providers.values()) {
        const instance = provider.instance as
          { constructor?: { name?: string }; onModuleInit(): void } | undefined;
        if (instance?.constructor?.name === 'ProjectDeletionService')
          hooks.push(vi.spyOn(instance, 'onModuleInit').mockImplementation(() => {}));
      }
    }
    const config = app.get(ConfigService);
    const namespace = `test:customized-http:${randomUUID()}`;
    config.set('EFFECT_READ_CACHE_NAMESPACE', namespace);
    config.set('EFFECT_READ_CACHE_ENABLED', true);
    config.set('EFFECT_READ_CACHE_MIN_LOAD_MS', 0);
    config.set('EFFECT_READ_CACHE_TIMEOUT_MS', 1000);
    const db = app.get(PrismaService);
    const cache = app.get(EffectReadCacheService);
    const connection = app.get(RedisConnectionService);
    const versions = new EffectCacheRevisionService(db);
    const projectId = randomUUID();
    const otherProject = randomUUID();
    const keys = () =>
      connection.execute(async (client) => {
        const result = (await client.eval("return redis.call('KEYS', ARGV[1])", {
          keys: [],
          arguments: [`${namespace}:${projectId}:*`],
        })) as string[];
        return result.filter((key) => !key.endsWith(':fill'));
      });
    try {
      await db.project.create({
        data: { id: projectId, name: 'Disposable customized cache fixture' },
      });
      await db.project.create({ data: { id: otherProject, name: 'Disposable isolation fixture' } });
      app.setGlobalPrefix('api');
      app.useGlobalPipes(
        new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }),
      );
      app.useGlobalInterceptors(new ResponseEnvelopeInterceptor());
      app.useGlobalFilters(new HttpExceptionFilter());
      await app.listen(0, '127.0.0.1');
      const base = `${await app.getUrl()}/api/projects/${projectId}`;
      const request = async <T>(path: string, method = 'GET', body?: unknown): Promise<T> => {
        const response = await fetch(base + path, {
          method,
          signal: AbortSignal.timeout(15_000),
          ...(body instanceof FormData
            ? { body }
            : body === undefined
              ? {}
              : {
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify(body),
                }),
        });
        const result = (await response.json()) as { data: T; message?: string };
        expect(response.status, result.message).toBeLessThan(300);
        return result.data;
      };
      const overviewPath =
        '/workflow-runs/active/overview?workflow=CUSTOMIZED&space=CUSTOMIZED_PROJECT';
      const overview = () => request<WorkflowRunOverviewData>(overviewPath);
      const tree = () =>
        request<CustomizedWorkflowBranchTreeData>('/workflow-runs/customized/branches');
      expect((await overview()).run).toBeNull();
      const { run } = await request<{ run: { id: string } }>(
        '/workflow-runs/customized/draft',
        'POST',
      );
      const statePath = (runId = run.id) => `/workflow-runs/${runId}/nodes/SOURCE_IMPORT/state`;
      const editPath = (runId = run.id) =>
        `/workflow-runs/customized/branches/${runId}/nodes/SOURCE_IMPORT/edit`;
      const save = (runId: string, expectedRevision: number) =>
        request<{ run: { id: string }; unchanged: boolean; createdBranch: boolean }>(
          `/workflow-runs/customized/branches/${runId}/source-version`,
          'POST',
          { expectedRevision },
        );
      const put = async (runId: string, expectedRevision: number | null, state: unknown) =>
        (
          await request<{ nodeState: WorkflowNodeState; unchanged: boolean }>(
            statePath(runId),
            'PUT',
            { expectedRevision, state },
          )
        ).nodeState;
      const upload = async (name: string) => {
        const form = new FormData();
        form.set('section', 'BRIEF');
        form.set(
          'file',
          new Blob(['cache-test-private-document-body'], { type: 'text/plain' }),
          name,
        );
        return request<{ id: string; currentVersion: number }>(
          `/workflows/customized/source-import/runs/${run.id}/materials`,
          'POST',
          form,
        );
      };
      let state = await put(run.id, null, emptyCustomizedImportDraft());
      for (const path of [overviewPath, statePath(), '/workflow-runs/customized/branches']) {
        const hits = cache.diagnostics().counts.hit ?? 0;
        const first = await request(path);
        expect(await request(path)).toEqual(first);
        expect(cache.diagnostics().counts.hit).toBeGreaterThan(hits);
      }
      const first = await upload('first.txt');
      const second = await upload('second.txt');
      const reference = (id: string) => ({ assetId: id, assetVersion: 1, category: 'BRIEF' });
      const one = { ...emptyCustomizedImportDraft(), materials: [reference(first.id)] };
      const two = { ...one, materials: [reference(first.id), reference(second.id)] };
      for (const next of [one, two]) {
        state = await put(run.id, state.revision, next);
        expect((await request<WorkflowNodeState>(statePath())).state).toEqual(next);
        expect((await overview()).nodeStates[0]?.state).toEqual(next);
      }
      const stamp = await versions.read(
        { projectId, workflow: 'CUSTOMIZED', workflowRunId: run.id },
        'customized-import-draft',
      );
      const unchangedState = await put(run.id, state.revision, two);
      expect(unchangedState.revision).toBe(state.revision);
      expect(
        await versions.read(
          { projectId, workflow: 'CUSTOMIZED', workflowRunId: run.id },
          'customized-import-draft',
        ),
      ).toEqual(stamp);
      await save(run.id, state.revision);
      expect((await tree()).branches[0]?.nodes[0]?.status).toBe('CONFIRMED');
      // An unchanged isolated edit returns to parent and its cached child disappears.
      let child = (await request<{ run: { id: string } }>(editPath(), 'POST')).run.id;
      expect((await overview()).run?.id).toBe(child);
      expect((await tree()).branches).toHaveLength(1);
      const childState = await request<WorkflowNodeState>(statePath(child));
      expect((await save(child, childState.revision)).unchanged).toBe(true);
      expect((await overview()).run?.id).toBe(run.id);
      expect((await fetch(base + statePath(child))).status).toBe(404);
      child = (await request<{ run: { id: string } }>(editPath(), 'POST')).run.id;
      await request(statePath(child));
      await request(`${editPath(child)}/cancel`, 'POST');
      expect((await overview()).run?.id).toBe(run.id);
      expect((await fetch(base + statePath(child))).status).toBe(404);
      // A delayed read cannot return the old refs after another committed autosave.
      child = (await request<{ run: { id: string } }>(editPath(), 'POST')).run.id;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const loader = vi.fn(async () => {
        const record = await db.workflowNodeState.findFirstOrThrow({
          where: { projectId, workflowRunId: child, nodeId: 'SOURCE_IMPORT' },
          select: { nodeId: true, state: true },
        });
        if (loader.mock.calls.length === 1) await gate;
        return record;
      });
      const racing = cache.read(
        { projectId, workflow: 'CUSTOMIZED', workflowRunId: child },
        'customized-import-draft',
        loader,
        'late-read',
      );
      await vi.waitFor(() => expect(loader).toHaveBeenCalledTimes(1));
      state = await request<WorkflowNodeState>(statePath(child));
      state = await put(child, state.revision, one);
      release();
      expect((await racing).state).toEqual(one);
      expect(loader).toHaveBeenCalledTimes(2);
      expect((await save(child, state.revision)).createdBranch).toBe(true);
      expect((await tree()).branches).toHaveLength(2);
      for (const [id, expected] of [
        [run.id, two],
        [child, one],
      ] as const) {
        await request(
          `/workflow-runs/customized/branches/${id}/nodes/SOURCE_IMPORT/activate`,
          'POST',
        );
        expect((await overview()).run?.id).toBe(id);
        expect((await overview()).nodeStates[0]?.state).toEqual(expected);
        expect((await tree()).activeWorkflowRunId).toBe(id);
      }
      const effect = await db.workflowRun.create({
        data: { projectId, workflow: 'EFFECT', workflowSpace: 'EFFECT' },
      });
      expect(
        await versions.read(
          { projectId, workflow: 'CUSTOMIZED', workflowRunId: effect.id },
          'customized-import-draft',
        ),
      ).toBeNull();
      expect(
        await versions.read(
          { projectId: otherProject, workflow: 'CUSTOMIZED', workflowRunId: child },
          'customized-import-draft',
        ),
      ).toBeNull();
      const scoped = { projectId, workflow: 'CUSTOMIZED' as const, workflowRunId: child };
      const beforeEffectNavigation = await versions.read(scoped, 'customized-overview');
      await db.workflowRun.update({
        where: { id: effect.id },
        data: { currentNodeId: 'INFORMATION_EXTRACTION' },
      });
      expect(await versions.read(scoped, 'customized-overview')).toEqual(beforeEffectNavigation);
      // Legacy drafts keep working but neither the draft nor overview leaks raw text to Redis.
      await db.workflowNodeState.updateMany({
        where: { projectId, workflowRunId: child },
        data: { state: { ...one, requirements: 'legacy-private-body' } },
      });
      expect((await request<WorkflowNodeState>(statePath(child))).state).toEqual({
        ...one,
        requirements: 'legacy-private-body',
      });
      await overview();
      const stored = await keys();
      expect(stored.length).toBeGreaterThan(0);
      for (const key of stored) {
        expect(key).toContain(':CUSTOMIZED:');
        const raw = await connection.execute((client) => client.get(key));
        expect(raw).not.toContain('legacy-private-body');
        expect(raw).not.toContain('cache-test-private-document-body');
      }
      await connection.execute((client) =>
        client.eval(
          "local keys = redis.call('KEYS', ARGV[1]); for _, key in ipairs(keys) do redis.call('DEL', key) end; return #keys",
          { keys: [], arguments: [`${namespace}:${projectId}:*`] },
        ),
      );
      expect(await keys()).toEqual([]);
      connection.onModuleDestroy();
      config.set('REDIS_URL', 'redis://127.0.0.1:1');
      config.set('EFFECT_READ_CACHE_NAMESPACE', `${namespace}:outage`);
      config.set('EFFECT_READ_CACHE_TIMEOUT_MS', 100);
      expect((await overview()).run?.id).toBe(child);
      expect(cache.diagnostics().samples.at(-1)?.outcome).toBe('error');
    } finally {
      // Delete only randomly owned fixtures; never start the production deletion worker.
      await db.assetOperationReceipt.deleteMany({ where: { projectId } });
      await db.assetVersion.deleteMany({ where: { projectId } });
      await db.asset.deleteMany({ where: { projectId } });
      await db.workflowRun.deleteMany({ where: { projectId, parentWorkflowRunId: { not: null } } });
      await db.project.deleteMany({ where: { id: { in: [projectId, otherProject] } } });
      await app.close();
      // mkdtemp is the sole source of this absolute directory, including its local test uploads.
      await rm(localRoot, { recursive: true, force: true });
      hooks.forEach((hook) => hook.mockRestore());
      for (const [key, value] of oldEnv) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  },
  60_000,
);
