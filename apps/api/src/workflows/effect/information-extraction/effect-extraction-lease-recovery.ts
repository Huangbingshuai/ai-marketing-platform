import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';

import { EffectExtractionRepository } from './effect-extraction.repository';

@Injectable()
export class EffectExtractionLeaseRecovery implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null;
  private active = false;

  constructor(
    @Inject(EffectExtractionRepository) private readonly repository: EffectExtractionRepository,
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
      await this.repository.recoverExpiredLeases();
    } finally {
      this.active = false;
    }
  }
}
