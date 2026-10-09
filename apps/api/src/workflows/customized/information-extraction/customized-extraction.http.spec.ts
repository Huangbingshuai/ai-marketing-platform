import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ModulesContainer, NestFactory } from '@nestjs/core';
import { expect, it, vi } from 'vitest';
import {
  CUSTOMIZED_EXTRACTION_NODES,
  emptyCustomizedBrief,
  emptyCustomizedImportDraft,
  type CustomizedExtractionTask,
  type CustomizedExtractionWorkspace,
  type CustomizedBriefCandidate,
  type WorkflowNodeState,
} from '@ai-marketing/contracts';
import { AppModule } from '../../../app.module';
import { HttpExceptionFilter } from '../../../common/http-exception.filter';
import { ResponseEnvelopeInterceptor } from '../../../common/response-envelope.interceptor';
import { PrismaService } from '../../../database/prisma.service';
import { EffectReadCacheService } from '../../../platform/cache/effect-read-cache.service';
import { RedisConnectionService } from '../../../platform/cache/redis-connection.service';
import { CustomizedExtractionRepository } from './customized-extraction.repository';
import type { Prisma } from '../../../generated/prisma/client';

// Real HTTP / PostgreSQL / Redis / local storage. The Worker protocol is driven by this test;
// background dispatchers are disabled and no external model is contacted.
it.skipIf(process.env.CUSTOMIZED_EXTRACTION_HTTP_TEST !== '1')(
  'round-trips fixed files, checkpoints, protected callbacks, drafts and cached confirmed results',
  async () => {
    const localRoot = await mkdtemp(join(tmpdir(), 'customized-extraction-http-'));
    const oldStorage = process.env.STORAGE_DRIVER,
      oldRoot = process.env.LOCAL_STORAGE_ROOT;
    process.env.STORAGE_DRIVER = 'local';
    process.env.LOCAL_STORAGE_ROOT = localRoot;
    const app = await NestFactory.create(AppModule, { logger: false, forceCloseConnections: true });
    const hooks: Array<{ mockRestore(): void }> = [];
    // Suppress test delivery in the transaction, including dispatch by other API processes.
    const target = app.get(CustomizedExtractionRepository) as unknown as {
      enqueue(
        tx: Prisma.TransactionClient,
        task: { id: string; projectId: string },
      ): Promise<{ id: string }>;
    };
    const enqueue = target.enqueue.bind(target);
    hooks.push(
      vi.spyOn(target, 'enqueue').mockImplementation(async (tx, task) => {
        const record = await enqueue(tx, task);
        return tx.jobOutbox.update({
          where: { id: record.id },
          data: { status: 'PUBLISHED', publishedAt: new Date() },
        });
      }),
    );
    for (const module of app.get(ModulesContainer).values())
      for (const provider of module.providers.values()) {
        const instance = provider.instance as
          { constructor?: { name?: string }; onModuleInit?: () => void } | undefined;
        if (
          instance?.onModuleInit &&
          /JobOutboxDispatcher|LeaseRecovery|EffectSegmentImportService|EffectWorkingCleanupProcessor|ProjectDeletionService|CustomizedExtractionService/.test(
            instance.constructor?.name ?? '',
          )
        )
          hooks.push(vi.spyOn(instance, 'onModuleInit').mockImplementation(() => {}));
      }
    const config = app.get(ConfigService),
      db = app.get(PrismaService);
    const cache = app.get(EffectReadCacheService),
      connection = app.get(RedisConnectionService);
    const projectId = randomUUID(),
      token = randomUUID(),
      namespace = `test:customized-extraction:${randomUUID()}`;
    config.set('CUSTOMIZED_EXTRACTION_WORKER_TOKEN', token);
    config.set('EFFECT_READ_CACHE_NAMESPACE', namespace);
    config.set('EFFECT_READ_CACHE_ENABLED', true);
    config.set('EFFECT_READ_CACHE_MIN_LOAD_MS', 0);
    config.set('EFFECT_READ_CACHE_TIMEOUT_MS', 1000);
    try {
      await db.project.create({
        data: { id: projectId, name: 'Disposable customized extraction HTTP fixture' },
      });
      app.setGlobalPrefix('api');
      app.useGlobalPipes(
        new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }),
      );
      app.useGlobalInterceptors(new ResponseEnvelopeInterceptor());
      app.useGlobalFilters(new HttpExceptionFilter());
      await app.listen(0, '127.0.0.1');
      const base = `${await app.getUrl()}/api`,
        project = `/projects/${projectId}`;
      const request = async <T>(
        path: string,
        method = 'GET',
        body?: unknown,
        headers: Record<string, string> = {},
        expectedStatus?: number,
      ): Promise<T> => {
        const response = await fetch(base + path, {
          method,
          signal: AbortSignal.timeout(15000),
          headers: {
            ...(body instanceof FormData || body === undefined
              ? {}
              : { 'Content-Type': 'application/json' }),
            ...headers,
          },
          ...(body === undefined
            ? {}
            : { body: body instanceof FormData ? body : JSON.stringify(body) }),
        });
        const envelope = (await response.json()) as { data: T; message?: string };
        if (expectedStatus) expect(response.status, envelope.message).toBe(expectedStatus);
        else expect(response.status, envelope.message).toBeLessThan(300);
        return envelope.data;
      };
      const { run } = await request<{ run: { id: string } }>(
        `${project}/workflow-runs/customized/draft`,
        'POST',
      );
      const form = new FormData();
      form.set('section', 'BRIEF');
      form.set(
        'file',
        new Blob(['private-fixture-source-body: 梅间青梅酱，清爽梅香。'], { type: 'text/plain' }),
        'brief.txt',
      );
      const asset = await request<{ id: string }>(
        `${project}/workflows/customized/source-import/runs/${run.id}/materials`,
        'POST',
        form,
      );
      const state = await request<{ nodeState: WorkflowNodeState }>(
        `${project}/workflow-runs/${run.id}/nodes/SOURCE_IMPORT/state`,
        'PUT',
        {
          expectedRevision: null,
          state: {
            ...emptyCustomizedImportDraft(),
            materials: [{ assetId: asset.id, assetVersion: 1, category: 'BRIEF' }],
          },
        },
      );
      await request(
        `${project}/workflow-runs/customized/branches/${run.id}/source-version`,
        'POST',
        { expectedRevision: state.nodeState.revision },
      );
      const path = `${project}/workflows/customized/information-extraction`;
      const workspace = () =>
        request<CustomizedExtractionWorkspace>(`${path}?workflowRunId=${run.id}`);
      const initial = await workspace();
      expect(initial.result).toBeNull();
      const start = {
        workflowRunId: run.id,
        sourceArtifactId: initial.source!.artifactId,
        sourceRevision: initial.source!.revision,
        idempotencyKey: randomUUID(),
      };
      const { task } = await request<{ task: CustomizedExtractionTask }>(
        `${path}/tasks`,
        'POST',
        start,
        {},
        202,
      );
      expect(
        (await request<{ task: CustomizedExtractionTask }>(`${path}/tasks`, 'POST', start)).task.id,
      ).toBe(task.id);
      const worker = `/internal/workers/customized-extraction/tasks/${task.id}`;
      await request(`${worker}/claim`, 'POST', { projectId }, {}, 401);
      const claim = await request<{
        attemptToken: string;
        input: { documents: Array<{ assetId: string }> };
      }>(`${worker}/claim`, 'POST', { projectId }, { 'x-worker-token': token });
      expect(claim.input.documents.map((d) => d.assetId)).toEqual([asset.id]);
      const headers = { 'x-worker-token': token, 'x-attempt-token': claim.attemptToken };
      const raw = await fetch(`${base}${worker}/sources/${asset.id}?projectId=${projectId}`, {
        headers,
      });
      expect(raw.status).toBe(200);
      expect(await raw.text()).toContain('private-fixture-source-body');
      await request(
        `${worker}/progress`,
        'PUT',
        { projectId, progress: 22, nodeId: 'DOCUMENT_PARSE' },
        { ...headers, 'x-attempt-token': randomUUID() },
        409,
      );
      const parsed = new FormData();
      parsed.set('projectId', projectId);
      parsed.set('sourceId', asset.id);
      parsed.set(
        'file',
        new Blob(['private-parsed-document-body'], { type: 'text/plain' }),
        'parsed.txt',
      );
      await request(`${worker}/artifacts`, 'POST', parsed, headers);
      const parsedRead = await fetch(`${base}${worker}/parsed/${asset.id}?projectId=${projectId}`, {
        headers,
      });
      expect(await parsedRead.text()).toBe('private-parsed-document-body');
      const candidate: CustomizedBriefCandidate = {
        fields: { ...emptyCustomizedBrief(), productName: '青梅酱', sellingPoints: ['清爽梅香'] },
        issues: [],
        fieldSources: {
          productName: [{ assetId: asset.id, assetVersion: 1, location: '第1段' }],
          sellingPoints: [{ assetId: asset.id, assetVersion: 1, location: '第1段', itemIndex: 0 }],
        },
      };
      for (const node of CUSTOMIZED_EXTRACTION_NODES)
        await request(
          `${worker}/steps`,
          'PUT',
          {
            projectId,
            nodeId: node.id,
            sourceId: '',
            status: 'SUCCEEDED',
            output: node.id === 'NORMALIZATION' ? candidate : {},
          },
          headers,
        );
      await request(
        `${worker}/steps`,
        'PUT',
        {
          projectId,
          nodeId: 'DOCUMENT_EXTRACT',
          sourceId: asset.id,
          status: 'SUCCEEDED',
          output: candidate,
        },
        headers,
      );
      await request(`${worker}/complete`, 'POST', { projectId, candidate }, headers);
      await request(`${worker}/complete`, 'POST', { projectId, candidate }, headers);
      let current = await workspace();
      expect(current.task?.progress).toBe(100);
      expect(current.committed).toBe(false);
      const hits = cache.diagnostics().counts.hit ?? 0;
      expect(await workspace()).toEqual(current);
      expect(cache.diagnostics().counts.hit).toBeGreaterThan(hits);
      const detail = await request<{ fields: Array<{ label: string }> }>(
        `${path}/tasks/${task.id}/nodes/NORMALIZATION`,
      );
      expect(detail.fields.some((f) => f.label === '产品名称')).toBe(true);
      const edited = { ...candidate.fields, brandName: '人工品牌名称' };
      const updated = await request<{ revision: number }>(
        `${path}/results/${current.result!.id}`,
        'PUT',
        { expectedRevision: current.result!.revision, fields: edited, resolvedIssueIds: [] },
      );
      await request(
        `${path}/results/${current.result!.id}`,
        'PUT',
        {
          expectedRevision: current.result!.revision,
          fields: candidate.fields,
          resolvedIssueIds: [],
        },
        {},
        409,
      );
      await request(`${path}/results/${current.result!.id}/confirm`, 'POST', {
        expectedRevision: updated.revision,
      });
      current = await workspace();
      expect(current.committed).toBe(true);
      expect(current.result?.fields.brandName).toBe('人工品牌名称');
      const child = await request<{ workflowRunId: string }>(`${path}/edit`, 'POST', {
        workflowRunId: run.id,
      });
      const childView = await request<CustomizedExtractionWorkspace>(
        `${path}?workflowRunId=${child.workflowRunId}`,
      );
      expect(childView.temporary).toBe(true);
      expect(childView.task?.id).toBe(task.id);
      await request(`${path}/cancel-edit`, 'POST', { workflowRunId: child.workflowRunId });
      const cached = await connection.execute(async (client) => {
        const keys = (await client.eval("return redis.call('KEYS', ARGV[1])", {
          keys: [],
          arguments: [`${namespace}:${projectId}:*`],
        })) as string[];
        return Promise.all(keys.map((key) => client.get(key)));
      });
      expect(cached.join('')).not.toContain('private-fixture-source-body');
      expect(cached.join('')).not.toContain('private-parsed-document-body');
    } finally {
      await connection.execute(async (client) => {
        const keys = (await client.eval("return redis.call('KEYS', ARGV[1])", {
          keys: [],
          arguments: [`${namespace}:${projectId}:*`],
        })) as string[];
        await Promise.all(keys.map((key) => client.del(key)));
      });
      await db.workingArtifactDependency.deleteMany({ where: { projectId } });
      await db.assetOperationReceipt.deleteMany({ where: { projectId } });
      await db.assetVersion.deleteMany({ where: { projectId } });
      await db.asset.deleteMany({ where: { projectId } });
      await db.project.deleteMany({ where: { id: projectId } });
      await app.close();
      hooks.forEach((h) => h.mockRestore());
      if (oldStorage === undefined) delete process.env.STORAGE_DRIVER;
      else process.env.STORAGE_DRIVER = oldStorage;
      if (oldRoot === undefined) delete process.env.LOCAL_STORAGE_ROOT;
      else process.env.LOCAL_STORAGE_ROOT = oldRoot;
      await rm(localRoot, { recursive: true, force: true });
    }
  },
  60000,
);
