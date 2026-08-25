import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';

import type { StoragePort } from '../../../platform/file/storage.port';
import { STORAGE_PORT } from '../../../platform/file/storage.port';
import { EffectSourceImportRepository } from './effect-source-import.repository';

@Injectable()
export class EffectWorkingCleanupProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EffectWorkingCleanupProcessor.name);
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;

  constructor(
    @Inject(EffectSourceImportRepository)
    private readonly repository: EffectSourceImportRepository,
    @Inject(STORAGE_PORT) private readonly storage: StoragePort,
  ) {}

  onModuleInit(): void {
    void this.tick();
    this.timer = setInterval(() => void this.tick(), 60_000);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const products = await this.repository.dueRemovedProducts();
      for (const product of products)
        await this.repository.purgeRemovedProduct(product.projectId, product.id).catch(() => false);

      const tasks = await this.repository.storageCleanupTasksAcrossProjects();
      for (const task of tasks) {
        if (await this.repository.isStorageHeld(task.projectId, task.storageKey)) continue;
        try {
          await this.storage.delete(task.storageKey);
          await this.repository.deleteOrphanedFileObject(task.projectId, task.storageKey);
          await this.repository.deleteStorageCleanup(task.projectId, task.id);
        } catch (error) {
          await this.repository.failStorageCleanup(
            task.projectId,
            task.id,
            error instanceof Error ? error.message : '工作文件清理失败',
          );
        }
      }
    } catch {
      this.logger.warn('工作文件周期清理未完成，将在下一周期重试');
    } finally {
      this.running = false;
    }
  }
}
