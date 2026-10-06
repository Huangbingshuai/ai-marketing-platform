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
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Matches,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import type {
  PackagingCheckpoint,
  PackagingComponent,
  PackagingStage,
} from '@ai-marketing/contracts';
import { PACKAGING_AUDIO_GAIN_CEILING, PACKAGING_STAGES } from '@ai-marketing/contracts';
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
import { SourceTrimsDto } from './dto/effect-source-trims.dto';

export class CreatePackagingDto extends EffectTemplateMixRevisionDto {
  @IsString() @MinLength(1) @MaxLength(500) idempotencyKey!: string;
  @IsOptional() @IsUUID('4') variantId?: string;
  @IsOptional() @IsIn(['ALL', 'VOICE', 'MUSIC', 'CAPTIONS']) component?: PackagingComponent;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(100) slotId?: string;
}
export class PackagingAudioUploadDto extends EffectTemplateMixWorkerProjectDto {
  @IsOptional() @IsString() @MaxLength(2500) segmentFrames?: string;
  @IsOptional() @IsString() @MaxLength(32000) speechRanges?: string;
}
/** `text` is an assertion the server checks against the caption it will actually speak. */
export class CreatePackagingCaptionVoiceDto {
  @IsString() @Matches(/^[a-zA-Z0-9_-]{1,50}$/u) captionId!: string;
  @IsString() @MaxLength(500) text!: string;
}
export class PackagingCaptionVoiceWriteDto extends EffectTemplateMixWorkerProjectDto {
  @IsString() @Matches(/^[a-zA-Z0-9_-]{1,50}$/u) captionId!: string;
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
  // Up to the shared +20 dB ceiling (10× gain), so the editor's dB row can reach its own top end.
  @Type(() => Number) @IsNumber() @Min(0) @Max(PACKAGING_AUDIO_GAIN_CEILING) volume!: number;
  /** Editor-only; absent keeps the pipeline default (`final_output.py`), so old clients stay valid. */
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) fadeIn?: number;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) fadeOut?: number;
}
export class PackagingCaptionEditDto {
  @IsString() @MinLength(1) @MaxLength(50) id!: string;
  // Blank text is valid only for a newly-created editor draft; the domain validator
  // enforces that generated/narration captions remain non-empty.
  @IsString() @MaxLength(500) text!: string;
  @Type(() => Number) @IsNumber() @Min(0) start!: number;
  @Type(() => Number) @IsNumber() @Min(0) end!: number;
  @IsOptional() @IsBoolean() manual?: boolean;
  // `null` is the implicit caption row, so it is a value rather than an omission; `@IsOptional()`
  // skips both, which is what lets a clear and a "leave it alone" travel through one field.
  @IsOptional() @IsString() @Matches(/^[a-zA-Z0-9_-]{1,80}$/u) trackId?: string | null;
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
  @IsOptional() @Type(() => Number) @IsInt() @Min(8) @Max(48) captionFontSize?: number;
  @IsOptional() @IsObject() voices?: Record<string, PackagingAudioEditDto>;
  // A generated caption narration is moved and trimmed exactly like a script-line voice, so it
  // takes the same per-clip shape and is keyed by caption id. Same as `voices`, the values are
  // checked in the service, which owns the real source lengths.
  @IsOptional() @IsObject() captionVoices?: Record<string, PackagingAudioEditDto>;
  @IsOptional() @ValidateNested() @Type(() => PackagingAudioEditDto) music?: PackagingAudioEditDto;
  // A delete cannot be expressed as a geometry edit — there is no clip left to send — so each kind
  // that may go carries its own removal channel. Ids are checked for shape only: the service ignores
  // one it does not know, which is what a delete racing a redo looks like.
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @Matches(/^[a-zA-Z0-9_-]{1,80}$/u, { each: true })
  removedVoices?: string[];
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @Matches(/^[a-zA-Z0-9_-]{1,80}$/u, { each: true })
  removedCaptionVoices?: string[];
  @IsOptional() @IsBoolean() removeMusic?: boolean;
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
  @Get('templates/:templateId/background-packaging-run')
  background(
    @Param('projectId', uuid) projectId: string,
    @Param('templateId', uuid) templateId: string,
    @Query() query: EffectTemplateMixWorkspaceQueryDto,
  ) {
    return this.service.latestBackground(projectId, query.workflowRunId, templateId);
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
  @Post('packaging-runs/:runId/items/:itemId/caption-voice')
  requestCaptionVoice(
    @Param('projectId', uuid) projectId: string,
    @Param('runId', uuid) runId: string,
    @Param('itemId', uuid) itemId: string,
    @Body() body: CreatePackagingCaptionVoiceDto,
  ) {
    return this.service.requestCaptionVoice(projectId, runId, itemId, body);
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
  @Put(':runId/items/:itemId/trims')
  trims(@Param('runId', uuid) runId: string, @Param('itemId', uuid) itemId: string,
    @Headers('x-attempt-token') token: string, @Body() body: SourceTrimsDto) {
    return this.service.sourceTrims(body.projectId, runId, token, itemId, body.trims);
  }
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
    return this.service.finish(body.projectId, runId, token);
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
    @Body() body: PackagingAudioUploadDto,
    @UploadedFile() file: { path: string; size: number } | undefined,
  ) {
    return this.service.upload(
      body.projectId,
      runId,
      token,
      itemId,
      role,
      file,
      body.segmentFrames,
      body.speechRanges,
    );
  }
}

/**
 * The editor-triggered caption narration has no packaging run to hold a lease on, so it lives on
 * its own route: the worker token is the whole guard, and the item's own caption list decides
 * whether the write is legal.
 */
@Controller('internal/workers/effect-template-mix/caption-voices')
@UseGuards(EffectTemplateMixWorkerGuard)
export class EffectPackagingCaptionVoiceController {
  constructor(@Inject(EffectPackagingService) readonly service: EffectPackagingService) {}
  @Post(':runId/items/:itemId/audio')
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: 100 * 1024 * 1024, files: 1 } }),
    UploadTemporaryFileCleanupInterceptor,
  )
  upload(
    @Param('runId', uuid) runId: string,
    @Param('itemId', uuid) itemId: string,
    @Body() body: PackagingCaptionVoiceWriteDto,
    @UploadedFile() file: { path: string; size: number } | undefined,
  ) {
    return this.service.uploadCaptionVoice(body.projectId, runId, itemId, body.captionId, file);
  }
}
