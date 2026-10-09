import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import type { DeleteProjectRequest, DeleteProjectResult } from '@ai-marketing/contracts';
import { ApiHttpException } from '../../common/api-http-exception';
import { STORAGE_PORT } from '../file/storage.port';
import type { StoragePort } from '../file/storage.port';
import { ProjectDeletionRepository } from './project-deletion.repository';
import { ProjectDeletionCacheService } from './project-deletion-cache.service';

@Injectable()
export class ProjectDeletionService implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private draining = false;
  private started = false;
  private kick: ReturnType<typeof setTimeout> | undefined;
  private readonly logger = new Logger(ProjectDeletionService.name);

  constructor(
    @Inject(ProjectDeletionRepository) private readonly repository: ProjectDeletionRepository,
    @Inject(STORAGE_PORT) private readonly storage: StoragePort,
    @Inject(ProjectDeletionCacheService) private readonly cache: ProjectDeletionCacheService,
  ) {}

  onModuleInit(): void {
    this.started = true;
    this.timer = setInterval(() => void this.drain(), 5_000);
    this.timer.unref();
    void this.drain();
  }

  onModuleDestroy(): void {
    this.started = false;
    if (this.timer) clearInterval(this.timer);
    if (this.kick) clearTimeout(this.kick);
  }

  async remove(
    projectId: string,
    context: DeleteProjectRequest = {},
  ): Promise<DeleteProjectResult> {
    if (context.currentProjectId === projectId) {
      throw new ApiHttpException(
        '当前项目不可删除，请先退出项目。',
        409,
        'PROJECT_CURRENT_DELETE_FORBIDDEN',
      );
    }
    const result = await this.repository.enqueue(projectId);
    // The request only persists the job. No bulk deletion or external IO runs on its promise.
    if (this.started && !this.kick)
      this.kick = setTimeout(() => {
        this.kick = undefined;
        void this.drain();
      }, 0);
    return result;
  }

  async cleanup(projectId: string): Promise<void> {
    const token = randomUUID();
    const job = await this.repository.claim(projectId, token);
    if (!job) return;
    try {
      if (job.phase === 'DATABASE') {
        if (await this.repository.remove(projectId, token)) await this.cleanup(projectId);
        return;
      }
      await this.cleanupFiles(projectId, token, job.keys);
    } catch (error) {
      const busy = error instanceof ApiHttpException && error.getStatus() === 409;
      await this.repository.fail(
        projectId,
        token,
        busy
          ? '项目仍有生成或上传任务，请等待任务结束后重试删除。'
          : '项目删除暂时失败，请重试删除。',
        busy,
      );
    }
  }

  status(projectId: string): Promise<DeleteProjectResult> {
    return this.repository.status(projectId);
  }

  private async cleanupFiles(projectId: string, token: string, keys: string[]): Promise<void> {
    // Bound each lease's work; large projects continue through the durable background queue.
    const batch = keys.slice(0, 40);
    const remaining = keys.slice(40);
    let fileFailed = false;
    for (let start = 0; start < batch.length; start += 4) {
      const group = batch.slice(start, start + 4);
      const results = await Promise.allSettled(group.map((key) => this.storage.delete(key)));
      results.forEach((result, index) => {
        if (result.status === 'rejected') {
          fileFailed = true;
          remaining.push(group[index]!);
        }
      });
    }
    let cacheCleared = false;
    try {
      await this.cache.clear(projectId);
      cacheCleared = true;
    } catch {
      this.logger.warn(`项目 ${projectId} 缓存清理将在后台重试`);
    }
    await this.repository.finish(
      projectId,
      token,
      remaining,
      cacheCleared,
      fileFailed || !cacheCleared,
    );
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      for (const projectId of await this.repository.pending()) await this.cleanup(projectId);
    } catch {
      this.logger.warn('项目文件清理暂不可用，将自动重试');
    } finally {
      this.draining = false;
    }
  }
}
