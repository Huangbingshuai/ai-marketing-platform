import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export type CacheRedisClient = {
  isReady: boolean;
  isOpen: boolean;
  connect(): Promise<unknown>;
  destroy(): void;
  on(event: string, listener: () => void): void;
  get(key: string): Promise<string | null>;
  set(
    key: string,
    value: string,
    options: { EX?: number; PX?: number; NX?: boolean },
  ): Promise<string | null>;
  del(key: string): Promise<number>;
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
};

/** One bounded, fail-fast connection for disposable cache data and job progress. */
@Injectable()
export class RedisConnectionService implements OnModuleDestroy {
  private client: CacheRedisClient | null = null;
  private connecting: Promise<CacheRedisClient> | null = null;
  private retryAfter = 0;
  private generation = 0;
  failures = 0;

  constructor(@Inject(ConfigService) private readonly config: ConfigService) {}

  async execute<T>(operation: (client: CacheRedisClient) => Promise<T>): Promise<T> {
    if (Date.now() < this.retryAfter) throw new Error('REDIS_CACHE_BACKOFF');
    const timeoutMs = this.config.get<number>('EFFECT_READ_CACHE_TIMEOUT_MS') ?? 150;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const generation = this.generation;
    let expired = false;
    try {
      return await Promise.race([
        this.connected().then((client) => {
          if (expired || generation !== this.generation) throw new Error('REDIS_CACHE_EXPIRED');
          return operation(client);
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            expired = true;
            reject(new Error('REDIS_CACHE_TIMEOUT'));
          }, timeoutMs);
        }),
      ]);
    } catch {
      if (generation === this.generation) {
        this.failures++;
        this.retryAfter = Date.now() + Math.floor(4_000 + Math.random() * 2_000);
        // One failure closes this generation; late failures cannot destroy a replacement.
        this.generation++;
        if (this.client?.isOpen) this.client.destroy();
        this.client = null;
        this.connecting = null;
      }
      throw new Error('REDIS_CACHE_UNAVAILABLE');
    } finally {
      clearTimeout(timer);
    }
  }

  private async connected(): Promise<CacheRedisClient> {
    if (Date.now() < this.retryAfter) throw new Error('REDIS_CACHE_BACKOFF');
    if (this.client?.isReady) return this.client;
    if (!this.connecting) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const redis = require('redis') as { createClient(options: unknown): CacheRedisClient };
      const client = redis.createClient({
        url: this.config.getOrThrow<string>('REDIS_URL'),
        disableOfflineQueue: true,
        socket: {
          connectTimeout: this.config.get<number>('EFFECT_READ_CACHE_TIMEOUT_MS') ?? 150,
          reconnectStrategy: false,
        },
      });
      client.on('error', () => undefined);
      this.client = client;
      const generation = this.generation;
      const connecting = client
        .connect()
        .then(() => {
          if (generation !== this.generation) {
            if (client.isOpen) client.destroy();
            throw new Error('REDIS_CACHE_EXPIRED');
          }
          return client;
        })
        .finally(() => {
          if (this.connecting === connecting) this.connecting = null;
        });
      this.connecting = connecting;
    }
    return this.connecting;
  }

  onModuleDestroy(): void {
    this.generation++;
    if (this.client?.isOpen) this.client.destroy();
    this.client = null;
    this.connecting = null;
  }
}
