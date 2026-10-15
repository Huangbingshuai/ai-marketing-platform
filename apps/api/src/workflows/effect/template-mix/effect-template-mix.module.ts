import { Module } from '@nestjs/common';

import { WorkflowModule } from '../../../platform/workflow/workflow.module';
import { ProjectModule } from '../../../platform/project/project.module';
import { FileModule } from '../../../platform/file/file.module';
import { JobModule } from '../../../platform/job/job.module';
import { EffectTemplateMixController } from './effect-template-mix.controller';
import { EffectTemplateMixService } from './effect-template-mix.service';
import { EffectTemplateDeletionService } from './effect-template-deletion.service';
import { EffectTemplateDeletionRepository } from './effect-template-deletion.repository';
import { EffectTemplateDeletionCache } from './effect-template-deletion-cache.service';
import { EffectTemplateMixCompletionService } from './effect-template-mix-completion.service';
import { EffectTemplateMixAiRepository } from './effect-template-mix-ai.repository';
import { EffectTemplateMixWorkerController } from './effect-template-mix-worker.controller';
import { EffectTemplateMixWorkerGuard } from './effect-template-mix-worker.guard';
import { EffectTemplateMixLeaseRecovery } from './effect-template-mix-lease-recovery';
import { EffectPackagingRepository } from './effect-packaging.repository';
import { EffectPackagingService } from './effect-packaging.service';
import { EffectVoiceCatalogService } from './effect-voice.catalog';
import { EffectVoiceRepository } from './effect-voice.repository';
import { EffectVoiceService } from './effect-voice.service';
import {
  EffectVoiceCatalogSampleWorkerController,
  EffectVoiceController,
  EffectVoiceWorkerController,
} from './effect-voice.controller';
import { EffectFinalOutputService } from '../final-output/effect-final-output.service';
import { EffectFinalOutputController, EffectFinalOutputWorkerController } from '../final-output/effect-final-output.controller';
import {
  EffectPackagingCaptionVoiceController,
  EffectPackagingController,
  EffectPackagingWorkerController,
} from './effect-packaging.controller';

@Module({
  imports: [WorkflowModule, FileModule, JobModule, ProjectModule],
  controllers: [
    EffectTemplateMixController,
    EffectTemplateMixWorkerController,
    EffectPackagingController,
    EffectPackagingWorkerController,
    EffectPackagingCaptionVoiceController,
    EffectVoiceController,
    EffectVoiceWorkerController,
    EffectVoiceCatalogSampleWorkerController,
    EffectFinalOutputController,
    EffectFinalOutputWorkerController,
  ],
  providers: [
    EffectTemplateMixService,
    EffectTemplateDeletionService,
    EffectTemplateDeletionRepository,
    EffectTemplateDeletionCache,
    EffectTemplateMixCompletionService,
    EffectTemplateMixAiRepository,
    EffectTemplateMixWorkerGuard,
    EffectTemplateMixLeaseRecovery,
    EffectPackagingRepository,
    EffectPackagingService,
    EffectVoiceCatalogService,
    EffectVoiceRepository,
    EffectVoiceService,
    EffectFinalOutputService,
  ],
})
export class EffectTemplateMixModule {}
