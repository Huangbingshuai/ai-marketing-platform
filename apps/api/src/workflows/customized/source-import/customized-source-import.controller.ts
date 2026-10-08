import {
  Body,
  Controller,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { IsIn } from 'class-validator';
import {
  CUSTOMIZED_IMPORT_LIMITS,
  type UploadCustomizedMaterialRequest,
} from '@ai-marketing/contracts';
import type { UploadedAssetFile } from '../../../platform/asset/asset.service';
import { UploadTemporaryFileCleanupInterceptor } from '../../../platform/file/upload-temporary-file-cleanup.interceptor';
import { CustomizedSourceImportService } from './customized-source-import.service';

export class UploadCustomizedMaterialDto implements UploadCustomizedMaterialRequest {
  @IsIn(['BRIEF', 'VISUAL_REFERENCE'])
  section!: UploadCustomizedMaterialRequest['section'];
}

@Controller('projects/:projectId/workflows/customized/source-import')
export class CustomizedSourceImportController {
  constructor(
    @Inject(CustomizedSourceImportService) private readonly service: CustomizedSourceImportService,
  ) {}

  @Post('runs/:runId/materials')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: {
        files: 1,
        fileSize: Math.max(
          CUSTOMIZED_IMPORT_LIMITS.maxDocumentBytes,
          CUSTOMIZED_IMPORT_LIMITS.maxImageBytes,
        ),
      },
    }),
    UploadTemporaryFileCleanupInterceptor,
  )
  upload(
    @Param('projectId', new ParseUUIDPipe({ version: '4' })) projectId: string,
    @Param('runId', new ParseUUIDPipe({ version: '4' })) runId: string,
    @Body() body: UploadCustomizedMaterialDto,
    @UploadedFile() file: UploadedAssetFile | undefined,
  ) {
    return this.service.upload(projectId, runId, body.section, file);
  }
}
