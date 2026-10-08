import { Module } from '@nestjs/common';
import { AssetModule } from '../../../platform/asset/asset.module';
import { FileModule } from '../../../platform/file/file.module';
import { WorkflowModule } from '../../../platform/workflow/workflow.module';
import { CustomizedSourceImportController } from './customized-source-import.controller';
import { CustomizedSourceImportService } from './customized-source-import.service';

@Module({
  imports: [AssetModule, FileModule, WorkflowModule],
  controllers: [CustomizedSourceImportController],
  providers: [CustomizedSourceImportService],
})
export class CustomizedSourceImportModule {}
