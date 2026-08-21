import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { JOB_PROGRESS_TTL_SECONDS } from './job.constants';
import type { JobProgress, JobProgressStore } from './job.ports';

type RedisClient = {
  connect(): Promise<void>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options: { EX: number }): Promise<unknown>;
  del(key: string): Promise<unknown>;
  close(): Promise<void>;
  on(event: string, listener: (error: Error) => void): void;
};
type RedisModule = { createClient(options: { url: string }): RedisClient };

const progressKey = (projectId: string, runId: string): string =>
  `job:effect-extraction:${projectId}:${runId}`;

@Injectable()
export class RedisJobProgressStore implements JobProgressStore, OnModuleDestroy {
  private client: RedisClient | null = null;
  private connecting: Promise<RedisClient> | null = null;

  constructor(@Inject(ConfigService) private readonly config: ConfigService) {}

  private async connectedClient(): Promise<RedisClient> {
    if (this.client) return this.client;
    if (!this.connecting) {
      this.connecting = (async () => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const redis = require('redis') as RedisModule;
        const client = redis.createClient({ url: this.config.getOrThrow<string>('REDIS_URL') });
        client.on('error', () => undefined);
        await client.connect();
        this.client = client;
        return client;
      })();
    }
    try {
      return await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  async get(projectId: string, runId: string): Promise<JobProgress | null> {
    const value = await (await this.connectedClient()).get(progressKey(projectId, runId));
    if (!value) return null;
    try {
      return JSON.parse(value) as JobProgress;
    } catch {
      return null;
    }
  }

  async set(progress: JobProgress): Promise<void> {
    await (
      await this.connectedClient()
    ).set(progressKey(progress.projectId, progress.runId), JSON.stringify(progress), {
      EX: JOB_PROGRESS_TTL_SECONDS,
    });
  }

  async delete(projectId: string, runId: string): Promise<void> {
    await (await this.connectedClient()).del(progressKey(projectId, runId));
  }

  async onModuleDestroy(): Promise<void> {
    await this.client?.close().catch(() => undefined);
  }
}
