import type { ServerResponse } from 'node:http';
import { pipeline } from 'node:stream/promises';
import {
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Res,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { EFFECT_SEGMENT_RENDER_LIMITS } from '@ai-marketing/contracts';
import { UploadTemporaryFileCleanupInterceptor } from '../../../platform/file/upload-temporary-file-cleanup.interceptor';
import { RawResponse } from '../../../common/raw-response.decorator';
import { EffectTemplateMixWorkerGuard } from '../template-mix/effect-template-mix-worker.guard';
import { EffectSegmentImportService } from './effect-segment-import.service';
import type { UploadedSegmentRenderFile } from './effect-segment-render.types';

export class ImportKeyDto {
  @IsString() @IsNotEmpty() @MaxLength(500) idempotencyKey!: string;
}
export class ImportConfirmItemDto {
  @IsUUID('4') draftId!: string;
  @IsString() @IsNotEmpty() @MaxLength(4000) promptText!: string;
}
export class ImportConfirmDto extends ImportKeyDto {
  @Type(() => Number) @IsInt() @Min(1) expectedBatchRevision!: number;
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => ImportConfirmItemDto)
  items!: ImportConfirmItemDto[];
}
export class ImportWorkerDto {
  @IsUUID('4') projectId!: string;
}
export class ImportClaimDto extends ImportWorkerDto {
  @IsString() @IsNotEmpty() @MaxLength(500) requestId!: string;
}
export class ImportCompleteDto extends ImportWorkerDto {
  @IsOptional() @IsString() @MaxLength(4000) promptText?: string;
}

@Controller('projects/:projectId/workflows/effect/segment-render/batches/:batchId/imports')
export class EffectSegmentImportController {
  constructor(
    @Inject(EffectSegmentImportService) private readonly service: EffectSegmentImportService,
  ) {}
  @Post('drafts')
  @UseInterceptors(
    FilesInterceptor('files', 1, {
      limits: { fileSize: EFFECT_SEGMENT_RENDER_LIMITS.maxUploadBytes },
    }),
    UploadTemporaryFileCleanupInterceptor,
  )
  stage(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('batchId', ParseUUIDPipe) batchId: string,
    @Body() body: ImportKeyDto,
    @UploadedFiles() files?: UploadedSegmentRenderFile[],
  ) {
    return this.service.stage(projectId, batchId, body.idempotencyKey, files?.[0]);
  }
  @Get('drafts/:draftId')
  get(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('batchId', ParseUUIDPipe) batchId: string,
    @Param('draftId', ParseUUIDPipe) id: string,
  ) {
    return this.service.get(projectId, batchId, id);
  }
  @Post('drafts/:draftId/describe')
  describe(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('batchId', ParseUUIDPipe) batchId: string,
    @Param('draftId', ParseUUIDPipe) id: string,
    @Body() body: ImportKeyDto,
  ) {
    return this.service.describe(projectId, batchId, id, body.idempotencyKey);
  }
  @Post('drafts/:draftId/cancel')
  cancel(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('batchId', ParseUUIDPipe) batchId: string,
    @Param('draftId', ParseUUIDPipe) id: string,
  ) {
    return this.service.cancel(projectId, batchId, id);
  }
  @Post('confirm')
  confirm(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('batchId', ParseUUIDPipe) batchId: string,
    @Body() body: ImportConfirmDto,
  ) {
    return this.service.confirm(
      projectId,
      batchId,
      body.items,
      body.expectedBatchRevision,
      body.idempotencyKey,
    );
  }
}

@Controller('internal/workers/effect-template-mix/video-imports')
@UseGuards(EffectTemplateMixWorkerGuard)
export class EffectSegmentImportWorkerController {
  constructor(
    @Inject(EffectSegmentImportService) private readonly service: EffectSegmentImportService,
  ) {}
  @Post(':id/claim')
  claim(@Param('id', ParseUUIDPipe) id: string, @Body() body: ImportClaimDto) {
    return this.service.claim(body.projectId, id, body.requestId);
  }
  @Put(':id/heartbeat')
  heartbeat(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ImportWorkerDto,
    @Headers('x-attempt-token') token: string,
  ) {
    return this.service.heartbeat(body.projectId, id, token);
  }
  @Put(':id/complete')
  complete(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ImportCompleteDto,
    @Headers('x-attempt-token') token: string,
  ) {
    return this.service.finish(body.projectId, id, token, body.promptText ?? null);
  }
  @Get(':id/content')
  @RawResponse()
  async content(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: ImportWorkerDto,
    @Headers('x-attempt-token') token: string,
    @Res() response: ServerResponse,
  ) {
    const result = await this.service.content(query.projectId, id, token);
    response.setHeader('Content-Type', result.mimeType);
    response.setHeader('Content-Length', result.sizeBytes);
    await pipeline(result.stream, response);
  }
}
