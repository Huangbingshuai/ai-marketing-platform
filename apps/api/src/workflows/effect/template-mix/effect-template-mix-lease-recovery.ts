import {
  Inject,
  Injectable,
  Logger,
  Optional,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { EffectTemplateMixAiRepository } from './effect-template-mix-ai.repository';
import { EffectPackagingRepository } from './effect-packaging.repository';
import { EffectVoiceRepository } from './effect-voice.repository';
import { EffectFinalOutputService } from '../final-output/effect-final-output.service';

@Injectable()
export class EffectTemplateMixLeaseRecovery implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EffectTemplateMixLeaseRecovery.name);
  private timer: NodeJS.Timeout | null = null;
  constructor(
    @Inject(EffectTemplateMixAiRepository)
    private readonly repository: EffectTemplateMixAiRepository,
    @Optional()
    @Inject(EffectPackagingRepository)
    private readonly packaging?: EffectPackagingRepository,
    @Optional()
    @Inject(EffectFinalOutputService)
    private readonly output?: EffectFinalOutputService,
    @Optional() @Inject(EffectVoiceRepository) private readonly voices?: EffectVoiceRepository,
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
      await this.packaging?.recoverExpired();
      await this.output?.recoverExpired();
      await this.voices?.recoverExpired();
    } catch (error) {
      this.logger.error(
        '模板混剪任务恢复失败：' + (error instanceof Error ? error.name : 'UNKNOWN'),
      );
    }
  }
}
