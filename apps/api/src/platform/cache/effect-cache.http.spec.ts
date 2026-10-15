import { randomUUID } from 'node:crypto';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { expect, it, vi } from 'vitest';
import { AppModule } from '../../app.module';
import { HttpExceptionFilter } from '../../common/http-exception.filter';
import { ResponseEnvelopeInterceptor } from '../../common/response-envelope.interceptor';
import { PrismaService } from '../../database/prisma.service';
import { JobOutboxDispatcher } from '../job/job-outbox.dispatcher';
import { ProjectDeletionService } from '../project/project-deletion.service';
import { EffectExtractionLeaseRecovery } from '../../workflows/effect/information-extraction/effect-extraction-lease-recovery';
import { EffectPromptLeaseRecovery } from '../../workflows/effect/prompt-generation/effect-prompt-lease-recovery';
import { EffectSegmentRenderLeaseRecovery } from '../../workflows/effect/segment-render/effect-segment-render-lease-recovery';
import { EffectSegmentImportService } from '../../workflows/effect/segment-render/effect-segment-import.service';
import { EffectWorkingCleanupProcessor } from '../../workflows/effect/source-import/effect-working-cleanup.processor';
import { EffectTemplateMixLeaseRecovery } from '../../workflows/effect/template-mix/effect-template-mix-lease-recovery';
import { EffectReadCacheService } from './effect-read-cache.service';
import { RedisConnectionService } from './redis-connection.service';

// Opt-in: real PostgreSQL, Redis, Nest DI, controllers and service loaders. No business mocks.
// Background dispatch/recovery/cleanup is disabled so this app cannot process user tasks/files.
it.skipIf(process.env.EFFECT_CACHE_DATABASE_TEST !== '1')(
  'serves real HTTP cache hits, new drafts immediately, isolated Runs and Redis outage fallback',
  async () => {
    const environmentKeys = [
      'EFFECT_READ_CACHE_NAMESPACE',
      'EFFECT_READ_CACHE_ENABLED',
      'EFFECT_READ_CACHE_MIN_LOAD_MS',
      'EFFECT_READ_CACHE_TTL_SECONDS',
      'EFFECT_READ_CACHE_TIMEOUT_MS',
      'REDIS_URL',
    ];
    const originalEnvironment = new Map(environmentKeys.map((key) => [key, process.env[key]]));
    const hooks = [
      JobOutboxDispatcher,
      ProjectDeletionService,
      EffectExtractionLeaseRecovery,
      EffectPromptLeaseRecovery,
      EffectSegmentRenderLeaseRecovery,
      EffectSegmentImportService,
      EffectWorkingCleanupProcessor,
      EffectTemplateMixLeaseRecovery,
    ].map((provider) => vi.spyOn(provider.prototype, 'onModuleInit').mockImplementation(() => {}));
    const app = await NestFactory.create(AppModule, { logger: false, forceCloseConnections: true });
    const config = app.get(ConfigService);
    const namespace = `test:effect-http:${randomUUID()}`;
    config.set('EFFECT_READ_CACHE_NAMESPACE', namespace);
    config.set('EFFECT_READ_CACHE_ENABLED', true);
    config.set('EFFECT_READ_CACHE_MIN_LOAD_MS', 0);
    config.set('EFFECT_READ_CACHE_TTL_SECONDS', 30);
    config.set('EFFECT_READ_CACHE_TIMEOUT_MS', 1000);
    const db = app.get(PrismaService);
    const cache = app.get(EffectReadCacheService);
    const connection = app.get(RedisConnectionService);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createClient } = require('redis') as {
      createClient(options: unknown): {
        connect(): Promise<unknown>;
        destroy(): void;
        isOpen: boolean;
        on(event: string, callback: () => void): void;
        scanIterator(options: { MATCH: string; COUNT: number }): AsyncIterable<string[]>;
        ttl(key: string): Promise<number>;
        get(key: string): Promise<string | null>;
      };
    };
    const redis = createClient({
      url: config.getOrThrow<string>('REDIS_URL'),
      socket: { connectTimeout: 1000, reconnectStrategy: false },
    });
    redis.on('error', () => {});
    const projectId = randomUUID();
    const runId = randomUUID();
    try {
      await redis.connect();
      await db.project.create({ data: { id: projectId, name: 'Disposable Redis HTTP fixture' } });
      await db.workflowRun.create({
        data: {
          id: runId,
          projectId,
          workflow: 'EFFECT',
          workflowSpace: 'EFFECT',
          activeKey: 'ACTIVE',
        },
      });
      app.setGlobalPrefix('api');
      app.useGlobalPipes(
        new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }),
      );
      app.useGlobalInterceptors(new ResponseEnvelopeInterceptor());
      app.useGlobalFilters(new HttpExceptionFilter());
      await app.listen(0, '127.0.0.1');
      const base = `${await app.getUrl()}/api/projects/${projectId}`;
      const request = async (path: string, method = 'GET', body?: unknown) => {
        const response = await fetch(base + path, {
          method,
          signal: AbortSignal.timeout(15_000),
          ...(body === undefined
            ? {}
            : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
        });
        expect(response.status).toBeLessThan(300);
        return ((await response.json()) as { data: unknown }).data;
      };
      const keys = async (resource: string) => {
        const found: string[] = [];
        for await (const batch of redis.scanIterator({
          MATCH: `${namespace}:${projectId}:EFFECT:*:${resource}:*`,
          COUNT: 100,
        }))
          found.push(...batch.filter((key) => !key.endsWith(':fill')));
        return found;
      };
      const imported = (await request('/workflows/effect/source-import')) as {
        workspace: { id: string; workflowRunId: string; drafts: { SINGLE: { id: string } } };
      };
      const draftId = imported.workspace.drafts.SINGLE.id;
      const product = await db.effectImportProduct.create({
        data: {
          projectId,
          draftId,
          workflowRunId: runId,
          configOverride: {},
          name: 'Disposable product',
          category: 'Fixture',
        },
      });
      for (const [resource, path] of Object.entries({
        import: '/workflows/effect/source-import',
        'import-draft': '/workflows/effect/source-import/drafts/SINGLE',
        'import-products':
          '/workflows/effect/source-import/drafts/SINGLE/products?page=1&pageSize=20',
        'import-removed-products': '/workflows/effect/source-import/drafts/SINGLE/products/removed',
        extraction: `/workflows/effect/information-extraction?draftId=${draftId}`,
        'render-workspace': `/workflows/effect/segment-render/products/${product.id}?workflowRunId=${runId}`,
        prompt: `/workflows/effect/prompt-generation?workflowRunId=${runId}`,
        mix: `/workflows/effect/template-mix?workflowRunId=${runId}`,
        output: `/workflows/effect/final-output?workflowRunId=${runId}`,
        tree: '/workflow-runs/effect/branches',
        artifacts: `/working-artifacts?workflowRunId=${runId}&nodeId=TEMPLATE_MIX`,
      })) {
        const first = await request(path);
        const before = cache
          .diagnostics()
          .samples.filter(
            (sample) => sample.resource === resource && sample.outcome === 'hit',
          ).length;
        expect(await request(path)).toEqual(first);
        expect(
          cache
            .diagnostics()
            .samples.filter((sample) => sample.resource === resource && sample.outcome === 'hit')
            .length,
        ).toBeGreaterThan(before);
        const entries = await keys(resource);
        expect(entries.length).toBeGreaterThan(0);
        for (const key of entries) {
          expect(await redis.ttl(key)).toBeGreaterThan(0);
          expect(JSON.parse((await redis.get(key))!).checksum).toHaveLength(64);
        }
      }
      // Source reads must not physically rewrite a workspace and evict unrelated projections.
      const workspaceVersion = await db.$queryRaw<Array<{ version: string }>>`
        SELECT xmin::text AS version FROM effect_import_workspaces WHERE "projectId"=${projectId}::uuid`;
      const warmedMixKeys = await keys('mix');
      await request('/workflows/effect/source-import');
      await request('/workflows/effect/source-import/drafts/BATCH');
      expect(
        await db.$queryRaw`SELECT xmin::text AS version FROM effect_import_workspaces WHERE "projectId"=${projectId}::uuid`,
      ).toEqual(workspaceVersion);
      await request(`/workflows/effect/template-mix?workflowRunId=${runId}`);
      expect(await keys('mix')).toEqual(warmedMixKeys);
      // Two real autosaves invalidate the import cache immediately, even with a long TTL.
      let importRevision = (
        (await request('/workflows/effect/source-import/drafts/SINGLE')) as {
          revision: number;
        }
      ).revision;
      for (const name of ['First product edit', 'Second product edit']) {
        const saved = await request(
          `/workflows/effect/source-import/drafts/SINGLE/products/${product.id}`,
          'PATCH',
          { expectedRevision: importRevision, name },
        );
        const restored = (await request('/workflows/effect/source-import/drafts/SINGLE')) as {
          revision: number;
          products: Array<{ name: string }>;
        };
        expect(saved).toBeDefined();
        expect(restored.products[0]?.name).toBe(name);
        expect(restored.revision).toBeGreaterThan(importRevision);
        importRevision = restored.revision;
        expect(await request('/workflows/effect/source-import/drafts/SINGLE')).toEqual(restored);
      }
      const path = `/workflows/effect/template-mix?workflowRunId=${runId}`;
      const initialKeys = new Set(await keys('mix'));
      let revision: number | null = null;
      for (const activeTemplateId of ['first-save', 'second-save']) {
        const saved = (await request(`/workflow-runs/${runId}/nodes/TEMPLATE_MIX/state`, 'PUT', {
          expectedRevision: revision,
          state: { schemaVersion: 1, templates: [], activeTemplateId },
        })) as { nodeState: { revision: number } };
        revision = saved.nodeState.revision;
        const restored = (await request(path)) as {
          draftRevision: number;
          draft: { activeTemplateId: string };
        };
        expect(restored.draftRevision).toBe(revision);
        expect(restored.draft.activeTemplateId).toBe(activeTemplateId);
        expect(await request(path)).toEqual(restored);
      }
      expect((await keys('mix')).filter((key) => !initialKeys.has(key))).toHaveLength(2);
      // Navigation endpoint in the screenshot: a real write succeeds, then tree stays current.
      const activated = (await request(
        `/workflow-runs/${runId}/nodes/INFORMATION_EXTRACTION/activate`,
        'POST',
      )) as { run: { currentNodeId: string } };
      expect(activated.run.currentNodeId).toBe('INFORMATION_EXTRACTION');
      const tree = (await request('/workflow-runs/effect/branches')) as {
        branches: Array<{ workflowRunId: string; currentNodeId: string }>;
      };
      expect(tree.branches.find((branch) => branch.workflowRunId === runId)?.currentNodeId).toBe(
        'INFORMATION_EXTRACTION',
      );
      const sibling = await db.workflowRun.create({
        data: { projectId, workflow: 'EFFECT', workflowSpace: 'EFFECT', activeKey: null },
      });
      const isolated = (await request(
        `/workflows/effect/template-mix?workflowRunId=${sibling.id}`,
      )) as {
        draftRevision: number | null;
        draft: { activeTemplateId: string };
      };
      expect(isolated.draftRevision).toBeNull();
      expect(isolated.draft.activeTemplateId).toBe('');
      // A fresh namespace ensures this request must try Redis; do not stop the shared instance.
      connection.onModuleDestroy();
      config.set('REDIS_URL', 'redis://127.0.0.1:1');
      config.set('EFFECT_READ_CACHE_NAMESPACE', `${namespace}:outage`);
      config.set('EFFECT_READ_CACHE_TIMEOUT_MS', 100);
      const fallback = (await request(path)) as { draft: { activeTemplateId: string } };
      expect(fallback.draft.activeTemplateId).toBe('second-save');
      expect(cache.diagnostics().samples.at(-1)?.outcome).toBe('error');
    } finally {
      // No API delete: remove only this randomly-owned fixture, with its cascading Run/state rows.
      await db.project.deleteMany({ where: { id: projectId } });
      if (redis.isOpen) redis.destroy();
      await app.close();
      hooks.forEach((hook) => hook.mockRestore());
      for (const [key, value] of originalEnvironment) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  },
  60_000,
);
