import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';

import { EffectPromptRepository } from './effect-prompt.repository';

@Injectable()
export class EffectPromptLeaseRecovery implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EffectPromptLeaseRecovery.name);
  private timer: NodeJS.Timeout | null = null;
  private active = false;

  constructor(
    @Inject(EffectPromptRepository) private readonly repository: EffectPromptRepository,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(
      () =>
        void this.recover().catch((error: unknown) =>
          this.logger.error(
            `Prompt 租约恢复失败：${error instanceof Error ? error.name : 'UNKNOWN'}`,
          ),
        ),
      15_000,
    );
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async recover(): Promise<void> {
    if (this.active) return;
    this.active = true;
    try {
      await this.repository.recoverExpiredLeases();
    } finally {
      this.active = false;
    }
  }
}
