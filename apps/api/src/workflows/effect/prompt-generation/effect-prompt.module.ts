import { Module } from '@nestjs/common';

import { ProjectModule } from '../../../platform/project/project.module';
import { WorkflowModule } from '../../../platform/workflow/workflow.module';
import { EffectPromptController } from './effect-prompt.controller';
import { EffectPromptLeaseRecovery } from './effect-prompt-lease-recovery';
import { EffectPromptRepository } from './effect-prompt.repository';
import { EffectPromptService } from './effect-prompt.service';
import { EffectPromptWorkerController } from './effect-prompt-worker.controller';
import { EffectPromptWorkerGuard } from './effect-prompt-worker.guard';

@Module({
  imports: [ProjectModule, WorkflowModule],
  controllers: [EffectPromptController, EffectPromptWorkerController],
  providers: [
    EffectPromptRepository,
    EffectPromptService,
    EffectPromptWorkerGuard,
    EffectPromptLeaseRecovery,
  ],
  exports: [EffectPromptService],
})
export class EffectPromptModule {}
