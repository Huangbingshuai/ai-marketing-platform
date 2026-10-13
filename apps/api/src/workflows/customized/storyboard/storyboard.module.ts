import { Module } from '@nestjs/common';
import { ProductionRepository } from '../production/production.repository';
import { ProductionService, ProductionController, ProductionWorkerController, ProductionWorkerGuard } from '../production/production.controller';
import { ProjectModule } from '../../../platform/project/project.module';
import { WorkflowModule } from '../../../platform/workflow/workflow.module';
import { JobModule } from '../../../platform/job/job.module';
import { StoryboardRepository } from './storyboard.repository';
import { StoryboardService } from './storyboard.service';
import { StoryboardController } from './storyboard.controller';
import { StoryboardWorkerController, StoryboardWorkerGuard } from './storyboard-worker.controller';
@Module({
  imports: [ProjectModule, WorkflowModule, JobModule],
  providers: [StoryboardRepository, StoryboardService, StoryboardWorkerGuard, ProductionRepository, ProductionService, ProductionWorkerGuard],
  controllers: [StoryboardController, StoryboardWorkerController, ProductionController, ProductionWorkerController],
})
export class StoryboardModule {}
