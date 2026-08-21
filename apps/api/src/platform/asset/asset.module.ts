import { Module } from '@nestjs/common';

import { FileModule } from '../file/file.module';
import { ProjectModule } from '../project/project.module';
import { AssetController } from './asset.controller';
import { AssetRepository } from './asset.repository';
import { AssetService } from './asset.service';

@Module({
  imports: [FileModule, ProjectModule],
  controllers: [AssetController],
  providers: [AssetRepository, AssetService],
  exports: [AssetService],
})
export class AssetModule {}
