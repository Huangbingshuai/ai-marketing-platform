import { Module } from '@nestjs/common';

import { WorkflowModule } from '../../../platform/workflow/workflow.module';
import { FileModule } from '../../../platform/file/file.module';
import { JobModule } from '../../../platform/job/job.module';
import { EffectTemplateMixController } from './effect-template-mix.controller';
import { EffectTemplateMixService } from './effect-template-mix.service';
import { EffectTemplateMixAiRepository } from './effect-template-mix-ai.repository';
import { EffectTemplateMixWorkerController } from './effect-template-mix-worker.controller';
import { EffectTemplateMixWorkerGuard } from './effect-template-mix-worker.guard';
import { EffectTemplateMixLeaseRecovery } from './effect-template-mix-lease-recovery';
import { EffectPackagingRepository } from './effect-packaging.repository';
import { EffectPackagingService } from './effect-packaging.service';
import { EffectPackagingController, EffectPackagingWorkerController } from './effect-packaging.controller';

@Module({
  imports: [WorkflowModule, FileModule, JobModule],
  controllers: [EffectTemplateMixController, EffectTemplateMixWorkerController, EffectPackagingController, EffectPackagingWorkerController],
  providers: [
    EffectTemplateMixService,
    EffectTemplateMixAiRepository,
    EffectTemplateMixWorkerGuard,
    EffectTemplateMixLeaseRecovery,
    EffectPackagingRepository,
    EffectPackagingService,
  ],
})
export class EffectTemplateMixModule {}
