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
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { IsIn, IsString, MaxLength, MinLength, Matches } from 'class-validator';
import type { EffectVoicePreviewFailure } from '@ai-marketing/contracts';
import { UploadTemporaryFileCleanupInterceptor } from '../../../platform/file/upload-temporary-file-cleanup.interceptor';
import { EffectTemplateMixWorkerGuard } from './effect-template-mix-worker.guard';
import {
  EffectTemplateMixWorkspaceQueryDto,
  EffectTemplateMixWorkerProjectDto,
} from './dto/effect-template-mix.dto';
import { EffectVoiceService } from './effect-voice.service';

export class CreateVoicePreviewDto extends EffectTemplateMixWorkspaceQueryDto {
  @IsString() @Matches(/^[a-zA-Z0-9_-]{1,80}$/) voiceProfileId!: string;
  @IsString() @MinLength(1) @MaxLength(500) idempotencyKey!: string;
}
export class VoiceFailureDto extends EffectTemplateMixWorkerProjectDto {
  @IsIn(['PROVIDER_REJECTED', 'UNAUTHORIZED', 'SUBMISSION_UNKNOWN', 'INVALID_AUDIO'])
  code!: EffectVoicePreviewFailure;
}
const uuid = new ParseUUIDPipe({ version: '4' });
@Controller('projects/:projectId/workflows/effect/template-mix')
export class EffectVoiceController {
  constructor(@Inject(EffectVoiceService) readonly service: EffectVoiceService) {}
  @Get('templates/:templateId/voice-profiles')
  profiles(
    @Param('projectId', uuid) projectId: string,
    @Param('templateId', uuid) templateId: string,
    @Query() query: EffectTemplateMixWorkspaceQueryDto,
  ) {
    return this.service.profiles(projectId, query.workflowRunId, templateId);
  }
  @Get('templates/:templateId/voice-previews')
  list(
    @Param('projectId', uuid) projectId: string,
    @Param('templateId', uuid) templateId: string,
    @Query() query: EffectTemplateMixWorkspaceQueryDto,
  ) {
    return this.service.list(projectId, query.workflowRunId, templateId);
  }
  @Post('templates/:templateId/voice-previews')
  create(
    @Param('projectId', uuid) projectId: string,
    @Param('templateId', uuid) templateId: string,
    @Body() body: CreateVoicePreviewDto,
  ) {
    return this.service.create(projectId, templateId, body);
  }
  @Post('voice-previews/:id/cancel')
  async cancel(@Param('projectId', uuid) projectId: string, @Param('id', uuid) id: string) {
    const row = await this.service.repo.get(projectId, id);
    await this.service.scope(projectId, row.workflowRunId, row.templateId);
    return this.service.present(await this.service.repo.cancel(projectId, id));
  }
}
@Controller('internal/workers/effect-template-mix/voice-previews')
@UseGuards(EffectTemplateMixWorkerGuard)
export class EffectVoiceWorkerController {
  constructor(@Inject(EffectVoiceService) readonly service: EffectVoiceService) {}
  @Post(':id/claim')
  claim(@Param('id', uuid) id: string, @Body() body: EffectTemplateMixWorkerProjectDto) {
    return this.service.repo.claim(body.projectId, id);
  }
  @Put(':id/heartbeat')
  heartbeat(
    @Param('id', uuid) id: string,
    @Headers('x-attempt-token') token: string,
    @Body() body: EffectTemplateMixWorkerProjectDto,
  ) {
    return this.service.repo.heartbeat(body.projectId, id, token);
  }
  @Post(':id/submit')
  submit(
    @Param('id', uuid) id: string,
    @Headers('x-attempt-token') token: string,
    @Body() body: EffectTemplateMixWorkerProjectDto,
  ) {
    return this.service.repo.submit(body.projectId, id, token);
  }
  @Post(':id/fail')
  fail(
    @Param('id', uuid) id: string,
    @Headers('x-attempt-token') token: string,
    @Body() body: VoiceFailureDto,
  ) {
    return this.service.repo.fail(body.projectId, id, token, body.code);
  }
  @Post(':id/audio')
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024, files: 1 } }),
    UploadTemporaryFileCleanupInterceptor,
  )
  upload(
    @Param('id', uuid) id: string,
    @Headers('x-attempt-token') token: string,
    @Body() body: EffectTemplateMixWorkerProjectDto,
    @UploadedFile() file: { path: string; size: number } | undefined,
  ) {
    return this.service.upload(body.projectId, id, token, file);
  }
}
