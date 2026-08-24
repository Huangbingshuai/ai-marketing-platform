import { Module } from '@nestjs/common';
import { FileModule } from '../file/file.module';
import { ProjectModule } from '../project/project.module';
import { WorkflowWorkingController } from './workflow-working.controller';
import { WorkflowWorkingRepository } from './workflow-working.repository';
import { WorkflowWorkingService } from './workflow-working.service';

@Module({
  imports: [FileModule, ProjectModule],
  controllers: [WorkflowWorkingController],
  providers: [WorkflowWorkingRepository, WorkflowWorkingService],
  exports: [WorkflowWorkingRepository, WorkflowWorkingService],
})
export class WorkflowModule {}
