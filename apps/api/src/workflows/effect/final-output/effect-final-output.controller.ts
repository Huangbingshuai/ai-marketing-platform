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
import {
  IsArray,
  IsBoolean,
  ArrayUnique,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { FINAL_OUTPUT_RESOLUTIONS, PACKAGING_STAGES } from '@ai-marketing/contracts';
import type { PackagingCheckpoint, PackagingStage } from '@ai-marketing/contracts';
import { pipeline } from 'node:stream/promises';
import type { ServerResponse } from 'node:http';
import { RawResponse } from '../../../common/raw-response.decorator';
import { UploadTemporaryFileCleanupInterceptor } from '../../../platform/file/upload-temporary-file-cleanup.interceptor';
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import {
  EffectTemplateMixWorkerProjectDto,
  EffectTemplateMixWorkspaceQueryDto,
} from '../template-mix/dto/effect-template-mix.dto';
import { EffectTemplateMixWorkerGuard } from '../template-mix/effect-template-mix-worker.guard';
import { EffectFinalOutputService } from './effect-final-output.service';
import { SourceTrimsDto } from '../template-mix/dto/effect-source-trims.dto';

export class SyncFinalOutputDto {
  @IsUUID('4') workflowRunId!: string;
  @IsOptional() @IsUUID('4') templateId?: string;
  @IsOptional() @IsInt() @Min(0) expectedDraftRevision?: number;
}
export class LocalUpdateFinalOutputDto {
  @IsArray() @ArrayUnique() @IsUUID('4', { each: true }) itemIds!: string[];
  @IsOptional() @IsBoolean() syncProjects?: boolean;
}
export class StartFinalOutputDto {
  @IsIn(FINAL_OUTPUT_RESOLUTIONS) resolution!: (typeof FINAL_OUTPUT_RESOLUTIONS)[number];
  @IsIn([24, 25, 30, 50, 60]) frameRate!: 24 | 25 | 30 | 50 | 60;
}
export class OutputProgressDto extends EffectTemplateMixWorkerProjectDto {
  @IsInt() @Min(0) @Max(99) progress!: number;
  @IsOptional() @IsString() @MaxLength(300) errorMessage?: string;
}
const uuid = new ParseUUIDPipe({ version: '4' });
class SourceCheckpointDto extends EffectTemplateMixWorkerProjectDto {
  @IsIn(PACKAGING_STAGES) stage!: PackagingStage;
  @IsObject() checkpoint!: PackagingCheckpoint;
}
class SourceAudioDto extends EffectTemplateMixWorkerProjectDto {
  @IsOptional() @IsString() @MaxLength(2500) segmentFrames?: string;
  @IsOptional() @IsString() @MaxLength(32000) speechRanges?: string;
}

@Controller('projects/:projectId/workflows/effect')
export class EffectFinalOutputController {
  constructor(@Inject(EffectFinalOutputService) readonly service: EffectFinalOutputService) {}
  @Get('final-output')
  list(
    @Param('projectId', uuid) projectId: string,
    @Query() query: EffectTemplateMixWorkspaceQueryDto,
  ) {
    return this.service.list(projectId, query.workflowRunId);
  }
  @Get('final-output/:runId')
  get(@Param('projectId', uuid) projectId: string, @Param('runId', uuid) runId: string) {
    return this.service.get(projectId, runId);
  }
  @Post('final-output/:runId/render')
  render(
    @Param('projectId', uuid) projectId: string,
    @Param('runId', uuid) runId: string,
    @Body() body: StartFinalOutputDto,
  ) {
    return this.service.start(projectId, runId, body);
  }
  @Post('final-output/sync')
  sync(@Param('projectId', uuid) projectId: string, @Body() body: SyncFinalOutputDto) {
    return this.service.syncFromDraft(projectId, body.workflowRunId, body);
  }
  @Post('final-output/:runId/local-update')
  localUpdate(
    @Param('projectId', uuid) projectId: string,
    @Param('runId', uuid) runId: string,
    @Body() body: LocalUpdateFinalOutputDto,
  ) {
    return this.service.localUpdate(projectId, runId, body);
  }
  @Post('final-output/:runId/items/:itemId/render')
  renderItem(
    @Param('projectId', uuid) projectId: string,
    @Param('runId', uuid) runId: string,
    @Param('itemId', uuid) itemId: string,
  ) {
    return this.service.renderItem(projectId, runId, itemId);
  }
  @Post('final-output/:runId/retry')
  retry(@Param('projectId', uuid) projectId: string, @Param('runId', uuid) runId: string) {
    return this.service.retry(projectId, runId);
  }
  @Post('final-output/:runId/cancel')
  cancel(@Param('projectId', uuid) projectId: string, @Param('runId', uuid) runId: string) {
    return this.service.cancel(projectId, runId);
  }
}

@Controller('internal/workers/effect-template-mix/final-output-runs')
@UseGuards(EffectTemplateMixWorkerGuard)
export class EffectFinalOutputWorkerController {
  constructor(@Inject(EffectFinalOutputService) readonly service: EffectFinalOutputService) {}
  @Put(':runId/items/:itemId/trims')
  trims(@Param('runId', uuid) runId: string, @Param('itemId', uuid) itemId: string,
    @Headers('x-attempt-token') token: string, @Body() body: SourceTrimsDto) {
    return this.service.refreshTrims(body.projectId, runId, token, itemId, body.trims);
  }
  @Put(':runId/items/:itemId/checkpoint')
  checkpoint(@Param('runId', uuid) runId: string, @Param('itemId', uuid) itemId: string,
    @Headers('x-attempt-token') token: string, @Body() body: SourceCheckpointDto) {
    return this.service.refreshCheckpoint(body.projectId, runId, token, itemId, body.stage, body.checkpoint);
  }
  @Post(':runId/items/:itemId/audio/:role')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 100 * 1024 * 1024, files: 1 } }),
    UploadTemporaryFileCleanupInterceptor)
  audio(@Param('runId', uuid) runId: string, @Param('itemId', uuid) itemId: string,
    @Param('role') role: string, @Headers('x-attempt-token') token: string,
    @Body() body: SourceAudioDto, @UploadedFile() file?: { path: string; size: number }) {
    return this.service.refreshAudio(body.projectId, runId, token, itemId, role, file, body.segmentFrames, body.speechRanges);
  }
  @Post(':runId/claim')
  claim(@Param('runId', uuid) runId: string, @Body() body: EffectTemplateMixWorkerProjectDto) {
    return this.service.claim(body.projectId, runId);
  }
  @Put(':runId/heartbeat')
  heartbeat(
    @Param('runId', uuid) runId: string,
    @Headers('x-attempt-token') token: string,
    @Body() body: EffectTemplateMixWorkerProjectDto,
  ) {
    return this.service.heartbeat(body.projectId, runId, token);
  }
  @Post(':runId/finish')
  finish(
    @Param('runId', uuid) runId: string,
    @Headers('x-attempt-token') token: string,
    @Body() body: EffectTemplateMixWorkerProjectDto,
  ) {
    return this.service.finish(body.projectId, runId, token);
  }
  @Post(':runId/items/:itemId/complete-source-refresh')
  completeProjectRefresh(@Param('runId', uuid) runId: string, @Param('itemId', uuid) itemId: string,
    @Headers('x-attempt-token') token: string, @Body() body: EffectTemplateMixWorkerProjectDto) {
    return this.service.completeProjectRefresh(body.projectId, runId, token, itemId);
  }
  @Put(':runId/items/:itemId/progress')
  progress(
    @Param('runId', uuid) runId: string,
    @Param('itemId', uuid) itemId: string,
    @Headers('x-attempt-token') token: string,
    @Body() body: OutputProgressDto,
  ) {
    return this.service.progress(
      body.projectId,
      runId,
      token,
      itemId,
      body.progress,
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
    response.setHeader('x-content-sha256', file.sha256);
    await pipeline(file.stream, response);
  }
  @Post(':runId/items/:itemId/video')
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: 2_000_000_000, files: 1 } }),
    UploadTemporaryFileCleanupInterceptor,
  )
  upload(
    @Param('runId', uuid) runId: string,
    @Param('itemId', uuid) itemId: string,
    @Headers('x-attempt-token') token: string,
    @Body() body: EffectTemplateMixWorkerProjectDto,
    @UploadedFile() file?: { path: string; size: number },
  ) {
    return this.service.upload(body.projectId, runId, token, itemId, file);
  }
}
