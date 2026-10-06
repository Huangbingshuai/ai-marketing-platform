import { Module } from '@nestjs/common';
import { FileModule } from '../../../platform/file/file.module';
import { ProjectModule } from '../../../platform/project/project.module';
import { WorkflowModule } from '../../../platform/workflow/workflow.module';
import { EffectSegmentRenderController } from './effect-segment-render.controller';
import { EffectSegmentRenderProviderInputController } from './effect-segment-render-provider-input.controller';
import { EffectSegmentRenderLeaseRecovery } from './effect-segment-render-lease-recovery';
import { EffectSegmentRenderRepository } from './effect-segment-render.repository';
import { EffectSegmentRenderService } from './effect-segment-render.service';
import { EffectSegmentRenderWorkerController } from './effect-segment-render-worker.controller';
import { EffectSegmentRenderWorkerGuard } from './effect-segment-render-worker.guard';
import {
  EffectSegmentImportController,
  EffectSegmentImportWorkerController,
} from './effect-segment-import.controller';
import { EffectSegmentImportRepository } from './effect-segment-import.repository';
import { EffectSegmentImportService } from './effect-segment-import.service';
import { EffectTemplateMixWorkerGuard } from '../template-mix/effect-template-mix-worker.guard';

@Module({
  imports: [FileModule, ProjectModule, WorkflowModule],
  controllers: [
    EffectSegmentImportController,
    EffectSegmentImportWorkerController,
    EffectSegmentRenderController,
    EffectSegmentRenderWorkerController,
    EffectSegmentRenderProviderInputController,
  ],
  providers: [
    EffectSegmentImportRepository,
    EffectSegmentImportService,
    EffectTemplateMixWorkerGuard,
    EffectSegmentRenderRepository,
    EffectSegmentRenderService,
    EffectSegmentRenderWorkerGuard,
    EffectSegmentRenderLeaseRecovery,
  ],
  exports: [EffectSegmentRenderService],
})
export class EffectSegmentRenderModule {}
