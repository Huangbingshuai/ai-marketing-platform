import { Module } from '@nestjs/common';

import { FileModule } from '../../../platform/file/file.module';
import { ProjectModule } from '../../../platform/project/project.module';
import { WorkflowModule } from '../../../platform/workflow/workflow.module';
import { EffectSourceImportController } from './effect-source-import.controller';
import { EffectSourceImportRepository } from './effect-source-import.repository';
import { EffectSourceImportService } from './effect-source-import.service';

@Module({
  imports: [FileModule, ProjectModule, WorkflowModule],
  controllers: [EffectSourceImportController],
  providers: [EffectSourceImportRepository, EffectSourceImportService],
})
export class EffectSourceImportModule {}
