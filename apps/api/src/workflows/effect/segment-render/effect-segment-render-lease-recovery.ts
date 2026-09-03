import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { EffectSegmentRenderRepository } from './effect-segment-render.repository';

@Injectable()
export class EffectSegmentRenderLeaseRecovery implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EffectSegmentRenderLeaseRecovery.name);
  private timer: NodeJS.Timeout | null = null;
  private active = false;

  constructor(
    @Inject(EffectSegmentRenderRepository)
    private readonly repository: EffectSegmentRenderRepository,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.recover(), 15_000);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async recover(): Promise<void> {
    if (this.active) return;
    this.active = true;
    try {
      const leases = await this.repository.recoverExpiredLeases();
      const dispatches = await this.repository.recoverStaleQueuedDispatches();
      if (leases.requeued || leases.failed || dispatches)
        this.logger.warn(
          '视频渲染任务恢复：重新排队 ' +
            String(leases.requeued + dispatches) +
            '，终止 ' +
            String(leases.failed),
        );
    } catch (error) {
      this.logger.error(
        '视频渲染任务恢复失败：' + (error instanceof Error ? error.name : 'UNKNOWN'),
      );
    } finally {
      this.active = false;
    }
  }
}
