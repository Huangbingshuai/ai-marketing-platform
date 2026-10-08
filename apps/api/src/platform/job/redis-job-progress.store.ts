import { Inject, Injectable } from '@nestjs/common';
import { RedisConnectionService } from '../cache/redis-connection.service';
import { JOB_PROGRESS_TTL_SECONDS } from './job.constants';
import type { JobProgress, JobProgressStore } from './job.ports';

const progressKey = (projectId: string, runId: string): string =>
  `job:effect-extraction:${projectId}:${runId}`;

@Injectable()
export class RedisJobProgressStore implements JobProgressStore {
  constructor(@Inject(RedisConnectionService) private readonly redis: RedisConnectionService) {}

  async get(projectId: string, runId: string): Promise<JobProgress | null> {
    const value = await this.redis.execute((client) => client.get(progressKey(projectId, runId)));
    if (!value) return null;
    try {
      return JSON.parse(value) as JobProgress;
    } catch {
      return null;
    }
  }

  async set(progress: JobProgress): Promise<void> {
    await this.redis.execute((client) =>
      client.set(progressKey(progress.projectId, progress.runId), JSON.stringify(progress), {
        EX: JOB_PROGRESS_TTL_SECONDS,
      }),
    );
  }

  async delete(projectId: string, runId: string): Promise<void> {
    await this.redis.execute((client) => client.del(progressKey(projectId, runId)));
  }
}
