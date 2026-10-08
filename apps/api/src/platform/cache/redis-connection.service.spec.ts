import { ConfigService } from '@nestjs/config';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RedisConnectionService, type CacheRedisClient } from './redis-connection.service';

function harness() {
  const service = new RedisConnectionService(
    new ConfigService({ EFFECT_READ_CACHE_TIMEOUT_MS: 150 }),
  );
  const client = { isReady: true, isOpen: true, destroy: vi.fn(), get: vi.fn(async () => 'ok') };
  const internals = service as unknown as { client: CacheRedisClient | null; retryAfter: number };
  internals.client = client as unknown as CacheRedisClient;
  return { service, client, internals };
}

afterEach(() => vi.useRealTimers());

describe('bounded shared Redis connection', () => {
  it('reuses one ready connection for concurrent operations and closes it at shutdown', async () => {
    const h = harness();
    expect(
      await Promise.all([
        h.service.execute((c) => c.get('a')),
        h.service.execute((c) => c.get('b')),
      ]),
    ).toEqual(['ok', 'ok']);
    expect(h.client.get).toHaveBeenCalledTimes(2);
    expect(h.client.destroy).not.toHaveBeenCalled();
    h.service.onModuleDestroy();
    expect(h.client.destroy).toHaveBeenCalledTimes(1);
  });

  it('times out an unresponsive command and does not extend backoff on foreground traffic', async () => {
    vi.useFakeTimers();
    const h = harness();
    const pending = h.service.execute(() => new Promise<never>(() => undefined));
    const rejected = expect(pending).rejects.toThrow('REDIS_CACHE_UNAVAILABLE');
    await vi.advanceTimersByTimeAsync(150);
    await rejected;
    expect(h.client.destroy).toHaveBeenCalledTimes(1);
    expect(h.service.failures).toBe(1);
    const retryAt = h.internals.retryAfter;
    await vi.advanceTimersByTimeAsync(1000);
    await expect(h.service.execute((c) => c.get('x'))).rejects.toThrow('REDIS_CACHE_BACKOFF');
    expect(h.internals.retryAfter).toBe(retryAt);
    expect(h.service.failures).toBe(1);
    await vi.advanceTimersByTimeAsync(6000);
    // A subsequent healthy connection may serve requests after the fixed cooldown.
    h.internals.client = h.client as unknown as CacheRedisClient;
    expect(await h.service.execute((c) => c.get('x'))).toBe('ok');
  });

  it('fails fast on disconnect without replaying the operation', async () => {
    const h = harness();
    const operation = vi.fn(async () => {
      throw new Error('socket closed');
    });
    await expect(h.service.execute(operation)).rejects.toThrow('REDIS_CACHE_UNAVAILABLE');
    await expect(h.service.execute(operation)).rejects.toThrow('REDIS_CACHE_BACKOFF');
    expect(operation).toHaveBeenCalledTimes(1);
    expect(h.internals.client).toBeNull();
  });
  it('does not issue an operation after its connection wait timed out', async () => {
    vi.useFakeTimers();
    const h = harness();
    const internal = h.service as unknown as {
      connecting: Promise<CacheRedisClient> | null;
      client: CacheRedisClient | null;
    };
    let connect!: (client: CacheRedisClient) => void;
    internal.client = null;
    internal.connecting = new Promise((resolve) => {
      connect = resolve;
    });
    const operation = vi.fn(async () => 'late');
    const pending = h.service.execute(operation);
    const rejected = expect(pending).rejects.toThrow('REDIS_CACHE_UNAVAILABLE');
    await vi.advanceTimersByTimeAsync(150);
    await rejected;
    connect(h.client as unknown as CacheRedisClient);
    await Promise.resolve();
    await Promise.resolve();
    expect(operation).not.toHaveBeenCalled();
    expect(internal.connecting).toBeNull();
  });

  it('trips once for concurrent failures and does not let old failures close a new generation', async () => {
    vi.useFakeTimers();
    const h = harness();
    let rejectOld!: (error: Error) => void;
    const delayed = h.service.execute(
      () =>
        new Promise<string>((_resolve, reject) => {
          rejectOld = reject;
        }),
    );
    const rejected = expect(delayed).rejects.toThrow('REDIS_CACHE_UNAVAILABLE');
    await expect(
      h.service.execute(async () => {
        throw new Error('socket');
      }),
    ).rejects.toThrow('REDIS_CACHE_UNAVAILABLE');
    const replacement = { ...h.client, destroy: vi.fn() };
    h.internals.client = replacement as unknown as CacheRedisClient;
    rejectOld(new Error('old socket'));
    await rejected;
    expect(replacement.destroy).not.toHaveBeenCalled();
    expect(h.service.failures).toBe(1);
    expect(h.client.destroy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(6000);
    expect(await h.service.execute((c) => c.get('healthy'))).toBe('ok');
  });
});
