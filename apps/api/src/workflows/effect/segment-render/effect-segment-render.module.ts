import { Module } from '@nestjs/common';
import { FileModule } from '../../../platform/file/file.module';
import { ProjectModule } from '../../../platform/project/project.module';
import { WorkflowModule } from '../../../platform/workflow/workflow.module';
import { EffectSegmentRenderController } from './effect-segment-render.controller';
import { EffectSegmentRenderLeaseRecovery } from './effect-segment-render-lease-recovery';
import { EffectSegmentRenderRepository } from './effect-segment-render.repository';
import { EffectSegmentRenderService } from './effect-segment-render.service';
import { EffectSegmentRenderWorkerController } from './effect-segment-render-worker.controller';
import { EffectSegmentRenderWorkerGuard } from './effect-segment-render-worker.guard';

@Module({
  imports: [FileModule, ProjectModule, WorkflowModule],
  controllers: [EffectSegmentRenderController, EffectSegmentRenderWorkerController],
  providers: [
    EffectSegmentRenderRepository,
    EffectSegmentRenderService,
    EffectSegmentRenderWorkerGuard,
    EffectSegmentRenderLeaseRecovery,
  ],
  exports: [EffectSegmentRenderService],
})
export class EffectSegmentRenderModule {}
