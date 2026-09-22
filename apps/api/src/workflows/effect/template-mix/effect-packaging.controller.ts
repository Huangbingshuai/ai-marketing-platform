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
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsIn,
  IsISO8601,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import type {
  PackagingCheckpoint,
  PackagingComponent,
  PackagingStage,
} from '@ai-marketing/contracts';
import { PACKAGING_STAGES } from '@ai-marketing/contracts';
import { pipeline } from 'node:stream/promises';
import type { ServerResponse } from 'node:http';
import { RawResponse } from '../../../common/raw-response.decorator';
import { UploadTemporaryFileCleanupInterceptor } from '../../../platform/file/upload-temporary-file-cleanup.interceptor';
// Nest validation requires runtime DTO classes.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import {
  EffectTemplateMixRevisionDto,
  EffectTemplateMixWorkerProjectDto,
  EffectTemplateMixWorkspaceQueryDto,
} from './dto/effect-template-mix.dto';
import { EffectPackagingService } from './effect-packaging.service';
import { EffectTemplateMixWorkerGuard } from './effect-template-mix-worker.guard';

export class CreatePackagingDto extends EffectTemplateMixRevisionDto {
  @IsString() @MinLength(1) @MaxLength(500) idempotencyKey!: string;
  @IsOptional() @IsUUID('4') variantId?: string;
  @IsOptional() @IsIn(['ALL', 'VOICE', 'MUSIC', 'CAPTIONS']) component?: PackagingComponent;
}
export class PackagingCheckpointDto extends EffectTemplateMixWorkerProjectDto {
  @IsIn(PACKAGING_STAGES) stage!: PackagingStage;
  @IsObject() checkpoint!: PackagingCheckpoint;
  @IsOptional() @IsString() @MaxLength(300) errorMessage?: string;
}
/** Only geometry and volume are accepted; file identity stays server-owned. */
export class PackagingAudioEditDto {
  @Type(() => Number) @IsNumber() @Min(0) start!: number;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) offset?: number;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) duration?: number;
  @Type(() => Number) @IsNumber() @Min(0) @Max(1) volume!: number;
  /** Editor-only; absent keeps the pipeline default (`final_output.py`), so old clients stay valid. */
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) fadeIn?: number;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) fadeOut?: number;
}
export class PackagingCaptionEditDto {
  @IsString() @MinLength(1) @MaxLength(50) id!: string;
  @IsString() @MinLength(1) @MaxLength(500) text!: string;
  @Type(() => Number) @IsNumber() @Min(0) start!: number;
  @Type(() => Number) @IsNumber() @Min(0) end!: number;
}
/** Normalised caption geometry; ranges mirror the domain check that backs this up. */
export class PackagingCaptionBoxDto {
  @Type(() => Number) @IsNumber() @Min(0) @Max(1) x!: number;
  @Type(() => Number) @IsNumber() @Min(0) @Max(1) y!: number;
  @Type(() => Number) @IsNumber() @Min(0.1) @Max(1) width!: number;
  @Type(() => Number) @IsNumber() @Min(0.25) @Max(4) scale!: number;
}
export class UpdatePackagingAudioDto {
  @IsISO8601() expectedUpdatedAt!: string;
  @IsOptional() @IsObject() voices?: Record<string, PackagingAudioEditDto>;
  @IsOptional() @ValidateNested() @Type(() => PackagingAudioEditDto) music?: PackagingAudioEditDto;
  @IsOptional() @IsObject() boxes?: Record<string, PackagingCaptionBoxDto>;
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PackagingCaptionEditDto)
  captions?: PackagingCaptionEditDto[];
}
const uuid = new ParseUUIDPipe({ version: '4' });

@Controller('projects/:projectId/workflows/effect/template-mix')
export class EffectPackagingController {
  constructor(@Inject(EffectPackagingService) readonly service: EffectPackagingService) {}
  @Post('templates/:templateId/packaging-runs')
  create(
    @Param('projectId', uuid) projectId: string,
    @Param('templateId', uuid) templateId: string,
    @Body() body: CreatePackagingDto,
  ) {
    return this.service.create(projectId, templateId, body);
  }
  @Get('templates/:templateId/packaging-runs')
  list(
    @Param('projectId', uuid) projectId: string,
    @Param('templateId', uuid) templateId: string,
    @Query() query: EffectTemplateMixWorkspaceQueryDto,
  ) {
    return this.service.list(projectId, query.workflowRunId, templateId);
  }
  @Get('packaging-runs/:runId')
  get(@Param('projectId', uuid) projectId: string, @Param('runId', uuid) runId: string) {
    return this.service.get(projectId, runId);
  }
  @Post('packaging-runs/:runId/cancel')
  async cancel(@Param('projectId', uuid) projectId: string, @Param('runId', uuid) runId: string) {
    await this.service.get(projectId, runId);
    return this.service.repo.cancel(projectId, runId);
  }
  @Post('packaging-runs/:runId/retry')
  retry(@Param('projectId', uuid) projectId: string, @Param('runId', uuid) runId: string) {
    return this.service.retry(projectId, runId);
  }
  @Put('packaging-runs/:runId/items/:itemId/audio')
  updateAudio(
    @Param('projectId', uuid) projectId: string,
    @Param('runId', uuid) runId: string,
    @Param('itemId', uuid) itemId: string,
    @Body() body: UpdatePackagingAudioDto,
  ) {
    return this.service.updateAudio(projectId, runId, itemId, body);
  }
  @Get('templates/:templateId/variants/:variantId/output-inputs')
  outputInputs(
    @Param('projectId', uuid) projectId: string,
    @Param('templateId', uuid) templateId: string,
    @Param('variantId', uuid) variantId: string,
    @Query() query: EffectTemplateMixWorkspaceQueryDto,
  ) {
    return this.service.outputInputs(projectId, query.workflowRunId, templateId, variantId);
  }
}

@Controller('internal/workers/effect-template-mix/packaging-runs')
@UseGuards(EffectTemplateMixWorkerGuard)
export class EffectPackagingWorkerController {
  constructor(@Inject(EffectPackagingService) readonly service: EffectPackagingService) {}
  @Post(':runId/claim')
  claim(@Param('runId', uuid) runId: string, @Body() body: EffectTemplateMixWorkerProjectDto) {
    return this.service.repo.claim(body.projectId, runId);
  }
  @Put(':runId/heartbeat')
  heartbeat(
    @Param('runId', uuid) runId: string,
    @Headers('x-attempt-token') token: string,
    @Body() body: EffectTemplateMixWorkerProjectDto,
  ) {
    return this.service.repo.heartbeat(body.projectId, runId, token);
  }
  @Post(':runId/finish')
  finish(
    @Param('runId', uuid) runId: string,
    @Headers('x-attempt-token') token: string,
    @Body() body: EffectTemplateMixWorkerProjectDto,
  ) {
    return this.service.repo.finish(body.projectId, runId, token);
  }
  @Put(':runId/items/:itemId/checkpoint')
  checkpoint(
    @Param('runId', uuid) runId: string,
    @Param('itemId', uuid) itemId: string,
    @Headers('x-attempt-token') token: string,
    @Body() body: PackagingCheckpointDto,
  ) {
    return this.service.checkpoint(
      body.projectId,
      runId,
      token,
      itemId,
      body.stage,
      body.checkpoint,
      body.errorMessage,
    );
  }
  @Get(':runId/items/:itemId/files/:fileId')
  @RawResponse()
  async content(
    @Param('runId', uuid) runId: string,
    @Param('itemId', uuid) itemId: string,
    @Param('fileId', uuid) fileId: string,
    @Headers('x-attempt-token') token: string,
    @Query() query: EffectTemplateMixWorkerProjectDto,
    @Res() response: ServerResponse,
  ) {
    const file = await this.service.content(query.projectId, runId, token, itemId, fileId);
    response.setHeader('content-type', file.mimeType);
    response.setHeader('content-length', file.contentLength);
    await pipeline(file.stream, response);
  }
  @Post(':runId/items/:itemId/audio/:role')
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: 100 * 1024 * 1024, files: 1 } }),
    UploadTemporaryFileCleanupInterceptor,
  )
  upload(
    @Param('runId', uuid) runId: string,
    @Param('itemId', uuid) itemId: string,
    @Param('role') role: string,
    @Headers('x-attempt-token') token: string,
    @Body() body: EffectTemplateMixWorkerProjectDto,
    @UploadedFile() file: { path: string; size: number } | undefined,
  ) {
    return this.service.upload(body.projectId, runId, token, itemId, role, file);
  }
}
