import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';

import { EFFECT_EXTRACTION_QUEUE, JOB_PUBLISHER } from './job.constants';
import { JobOutboxRepository } from './job-outbox.repository';
import type { JobMessage, JobPublisher } from './job.ports';

const retryDelay = (attempt: number): number => Math.min(60_000, 1000 * 2 ** Math.min(attempt, 6));

@Injectable()
export class JobOutboxDispatcher implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(JobOutboxDispatcher.name);
  private timer: NodeJS.Timeout | null = null;
  private active = false;

  constructor(
    @Inject(JobOutboxRepository) private readonly repository: JobOutboxRepository,
    @Inject(JOB_PUBLISHER) private readonly publisher: JobPublisher,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.dispatchPending(), 1500);
    this.timer.unref();
    void this.dispatchPending();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async dispatchPending(): Promise<void> {
    if (this.active) return;
    this.active = true;
    try {
      const entries = await this.repository.claimPending();
      for (const entry of entries) {
        try {
          await this.publisher.publish(
            entry.routingKey || EFFECT_EXTRACTION_QUEUE,
            entry.id,
            entry.payload as JobMessage,
          );
          await this.repository.markPublished(entry.projectId, entry.id, entry.dispatchToken!);
        } catch (error) {
          try {
            await this.repository.markFailed(
              entry.projectId,
              entry.id,
              entry.dispatchToken!,
              error instanceof Error ? error.message : 'RabbitMQ publish failed',
              new Date(Date.now() + retryDelay(entry.attempts)),
            );
          } catch (persistError) {
            this.logger.error(
              `Outbox 失败状态回写失败：${persistError instanceof Error ? persistError.name : 'UNKNOWN'}`,
            );
          }
        }
      }
    } catch (error) {
      this.logger.error(
        `Outbox 投递轮询失败：${error instanceof Error ? error.name : 'UNKNOWN'}`,
      );
    } finally {
      this.active = false;
    }
  }
}
