import { Module } from '@nestjs/common';

import { FileModule } from '../../../platform/file/file.module';
import { JobModule } from '../../../platform/job/job.module';
import { ProjectModule } from '../../../platform/project/project.module';
import { WorkflowModule } from '../../../platform/workflow/workflow.module';
import { EffectExtractionController } from './effect-extraction.controller';
import { EffectExtractionLeaseRecovery } from './effect-extraction-lease-recovery';
import { EffectExtractionRepository } from './effect-extraction.repository';
import { EffectExtractionService } from './effect-extraction.service';
import { EffectExtractionWorkerController } from './effect-extraction-worker.controller';
import { EffectExtractionWorkerGuard } from './effect-extraction-worker.guard';

@Module({
  imports: [ProjectModule, FileModule, JobModule, WorkflowModule],
  controllers: [EffectExtractionController, EffectExtractionWorkerController],
  providers: [
    EffectExtractionRepository,
    EffectExtractionService,
    EffectExtractionWorkerGuard,
    EffectExtractionLeaseRecovery,
  ],
  exports: [EffectExtractionService],
})
export class EffectExtractionModule {}
