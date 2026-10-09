import { Module } from '@nestjs/common';
import { ProjectModule } from '../../../platform/project/project.module';
import { FileModule } from '../../../platform/file/file.module';
import { WorkflowModule } from '../../../platform/workflow/workflow.module';
import { JobModule } from '../../../platform/job/job.module';
import { CustomizedExtractionRepository } from './customized-extraction.repository';
import { CustomizedExtractionService } from './customized-extraction.service';
import { CustomizedExtractionController } from './customized-extraction.controller';
import {
  CustomizedExtractionWorkerController,
  CustomizedExtractionWorkerGuard,
} from './customized-extraction-worker.controller';
@Module({
  imports: [ProjectModule, FileModule, WorkflowModule, JobModule],
  providers: [
    CustomizedExtractionRepository,
    CustomizedExtractionService,
    CustomizedExtractionWorkerGuard,
  ],
  controllers: [CustomizedExtractionController, CustomizedExtractionWorkerController],
})
export class CustomizedExtractionModule {}
