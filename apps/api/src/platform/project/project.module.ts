import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';

import { ProjectController } from './project.controller';
import { ProjectRepository } from './project.repository';
import { ProjectService } from './project.service';
import { FileModule } from '../file/file.module';
import { ProjectDeletionRepository } from './project-deletion.repository';
import { ProjectDeletionService } from './project-deletion.service';
import { ProjectDeletionCacheService } from './project-deletion-cache.service';
import { ProjectDeletionGuard } from './project-deletion.guard';

@Module({
  imports: [FileModule],
  controllers: [ProjectController],
  providers: [
    { provide: APP_GUARD, useClass: ProjectDeletionGuard },
    ProjectRepository,
    ProjectService,
    ProjectDeletionRepository,
    ProjectDeletionService,
    ProjectDeletionCacheService,
  ],
  exports: [ProjectService],
})
export class ProjectModule {}
