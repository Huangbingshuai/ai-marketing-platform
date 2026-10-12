import { Module } from '@nestjs/common';
import { ProjectModule } from '../../../platform/project/project.module';
import { WorkflowModule } from '../../../platform/workflow/workflow.module';
import { JobModule } from '../../../platform/job/job.module';
import { StoryboardRepository } from './storyboard.repository';
import { StoryboardService } from './storyboard.service';
import { StoryboardController } from './storyboard.controller';
import { StoryboardWorkerController, StoryboardWorkerGuard } from './storyboard-worker.controller';
@Module({
  imports: [ProjectModule, WorkflowModule, JobModule],
  providers: [StoryboardRepository, StoryboardService, StoryboardWorkerGuard],
  controllers: [StoryboardController, StoryboardWorkerController],
})
export class StoryboardModule {}
