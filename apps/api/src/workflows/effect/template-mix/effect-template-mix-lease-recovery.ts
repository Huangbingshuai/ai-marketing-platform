import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { EffectTemplateMixAiRepository } from './effect-template-mix-ai.repository';

@Injectable()
export class EffectTemplateMixLeaseRecovery implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EffectTemplateMixLeaseRecovery.name);
  private timer: NodeJS.Timeout | null = null;
  constructor(
    @Inject(EffectTemplateMixAiRepository)
    private readonly repository: EffectTemplateMixAiRepository,
  ) {}
  onModuleInit(): void {
    this.timer = setInterval(() => void this.recover(), 15_000);
    this.timer.unref();
  }
  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }
  private async recover(): Promise<void> {
    try {
      await this.repository.recoverExpired();
    } catch (error) {
      this.logger.error(
        '模板混剪任务恢复失败：' + (error instanceof Error ? error.name : 'UNKNOWN'),
      );
    }
  }
}
