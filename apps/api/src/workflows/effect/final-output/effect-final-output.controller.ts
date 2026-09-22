import { Body, Controller, Get, Headers, Inject, Param, ParseUUIDPipe, Post, Put, Query, Res, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { pipeline } from 'node:stream/promises';
import type { ServerResponse } from 'node:http';
import { RawResponse } from '../../../common/raw-response.decorator';
import { UploadTemporaryFileCleanupInterceptor } from '../../../platform/file/upload-temporary-file-cleanup.interceptor';
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { EffectTemplateMixRevisionDto, EffectTemplateMixWorkerProjectDto, EffectTemplateMixWorkspaceQueryDto } from '../template-mix/dto/effect-template-mix.dto';
import { EffectTemplateMixWorkerGuard } from '../template-mix/effect-template-mix-worker.guard';
import { EffectFinalOutputService } from './effect-final-output.service';

export class CompletePackagingDto extends EffectTemplateMixRevisionDto {
  @IsString() @MinLength(1) @MaxLength(500) idempotencyKey!: string;
}
export class OutputProgressDto extends EffectTemplateMixWorkerProjectDto {
  @IsInt() @Min(0) @Max(99) progress!: number;
  @IsOptional() @IsString() @MaxLength(300) errorMessage?: string;
}
const uuid = new ParseUUIDPipe({ version: '4' });

@Controller('projects/:projectId/workflows/effect')
export class EffectFinalOutputController {
  constructor(@Inject(EffectFinalOutputService) readonly service: EffectFinalOutputService) {}
  @Post('template-mix/templates/:templateId/complete-packaging')
  complete(@Param('projectId', uuid) projectId: string, @Param('templateId', uuid) templateId: string, @Body() body: CompletePackagingDto) {
    return this.service.complete(projectId, templateId, body);
  }
  @Get('final-output')
  list(@Param('projectId', uuid) projectId: string, @Query() query: EffectTemplateMixWorkspaceQueryDto) { return this.service.list(projectId, query.workflowRunId); }
  @Get('final-output/:runId')
  get(@Param('projectId', uuid) projectId: string, @Param('runId', uuid) runId: string) { return this.service.get(projectId, runId); }
  @Post('final-output/:runId/retry')
  retry(@Param('projectId', uuid) projectId: string, @Param('runId', uuid) runId: string) { return this.service.retry(projectId, runId); }
  @Post('final-output/:runId/cancel')
  cancel(@Param('projectId', uuid) projectId: string, @Param('runId', uuid) runId: string) { return this.service.cancel(projectId, runId); }
}

@Controller('internal/workers/effect-template-mix/final-output-runs')
@UseGuards(EffectTemplateMixWorkerGuard)
export class EffectFinalOutputWorkerController {
  constructor(@Inject(EffectFinalOutputService) readonly service: EffectFinalOutputService) {}
  @Post(':runId/claim')
  claim(@Param('runId', uuid) runId: string, @Body() body: EffectTemplateMixWorkerProjectDto) { return this.service.claim(body.projectId, runId); }
  @Put(':runId/heartbeat')
  heartbeat(@Param('runId', uuid) runId: string, @Headers('x-attempt-token') token: string, @Body() body: EffectTemplateMixWorkerProjectDto) { return this.service.heartbeat(body.projectId, runId, token); }
  @Post(':runId/finish')
  finish(@Param('runId', uuid) runId: string, @Headers('x-attempt-token') token: string, @Body() body: EffectTemplateMixWorkerProjectDto) { return this.service.finish(body.projectId, runId, token); }
  @Put(':runId/items/:itemId/progress')
  progress(@Param('runId', uuid) runId: string, @Param('itemId', uuid) itemId: string, @Headers('x-attempt-token') token: string, @Body() body: OutputProgressDto) {
    return this.service.progress(body.projectId, runId, token, itemId, body.progress, body.errorMessage);
  }
  @Get(':runId/items/:itemId/files/:fileId')
  @RawResponse()
  async content(@Param('runId', uuid) runId: string, @Param('itemId', uuid) itemId: string, @Param('fileId', uuid) fileId: string, @Headers('x-attempt-token') token: string, @Query() query: EffectTemplateMixWorkerProjectDto, @Res() response: ServerResponse) {
    const file = await this.service.content(query.projectId, runId, token, itemId, fileId);
    response.setHeader('content-type', file.mimeType); response.setHeader('content-length', file.contentLength);
    await pipeline(file.stream, response);
  }
  @Post(':runId/items/:itemId/video')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 2_000_000_000, files: 1 } }), UploadTemporaryFileCleanupInterceptor)
  upload(@Param('runId', uuid) runId: string, @Param('itemId', uuid) itemId: string, @Headers('x-attempt-token') token: string, @Body() body: EffectTemplateMixWorkerProjectDto, @UploadedFile() file?: { path: string; size: number }) {
    return this.service.upload(body.projectId, runId, token, itemId, file);
  }
}
