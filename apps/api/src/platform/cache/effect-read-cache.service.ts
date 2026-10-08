import { Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomUUID } from 'node:crypto';
import { ApiHttpException } from '../../common/api-http-exception';
import { ProjectService } from '../project/project.service';
import { RedisConnectionService } from './redis-connection.service';
import {
  EffectCacheRevisionService,
  type EffectCacheResource,
  type EffectCacheScope,
} from './effect-cache-revision.service';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const releaseLock =
  "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end";
const publish =
  "if redis.call('GET', KEYS[1]) == ARGV[1] then redis.call('SET', KEYS[2], ARGV[2], 'EX', ARGV[3]); return 1 else return 0 end";
class ChangedDuringRead extends Error {}
type Payload<T> = { kind: 'value'; value: T } | { kind: 'missing'; message: string };
type Outcome =
  | 'hit'
  | 'miss'
  | 'coalesced'
  | 'bypass'
  | 'fast'
  | 'error'
  | 'changed'
  | 'oversize'
  | 'sensitive'
  | 'overloaded';
type Measurement = {
  resource: EffectCacheResource;
  outcome: Outcome;
  totalMs: number;
  versionMs: number;
  redisMs: number;
  loadMs: number;
  codecMs: number;
  waitMs: number;
  bytes: number;
  invalidEntries: number;
};

@Injectable()
export class EffectReadCacheService {
  private readonly logger = new Logger(EffectReadCacheService.name);
  private readonly inFlight = new Map<string, Promise<string>>();
  private readonly samples: Measurement[] = [];
  private readonly counts: Partial<Record<Outcome, number>> = {};
  // Performance hints only: no DTOs or authority state. A bypass always loads PostgreSQL.
  private readonly fastReads = new Map<string, number>();

  constructor(
    @Inject(RedisConnectionService) private readonly redis: RedisConnectionService,
    @Inject(EffectCacheRevisionService) private readonly revisions: EffectCacheRevisionService,
    @Inject(ProjectService) private readonly projects: ProjectService,
    @Inject(ConfigService) private readonly config: ConfigService,
  ) {}

  /** JSON read projections only. Project guards run on cache hits; fast hints call the original loader. */
  async read<T>(
    scope: EffectCacheScope,
    resource: EffectCacheResource,
    loader: () => Promise<T>,
    vary: unknown = null,
  ): Promise<T> {
    return this.readAttempt(scope, resource, loader, vary, 0);
  }

  private async readAttempt<T>(
    scope: EffectCacheScope,
    resource: EffectCacheResource,
    loader: () => Promise<T>,
    vary: unknown,
    attempt: number,
  ): Promise<T> {
    const started = performance.now();
    const metric: Measurement = {
      resource,
      outcome: 'bypass',
      totalMs: 0,
      versionMs: 0,
      redisMs: 0,
      loadMs: 0,
      codecMs: 0,
      waitMs: 0,
      bytes: 0,
      invalidEntries: 0,
    };
    const timed = async <V>(
      field: 'versionMs' | 'redisMs' | 'loadMs',
      operation: () => Promise<V>,
    ): Promise<V> => {
      const start = performance.now();
      try {
        return await operation();
      } finally {
        metric[field] += performance.now() - start;
      }
    };
    let hintKey: string | undefined;
    const minLoadMs = this.config.get<number>('EFFECT_READ_CACHE_MIN_LOAD_MS') ?? 0;
    const load = async () => {
      const value = await timed('loadMs', loader);
      if (hintKey) {
        if (metric.loadMs < minLoadMs) {
          this.fastReads.delete(hintKey);
          if (this.fastReads.size >= 256)
            this.fastReads.delete(this.fastReads.keys().next().value!);
          this.fastReads.set(hintKey, Date.now() + 60_000);
        } else this.fastReads.delete(hintKey);
      }
      return value;
    };
    try {
      if (this.config.get<boolean>('EFFECT_READ_CACHE_ENABLED') === false) return await load();
      // Include the wire schema in the key so old/new API processes cannot misread each other's DTOs.
      const varyHash = hash(JSON.stringify([2, vary]));
      hintKey = `${scope.projectId}:${scope.workflowRunId ?? ''}:${scope.draftId ?? ''}:${resource}:${varyHash}`;
      const fastUntil = this.fastReads.get(hintKey);
      if (fastUntil && fastUntil > Date.now()) {
        metric.outcome = 'fast';
        return await load();
      }
      this.fastReads.delete(hintKey);
      await this.projects.get(scope.projectId);
      const stamp = await timed('versionMs', () => this.revisions.read(scope, resource)).catch(
        () => {
          metric.outcome = 'error';
          return null;
        },
      );
      if (!stamp || stamp.active) return await load();
      const verify = async () => {
        const after = await timed('versionMs', () => this.revisions.read(scope, resource)).catch(
          () => null,
        );
        if (
          !after ||
          after.active ||
          after.workflowRunId !== stamp.workflowRunId ||
          after.version !== stamp.version
        )
          throw new ChangedDuringRead();
      };
      const unwrap = (payload: Payload<T>): T => {
        if (payload.kind === 'missing')
          throw new ApiHttpException(payload.message, 404, 'ASSET_NOT_FOUND');
        return payload.value;
      };
      const namespace =
        this.config.get<string>('EFFECT_READ_CACHE_NAMESPACE') ?? 'amp:effect-read:v1';
      const key = `${namespace}:${scope.projectId}:EFFECT:${stamp.workflowRunId}:${resource}:${varyHash}:${stamp.version}`;
      const maxBytes = this.config.get<number>('EFFECT_READ_CACHE_MAX_BYTES') ?? 2_097_152;
      const decode = (raw: string | null): Payload<T> | undefined => {
        // The envelope JSON escapes the already serialized body; allow its encoding overhead.
        if (!raw) return undefined;
        if (Buffer.byteLength(raw) > maxBytes * 2 + 1024) {
          metric.invalidEntries++;
          return undefined;
        }
        const start = performance.now();
        try {
          const envelope = JSON.parse(raw) as {
            schema?: unknown;
            version?: unknown;
            body?: unknown;
            checksum?: unknown;
          };
          if (
            envelope.schema !== 2 ||
            envelope.version !== stamp.version ||
            typeof envelope.body !== 'string' ||
            hash(envelope.body) !== envelope.checksum
          ) {
            metric.invalidEntries++;
            return undefined;
          }
          metric.bytes = Buffer.byteLength(envelope.body);
          const payload = JSON.parse(envelope.body) as Payload<T>;
          if (
            !payload ||
            (payload.kind !== 'value' && payload.kind !== 'missing') ||
            (payload.kind === 'missing' && typeof payload.message !== 'string')
          ) {
            metric.invalidEntries++;
            return undefined;
          }
          return payload;
        } catch {
          metric.invalidEntries++;
          return undefined;
        } finally {
          metric.codecMs += performance.now() - start;
        }
      };
      let cached: Payload<T> | undefined;
      let redisFailed = false;
      try {
        cached = decode(
          await timed('redisMs', () => this.redis.execute((client) => client.get(key))),
        );
      } catch {
        metric.outcome = 'error';
        redisFailed = true;
      }
      if (cached !== undefined) {
        await verify();
        metric.outcome = 'hit';
        return unwrap(cached);
      }
      if (!redisFailed) metric.outcome = 'miss';
      const pending = this.inFlight.get(key);
      if (pending) {
        metric.outcome = 'coalesced';
        const wait = performance.now();
        const body = await pending;
        metric.waitMs += performance.now() - wait;
        await verify();
        // Each reader owns its result: downstream services mutate DTOs while constructing views.
        return unwrap(JSON.parse(body) as Payload<T>);
      }
      // No unbounded queue: nested read projections fail fast instead of deadlocking a semaphore.
      if (this.inFlight.size >= 128) {
        metric.outcome = 'overloaded';
        throw new ServiceUnavailableException('工作区读取繁忙，请稍后重试');
      }
      const fill = async (): Promise<string> => {
        const token = randomUUID();
        const lockKey = `${key}:fill`;
        let locked = false;
        try {
          if (redisFailed) throw new Error('REDIS_CACHE_UNAVAILABLE');
          locked =
            (await timed('redisMs', () =>
              this.redis.execute((client) => client.set(lockKey, token, { NX: true, PX: 30_000 })),
            )) === 'OK';
          if (!locked) {
            const wait = performance.now();
            // Bound foreground waiting; a crashed/slow filler must never hold page recovery hostage.
            for (let attempt = 0; attempt < 3; attempt++) {
              await new Promise((resolve) => setTimeout(resolve, 25));
              const value = decode(
                await timed('redisMs', () => this.redis.execute((client) => client.get(key))),
              );
              if (value !== undefined) {
                metric.outcome = 'coalesced';
                metric.waitMs += performance.now() - wait;
                return JSON.stringify(value);
              }
            }
            metric.waitMs += performance.now() - wait;
          }
        } catch {
          metric.outcome = 'error';
        }
        try {
          let payload: Payload<T>;
          try {
            payload = { kind: 'value', value: await load() };
          } catch (error) {
            // Only a known missing business resource in an already-authorized, versioned Run.
            // Never cache missing projects, authorization failures or database/transport errors.
            const response = error instanceof ApiHttpException ? error.getResponse() : null;
            if (
              !(error instanceof ApiHttpException) ||
              resource !== 'prompt-result' ||
              error.getStatus() !== 404 ||
              !response ||
              typeof response !== 'object' ||
              !('code' in response) ||
              response.code !== 'ASSET_NOT_FOUND'
            )
              throw error;
            payload = { kind: 'missing', message: error.message };
          }
          await verify();
          const encodeStart = performance.now();
          const body = JSON.stringify(payload);
          metric.bytes = Buffer.byteLength(body);
          metric.codecMs += performance.now() - encodeStart;
          if (metric.loadMs < minLoadMs) {
            metric.outcome = 'fast';
            return body;
          }
          if (!locked) return body;
          // DTOs currently use protected relative media routes. Fail closed if a future
          // provider introduces a signed/external token-bearing URL into a read projection.
          if (
            /[?&](?:x-amz-|x-tos-|x-goog-|signature=|sig=|token=|access_token=|auth_key=)/iu.test(
              body,
            ) ||
            /data:[^,"\s]+;base64,/iu.test(body)
          ) {
            metric.outcome = 'sensitive';
            return body;
          }
          if (metric.bytes > maxBytes) {
            metric.outcome = 'oversize';
            return body;
          }
          const ttl =
            payload.kind === 'missing'
              ? 5
              : (this.config.get<number>('EFFECT_READ_CACHE_TTL_SECONDS') ?? 1800);
          try {
            await timed('redisMs', () =>
              this.redis.execute((client) =>
                client.eval(publish, {
                  keys: [lockKey, key],
                  arguments: [
                    token,
                    JSON.stringify({
                      schema: 2,
                      version: stamp.version,
                      checksum: hash(body),
                      body,
                    }),
                    String(Math.max(1, Math.floor(ttl * (0.9 + Math.random() * 0.2)))),
                  ],
                }),
              ),
            );
            metric.outcome = 'miss';
          } catch {
            metric.outcome = 'error';
          }
          return body;
        } finally {
          if (locked)
            await timed('redisMs', () =>
              this.redis.execute((client) =>
                client.eval(releaseLock, { keys: [lockKey], arguments: [token] }),
              ),
            ).catch(() => undefined);
        }
      };
      const promise = fill();
      this.inFlight.set(key, promise);
      try {
        const body = await promise;
        await verify();
        return unwrap(JSON.parse(body) as Payload<T>);
      } finally {
        if (this.inFlight.get(key) === promise) this.inFlight.delete(key);
      }
    } catch (error) {
      if (!(error instanceof ChangedDuringRead)) throw error;
      metric.outcome = 'changed';
      // Bound retries under continuous writes; the final read is fresh and never cache-backed.
      if (attempt >= 2) return await load();
      return await this.readAttempt(scope, resource, loader, vary, attempt + 1);
    } finally {
      metric.totalMs = performance.now() - started;
      this.counts[metric.outcome] = (this.counts[metric.outcome] ?? 0) + 1;
      this.samples.push(metric);
      if (this.samples.length > 500) this.samples.shift();
      if (this.config.get<boolean>('EFFECT_READ_CACHE_LOG_METRICS'))
        this.logger.log(JSON.stringify({ event: 'effect_read_cache', ...metric }));
    }
  }

  /** Bounded internal diagnostics for benchmarks; no payloads, keys or user content. */
  diagnostics() {
    return { counts: { ...this.counts }, samples: this.samples.map((sample) => ({ ...sample })) };
  }
}
