import { Module } from '@nestjs/common';

import { AssetModule } from '../../../platform/asset/asset.module';
import { FileModule } from '../../../platform/file/file.module';
import { ProjectModule } from '../../../platform/project/project.module';
import { EffectSourceImportController } from './effect-source-import.controller';
import { EffectSourceImportRepository } from './effect-source-import.repository';
import { EffectSourceImportService } from './effect-source-import.service';

@Module({
  imports: [AssetModule, FileModule, ProjectModule],
  controllers: [EffectSourceImportController],
  providers: [EffectSourceImportRepository, EffectSourceImportService],
})
export class EffectSourceImportModule {}
