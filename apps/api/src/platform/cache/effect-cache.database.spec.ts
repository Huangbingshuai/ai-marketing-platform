import { createHash, randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { expect, it, vi } from 'vitest';
import { PrismaService } from '../../database/prisma.service';
import { ProjectRepository } from '../project/project.repository';
import { ProjectService } from '../project/project.service';
import { RedisConnectionService } from './redis-connection.service';
import { EffectCacheRevisionService, EFFECT_CACHE_TABLES } from './effect-cache-revision.service';
import { EffectReadCacheService } from './effect-read-cache.service';

it.skipIf(process.env.EFFECT_CACHE_DATABASE_TEST !== '1')(
  'validates every dependency query against PostgreSQL and invalidates real Redis after committed saves/deletes',
  async () => {
    const namespace = `test:effect-read:${randomUUID()}`;
    const config = new ConfigService({
      DATABASE_URL:
        process.env.DATABASE_URL ??
        'postgresql://postgres:postgres@localhost:5432/ai_marketing?schema=public',
      REDIS_URL: process.env.REDIS_URL ?? 'redis://localhost:6379',
      EFFECT_READ_CACHE_NAMESPACE: namespace,
      EFFECT_READ_CACHE_TIMEOUT_MS: 1000,
      EFFECT_READ_CACHE_TTL_SECONDS: 1,
      EFFECT_READ_CACHE_MIN_LOAD_MS: 0,
    });
    const db = new PrismaService(config);
    const redis = new RedisConnectionService(config);
    const versions = new EffectCacheRevisionService(db);
    const cache = new EffectReadCacheService(
      redis,
      versions,
      new ProjectService(new ProjectRepository(db)),
      config,
    );
    const projectId = randomUUID();
    const runId = randomUUID();
    try {
      await db.project.create({
        data: { id: projectId, name: 'Redis isolated integration fixture' },
      });
      await db.workflowRun.create({
        data: { id: runId, projectId, workflow: 'EFFECT', workflowSpace: 'EFFECT' },
      });
      const scope = { projectId, workflowRunId: runId };
      const initialVersions = new Map<string, string>();
      for (const resource of Object.keys(EFFECT_CACHE_TABLES) as Array<
        keyof typeof EFFECT_CACHE_TABLES
      >) {
        const stamp = await versions.read(scope, resource);
        expect(stamp?.version).toHaveLength(64);
        expect(stamp?.active).toBe(false);
        initialVersions.set(resource, stamp!.version);
      }
      let calls = 0;
      const load = async () => {
        calls++;
        return db.workflowNodeState.findMany({
          where: {
            projectId,
            workflowRunId: runId,
          },
          select: { nodeId: true, revision: true, state: true },
        });
      };
      await cache.read(scope, 'mix', load);
      await cache.read(scope, 'mix', load);
      expect(calls).toBe(1);
      await db.workflowRun.update({
        where: { id: runId },
        data: {
          currentNodeId: 'TEMPLATE_MIX',
          lastActiveAt: new Date(),
        },
      });
      expect((await versions.read(scope, 'mix'))?.version).toBe(initialVersions.get('mix'));
      expect((await versions.read(scope, 'tree'))?.version).not.toBe(initialVersions.get('tree'));
      await cache.read(scope, 'mix', load);
      expect(calls).toBe(1);
      const state = await db.workflowNodeState.create({
        data: {
          projectId,
          workflowRunId: runId,
          nodeId: 'TEMPLATE_MIX',
          state: { templates: [] },
          contentHash: 'a'.repeat(64),
        },
      });
      await cache.read(scope, 'mix', load);
      expect(calls).toBe(2);
      for (const resource of Object.keys(EFFECT_CACHE_TABLES) as Array<
        keyof typeof EFFECT_CACHE_TABLES
      >) {
        expect((await versions.read(scope, resource))?.version).not.toBe(
          initialVersions.get(resource),
        );
      }
      await db.workflowNodeState.update({
        where: { id: state.id },
        data: { revision: { increment: 1 }, state: { templates: ['a'] } },
      });
      await cache.read(scope, 'mix', load);
      expect(calls).toBe(3);
      // Even a legacy writer that forgot a logical revision changes the physical row stamp.
      await db.workflowNodeState.update({
        where: { id: state.id },
        data: { state: { templates: ['b'] } },
      });
      await cache.read(scope, 'mix', load);
      expect(calls).toBe(4);
      await db.workflowNodeState.delete({ where: { id: state.id } });
      expect(await cache.read(scope, 'mix', load)).toEqual([]);
      // Returning to the exact original dependency set may reuse its still-valid empty view.
      expect(calls).toBe(4);
      expect(await versions.read({ projectId, workflowRunId: randomUUID() }, 'mix')).toBeNull();
      expect(cache.diagnostics().counts.hit).toBe(3);
      await new Promise((resolve) => setTimeout(resolve, 1100));
      await cache.read(scope, 'mix', load);
      expect(calls).toBe(5);
      const customizedRun = await db.workflowRun.create({
        data: {
          projectId,
          workflow: 'CUSTOMIZED',
          workflowSpace: 'CUSTOMIZED_PROJECT',
        },
      });
      expect(await versions.read({ projectId, workflowRunId: customizedRun.id }, 'mix')).toBeNull();
      expect(
        await versions.read({ projectId: randomUUID(), workflowRunId: runId }, 'mix'),
      ).toBeNull();
      // A save committed while a cold loader is suspended must not publish/return its old DTO.
      const racingState = await db.workflowNodeState.create({
        data: {
          projectId,
          workflowRunId: runId,
          nodeId: 'TEMPLATE_MIX',
          state: { value: 1 },
          contentHash: 'b'.repeat(64),
        },
      });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const racingLoad = vi.fn(async () => {
        const value = await db.workflowNodeState.findUniqueOrThrow({
          where: { id: racingState.id },
          select: { state: true },
        });
        if (racingLoad.mock.calls.length === 1) await gate;
        return value;
      });
      const racingRead = cache.read(scope, 'mix', racingLoad, 'save-race');
      await vi.waitFor(() => expect(racingLoad).toHaveBeenCalledTimes(1));
      await db.workflowNodeState.update({
        where: { id: racingState.id },
        data: { state: { value: 2 }, revision: { increment: 1 } },
      });
      release();
      expect(await racingRead).toEqual({ state: { value: 2 } });
      expect(racingLoad).toHaveBeenCalledTimes(2);
      // Real Lua must reject a lease replaced while the loader was executing.
      const stamp = (await versions.read(scope, 'mix'))!;
      const varyHash = createHash('sha256')
        .update(JSON.stringify([3, 'lease-race']))
        .digest('hex');
      const leaseKey = `${namespace}:${projectId}:EFFECT:${runId}:mix:${varyHash}:${stamp.version}`;
      expect(
        await cache.read(
          scope,
          'mix',
          async () => {
            await redis.execute((client) =>
              client.set(`${leaseKey}:fill`, 'new-owner', { PX: 1000 }),
            );
            return { value: 'valid database result' };
          },
          'lease-race',
        ),
      ).toEqual({ value: 'valid database result' });
      expect(await redis.execute((client) => client.get(leaseKey))).toBeNull();
      expect(await redis.execute((client) => client.get(`${leaseKey}:fill`))).toBe('new-owner');
      // A real hit fetched before a commit is rechecked before returning to its caller.
      await cache.read(scope, 'mix', racingLoad, 'hit-race');
      const execute = redis.execute.bind(redis);
      let injectedSave = false;
      const intercepted = vi.spyOn(redis, 'execute').mockImplementation(async (operation) => {
        const result = await execute(operation);
        if (!injectedSave && typeof result === 'string' && result.includes('"schema":2')) {
          injectedSave = true;
          await db.workflowNodeState.update({
            where: { id: racingState.id },
            data: { state: { value: 3 }, revision: { increment: 1 } },
          });
        }
        return result;
      });
      try {
        expect(await cache.read(scope, 'mix', racingLoad, 'hit-race')).toEqual({
          state: { value: 3 },
        });
        expect(injectedSave).toBe(true);
      } finally {
        intercepted.mockRestore();
      }
      await db.workflowNodeState.delete({ where: { id: racingState.id } });
      const unavailable = new RedisConnectionService(
        new ConfigService({
          REDIS_URL: 'redis://127.0.0.1:1',
          EFFECT_READ_CACHE_TIMEOUT_MS: 100,
        }),
      );
      try {
        const fallback = new EffectReadCacheService(
          unavailable,
          versions,
          new ProjectService(new ProjectRepository(db)),
          config,
        );
        expect(await fallback.read(scope, 'mix', load)).toEqual([]);
        expect(fallback.diagnostics().counts.error).toBe(1);
        let releaseFallback!: () => void;
        const fallbackGate = new Promise<void>((resolve) => {
          releaseFallback = resolve;
        });
        const coalescedLoad = vi.fn(async () => {
          await fallbackGate;
          return load();
        });
        const readers = Array.from({ length: 20 }, () =>
          fallback.read(scope, 'mix', coalescedLoad, 'outage-race'),
        );
        await vi.waitFor(() => expect(coalescedLoad).toHaveBeenCalledTimes(1));
        // Give the real DB scope checks time to complete while the single loader is held.
        await new Promise((resolve) => setTimeout(resolve, 80));
        releaseFallback();
        expect(await Promise.all(readers)).toEqual(Array.from({ length: 20 }, () => []));
        expect(coalescedLoad).toHaveBeenCalledTimes(1);
      } finally {
        unavailable.onModuleDestroy();
      }
    } finally {
      // Only the randomly-owned fixture is removed. Redis test keys expire in one second.
      await db.project.deleteMany({ where: { id: projectId } });
      redis.onModuleDestroy();
      await db.$disconnect();
    }
  },
  30_000,
);
