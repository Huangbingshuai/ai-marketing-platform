import { ApiHttpException } from '../../common/api-http-exception';
import { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';
import type { ProjectService } from '../project/project.service';
import { EffectReadCacheService } from './effect-read-cache.service';
import type { RedisConnectionService, CacheRedisClient } from './redis-connection.service';
import {
  EFFECT_CACHE_TABLES,
  type EffectCacheRevisionService,
} from './effect-cache-revision.service';

const scope = { projectId: 'project-a', workflowRunId: 'run-a' };
function harness(overrides = {}) {
  const entries = new Map<string, string>();
  const client = {
    get: vi.fn(async (key: string) => entries.get(key) ?? null),
    set: vi.fn(async (key: string, value: string, options: { NX?: boolean }) => {
      if (options.NX && entries.has(key)) return null;
      entries.set(key, value);
      return 'OK';
    }),
    eval: vi.fn(
      async (
        _script: string,
        { keys, arguments: args }: { keys: string[]; arguments: string[] },
      ) => {
        if (entries.get(keys[0]!) !== args[0]) return 0;
        if (keys.length === 2) entries.set(keys[1]!, args[1]!);
        else entries.delete(keys[0]!);
        return 1;
      },
    ),
  };
  const redis = {
    execute: vi.fn(async (fn: (client: CacheRedisClient) => unknown) =>
      fn(client as unknown as CacheRedisClient),
    ),
  };
  const revisions = {
    read: vi.fn(async (s: typeof scope) => ({
      workflowRunId: s.workflowRunId,
      version: 'v1',
      active: false,
    })),
  };
  const projects = { get: vi.fn(async () => ({})) };
  const service = new EffectReadCacheService(
    redis as unknown as RedisConnectionService,
    revisions as unknown as EffectCacheRevisionService,
    projects as unknown as ProjectService,
    new ConfigService({ EFFECT_READ_CACHE_MIN_LOAD_MS: 0, ...overrides }),
  );
  return { entries, client, redis, revisions, projects, service };
}

describe('version-verified Effect read cache', () => {
  it('bypasses Redis for fast reads, then learns when the same scope becomes expensive', async () => {
    const h = harness({ EFFECT_READ_CACHE_MIN_LOAD_MS: 20 });
    let expensive = false;
    const load = vi.fn(async () => {
      if (expensive) await new Promise((resolve) => setTimeout(resolve, 35));
      return { current: expensive ? 'large' : 'small' };
    });
    await h.service.read(scope, 'mix', load);
    const redisCalls = h.redis.execute.mock.calls.length;
    expect(h.entries.size).toBe(0);
    expect(await h.service.read(scope, 'mix', load)).toEqual({ current: 'small' });
    expect(h.redis.execute).toHaveBeenCalledTimes(redisCalls);
    expensive = true;
    expect(await h.service.read(scope, 'mix', load)).toEqual({ current: 'large' });
    expect(h.redis.execute).toHaveBeenCalledTimes(redisCalls);
    // An expensive bypass removes the hint; the next request fills the shared cache.
    await h.service.read(scope, 'mix', load);
    await h.service.read(scope, 'mix', load);
    expect(load).toHaveBeenCalledTimes(4);
    expect(h.service.diagnostics().counts.hit).toBe(1);
  });
  it('bounds waiting for another process and never releases a lock owned by it', async () => {
    const h = harness();
    h.client.set.mockResolvedValue(null);
    const load = vi.fn(async () => ({ source: 'database' }));
    expect(await h.service.read(scope, 'mix', load)).toEqual({ source: 'database' });
    expect(load).toHaveBeenCalledTimes(1);
    expect(h.client.get).toHaveBeenCalledTimes(4);
    expect(h.client.eval).not.toHaveBeenCalled();
    expect(h.entries.size).toBe(0);
  });

  it('validates a filled response from another process while waiting', async () => {
    const h = harness();
    await h.service.read(scope, 'mix', async () => ({ source: 'other-process' }));
    const raw = [...h.entries.values()][0]!;
    h.entries.clear();
    h.client.get.mockResolvedValueOnce(null).mockResolvedValueOnce(raw);
    h.client.set.mockResolvedValue(null);
    const load = vi.fn(async () => ({ source: 'database' }));
    expect(await h.service.read(scope, 'mix', load)).toEqual({ source: 'other-process' });
    expect(load).not.toHaveBeenCalled();
    expect(h.service.diagnostics().counts.coalesced).toBe(1);
  });
  it.each(Object.keys(EFFECT_CACHE_TABLES) as Array<keyof typeof EFFECT_CACHE_TABLES>)(
    '%s hits only after fresh authorization and version checks; callers own their objects',
    async (resource) => {
      const h = harness();
      const load = vi.fn(async () => ({ items: [{ revision: 1 }] }));
      const first = await h.service.read(scope, resource, load);
      first.items[0]!.revision = 99;
      expect(await h.service.read(scope, resource, load)).toEqual({ items: [{ revision: 1 }] });
      expect(load).toHaveBeenCalledTimes(1);
      expect(h.projects.get).toHaveBeenCalledTimes(2);
      expect(h.revisions.read).toHaveBeenCalledTimes(5);
      h.projects.get.mockRejectedValueOnce(new Error('denied'));
      await expect(h.service.read(scope, resource, load)).rejects.toThrow('denied');
    },
  );

  it('isolates projects, Runs, products, templates, pages and filters', async () => {
    const h = harness();
    const load = vi.fn(async () => ({ loaded: load.mock.calls.length }));
    await h.service.read(scope, 'mix', load, { template: 'a', page: 1 });
    await h.service.read({ ...scope, projectId: 'b' }, 'mix', load, { template: 'a', page: 1 });
    await h.service.read({ ...scope, workflowRunId: 'b' }, 'mix', load, { template: 'a', page: 1 });
    await h.service.read(scope, 'mix', load, { template: 'b', page: 1 });
    await h.service.read(scope, 'prompt-result', load, { product: 'a', page: 1, query: '' });
    await h.service.read(scope, 'prompt-result', load, { product: 'a', page: 2, query: '' });
    await h.service.read(scope, 'prompt-result', load, { product: 'b', page: 1, query: 'x' });
    expect(load).toHaveBeenCalledTimes(7);
  });

  it('does not restore old content after two committed version changes or TTL expiry', async () => {
    const h = harness();
    let version = 1;
    h.revisions.read.mockImplementation(async () => ({
      workflowRunId: 'run-a',
      version: `v${version}`,
      active: false,
    }));
    const load = vi.fn(async () => ({ version }));
    for (version = 1; version <= 3; version++) {
      expect(await h.service.read(scope, 'mix', load)).toEqual({ version });
      expect(await h.service.read(scope, 'mix', load)).toEqual({ version });
    }
    h.entries.clear();
    await h.service.read(scope, 'mix', load);
    expect(load).toHaveBeenCalledTimes(4);
    expect(
      h.client.eval.mock.calls.some(([, options]) => Number(options.arguments[2]) >= 1620),
    ).toBe(true);
  });

  it('rejects corrupted entries and falls back immediately when Redis fails', async () => {
    const h = harness();
    const load = vi.fn(async () => ({ current: true }));
    await h.service.read(scope, 'mix', load);
    for (const key of h.entries.keys())
      h.entries.set(key, '{"version":"v1","body":"{}","checksum":"bad"}');
    expect(await h.service.read(scope, 'mix', load)).toEqual({ current: true });
    expect(h.service.diagnostics().samples.some((sample) => sample.invalidEntries > 0)).toBe(true);
    h.redis.execute.mockRejectedValueOnce(new Error('redis offline'));
    expect(await h.service.read(scope, 'mix', load)).toEqual({ current: true });
    expect(load).toHaveBeenCalledTimes(3);
  });

  it('bypasses active tasks, unknown versions and disabled caches', async () => {
    const h = harness();
    const load = vi.fn(async () => 'live');
    h.revisions.read.mockResolvedValueOnce({ workflowRunId: 'run-a', version: 'v1', active: true });
    await h.service.read(scope, 'output', load);
    h.revisions.read.mockRejectedValueOnce(new Error('cannot verify'));
    await h.service.read(scope, 'output', load);
    expect(h.redis.execute).not.toHaveBeenCalled();
    const disabled = harness({ EFFECT_READ_CACHE_ENABLED: false });
    await disabled.service.read(scope, 'output', load);
    expect(disabled.revisions.read).not.toHaveBeenCalled();
  });

  it('never stores a read that races a newer save; concurrent readers get separate DTOs', async () => {
    const h = harness();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const load = vi
      .fn(async () => ({ items: ['new'] }))
      .mockImplementationOnce(async () => {
        await gate;
        return { items: ['old'] };
      });
    const first = h.service.read(scope, 'mix', load);
    const second = h.service.read(scope, 'mix', load);
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    h.revisions.read.mockResolvedValue({ workflowRunId: 'run-a', version: 'v2', active: false });
    release();
    const [one, two] = await Promise.all([first, second]);
    one.items.push('mutated');
    expect(two.items).toEqual(['new']);
    expect([...h.entries.keys()].every((key) => key.endsWith(':v2'))).toBe(true);
    expect(load).toHaveBeenCalledTimes(2);
    expect(await h.service.read(scope, 'mix', async () => ({ items: ['new'] }))).toEqual({
      items: ['new'],
    });
  });

  it('propagates database failures and allows recovery without a stuck single-flight', async () => {
    const h = harness();
    await expect(
      h.service.read(scope, 'mix', async () => {
        throw new Error('db down');
      }),
    ).rejects.toThrow('db down');
    expect(await h.service.read(scope, 'mix', async () => 'recovered')).toBe('recovered');
  });

  it('does not store oversized responses or signed URLs', async () => {
    for (const body of [
      { text: 'x'.repeat(101) },
      { url: 'https://storage.example/a?X-Tos-Signature=private' },
      { url: 'https://storage.example/a?X-Goog-Signature=private' },
      { url: '/api/media/a?signature=private' },
      { url: 'data:image/png;base64,aGVsbG8=' },
    ]) {
      const h = harness({ EFFECT_READ_CACHE_MAX_BYTES: 100 });
      await h.service.read(scope, 'mix', async () => body);
      expect(h.entries.size).toBe(0);
    }
  });

  it('round-trips JSON with significant escaping within the payload limit', async () => {
    const h = harness({ EFFECT_READ_CACHE_MAX_BYTES: 4096 });
    const body = { text: '\\'.repeat(1500) };
    const load = vi.fn(async () => body);
    await h.service.read(scope, 'mix', load);
    expect(await h.service.read(scope, 'mix', load)).toEqual(body);
    expect(load).toHaveBeenCalledTimes(1);
  });
  it('discards a hit when a save or Run switch commits during Redis GET', async () => {
    for (const changeRun of [false, true]) {
      const h = harness();
      await h.service.read(scope, 'mix', async () => ({ revision: 1 }));
      h.client.get.mockImplementationOnce(async (key) => {
        const old = h.entries.get(key) ?? null;
        h.revisions.read.mockResolvedValue({
          workflowRunId: changeRun ? 'run-b' : 'run-a',
          version: 'v2',
          active: false,
        });
        return old;
      });
      expect(await h.service.read(scope, 'mix', async () => ({ revision: 2 }))).toEqual({
        revision: 2,
      });
      expect(h.service.diagnostics().counts.changed).toBeGreaterThan(0);
    }
  });

  it('coalesces concurrent database fallback even when Redis is down', async () => {
    const h = harness();
    h.redis.execute.mockRejectedValue(new Error('offline'));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const load = vi.fn(async () => {
      await gate;
      return { items: [] };
    });
    const reads = Array.from({ length: 40 }, () => h.service.read(scope, 'mix', load));
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    release();
    const results = await Promise.all(reads);
    expect(load).toHaveBeenCalledTimes(1);
    expect(new Set(results).size).toBe(40);
    expect(h.entries.size).toBe(0);
  });

  it('stops using a cached workspace when a task starts during the read', async () => {
    const h = harness();
    await h.service.read(scope, 'output', async () => ({ status: 'COMPLETED' }));
    h.client.get.mockImplementationOnce(async (key) => {
      const raw = h.entries.get(key) ?? null;
      h.revisions.read.mockResolvedValue({ workflowRunId: 'run-a', version: 'v2', active: true });
      return raw;
    });
    const live = vi.fn(async () => ({ status: 'RUNNING', progress: 1 }));
    expect(await h.service.read(scope, 'output', live)).toEqual({ status: 'RUNNING', progress: 1 });
    live.mockResolvedValue({ status: 'RUNNING', progress: 2 });
    expect(await h.service.read(scope, 'output', live)).toEqual({ status: 'RUNNING', progress: 2 });
    expect(live).toHaveBeenCalledTimes(2);
    expect([...h.entries.keys()].some((key) => key.endsWith(':v2'))).toBe(false);
  });

  it('does not publish or delete a newer filler lease after its own lease expires', async () => {
    const h = harness();
    await h.service.read(scope, 'mix', async () => {
      const key = [...h.entries.keys()].find((key) => key.endsWith(':fill'))!;
      h.entries.set(key, 'replacement-token');
      return { revision: 1 };
    });
    expect([...h.entries.values()]).toEqual(['replacement-token']);
  });

  it('caches a missing resource briefly but invalidates immediately when it is created', async () => {
    const h = harness();
    const missing = vi.fn(async () => {
      throw new ApiHttpException('结果不存在', 404, 'ASSET_NOT_FOUND');
    });
    for (let i = 0; i < 2; i++)
      await expect(h.service.read(scope, 'prompt-result', missing, 'result-a')).rejects.toThrow(
        '结果不存在',
      );
    expect(missing).toHaveBeenCalledTimes(1);
    const publication = h.client.eval.mock.calls.find(([, options]) => options.keys.length === 2)!;
    expect(Number(publication[1].arguments[2])).toBeLessThanOrEqual(5);
    h.revisions.read.mockResolvedValue({ workflowRunId: 'run-a', version: 'v2', active: false });
    expect(
      await h.service.read(scope, 'prompt-result', async () => ({ created: true }), 'result-a'),
    ).toEqual({ created: true });
    h.projects.get.mockRejectedValueOnce(
      new ApiHttpException('项目不存在', 404, 'PROJECT_NOT_FOUND'),
    );
    await expect(h.service.read(scope, 'prompt-result', missing)).rejects.toThrow('项目不存在');
  });

  it('does not cache transient failures or authorization failures', async () => {
    for (const error of [
      new ApiHttpException('无权限', 403, 'VALIDATION_ERROR'),
      new Error('database down'),
    ]) {
      const h = harness();
      const load = vi.fn(async () => {
        throw error;
      });
      for (let i = 0; i < 2; i++)
        await expect(h.service.read(scope, 'mix', load)).rejects.toThrow(error.message);
      expect(load).toHaveBeenCalledTimes(2);
      expect(h.entries.size).toBe(0);
    }
  });

  it('bounds different-key fills without a queue and recovers after overload', async () => {
    const h = harness();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const load = vi.fn(async () => {
      await gate;
      return 'ok';
    });
    const reads = Array.from({ length: 128 }, (_, i) => h.service.read(scope, 'mix', load, i));
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(128));
    await expect(h.service.read(scope, 'mix', load, 'overflow')).rejects.toThrow('工作区读取繁忙');
    release();
    await Promise.all(reads);
    expect(await h.service.read(scope, 'mix', async () => 'recovered', 'overflow')).toBe(
      'recovered',
    );
  });

  it('bounds retries under continuous saves and then reads directly without old cache data', async () => {
    const h = harness();
    let revision = 0;
    h.revisions.read.mockImplementation(async () => ({
      workflowRunId: 'run-a',
      version: String(++revision),
      active: false,
    }));
    const load = vi.fn(async () => ({ revision }));
    const value = await h.service.read(scope, 'mix', load);
    expect(value.revision).toBe(revision);
    expect(load).toHaveBeenCalledTimes(4);
    expect(h.entries.size).toBe(0);
  });

  it('spreads entry TTLs instead of expiring a whole warmed set together', async () => {
    const h = harness();
    const random = vi.spyOn(Math, 'random');
    try {
      random.mockReturnValueOnce(0).mockReturnValueOnce(0.99);
      await h.service.read(scope, 'mix', async () => ({}), 'a');
      await h.service.read(scope, 'mix', async () => ({}), 'b');
      const ttls = h.client.eval.mock.calls
        .filter(([, options]) => options.keys.length === 2)
        .map(([, options]) => Number(options.arguments[2]));
      expect(ttls).toEqual([1620, 1976]);
    } finally {
      random.mockRestore();
    }
  });
});
