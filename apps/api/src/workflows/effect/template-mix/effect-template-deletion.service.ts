import { Inject, Injectable, type OnModuleInit, type OnModuleDestroy } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { STORAGE_PORT, type StoragePort } from '../../../platform/file/storage.port';
import { EffectTemplateDeletionRepository } from './effect-template-deletion.repository';
import { EffectTemplateDeletionCache } from './effect-template-deletion-cache.service';

@Injectable()
export class EffectTemplateDeletionService implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private draining = false;
  private stopped = false;
  constructor(
    @Inject(EffectTemplateDeletionRepository)
    private readonly repository: EffectTemplateDeletionRepository,
    @Inject(STORAGE_PORT) private readonly storage: StoragePort,
    @Inject(EffectTemplateDeletionCache) private readonly cache: EffectTemplateDeletionCache,
  ) {}
  onModuleInit() {
    this.timer = setInterval(() => {
      void this.drain();
    }, 5_000);
    this.timer.unref();
    void this.drain();
  }
  onModuleDestroy() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
  }
  async remove(
    projectId: string,
    workflowRunId: string,
    templateId: string,
    revision: number | null,
  ) {
    const result = await this.repository.enqueue(projectId, workflowRunId, templateId, revision);
    // Do not couple response time to object storage or cache availability.
    const wake = setTimeout(() => {
      void this.drain();
    }, 0);
    wake.unref();
    return result;
  }
  async cleanup(id: string) {
    const token = randomUUID();
    const job = await this.repository.claim(id, token);
    if (!job) return;
    try {
      if (job.phase === 'DATABASE') {
        await this.repository.removeData(id, token);
        // Re-read the durable list after committing database cleanup, not a stale claim.
        await this.repository.releaseFiles(id, token);
        return;
      }
      const keys = job.storageKeys as string[];
      const batch = keys.slice(0, 24);
      const remaining = keys.slice(24);
      for (let start = 0; start < batch.length; start += 4)
        await Promise.all(
          batch.slice(start, start + 4).map(async (key) => {
            try {
              if (await this.repository.unreferenced(key)) await this.storage.delete(key);
            } catch {
              remaining.push(key);
            }
          }),
        );
      let cacheCleared = false;
      try {
        await this.cache.clear(job.projectId);
        cacheCleared = true;
      } catch {
        /* durable retry */
      }
      await this.repository.finish(id, token, remaining, cacheCleared);
    } catch {
      await this.repository.retry(id, token);
    }
  }
  async drain() {
    if (this.draining || this.stopped) return;
    this.draining = true;
    try {
      for (const job of await this.repository.pending()) {
        if (this.stopped) break;
        await this.cleanup(job.id);
      }
    } catch {
      /* database outage: next timer resumes persisted jobs */
    } finally {
      this.draining = false;
    }
  }
}
