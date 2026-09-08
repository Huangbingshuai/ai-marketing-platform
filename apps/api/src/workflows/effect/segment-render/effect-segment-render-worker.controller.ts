import type { ServerResponse } from 'node:http';
import { pipeline } from 'node:stream/promises';

import { EFFECT_SEGMENT_RENDER_LIMITS } from '@ai-marketing/contracts';
import {
  Body,
  Controller,
  Get,
  Headers,
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
import { RawResponse } from '../../../common/raw-response.decorator';
import { UploadTemporaryFileCleanupInterceptor } from '../../../platform/file/upload-temporary-file-cleanup.interceptor';
// DTOs are runtime imports for Nest validation metadata.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import {
  SegmentRenderWorkerCompleteDto,
  SegmentRenderWorkerFailDto,
  SegmentRenderWorkerHeartbeatDto,
  SegmentRenderWorkerProjectDto,
  SegmentRenderWorkerReferenceImageQueryDto,
  SegmentRenderWorkerReferenceVideoUrlDto,
} from './dto/effect-segment-render.dto';
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { EffectSegmentRenderService } from './effect-segment-render.service';
import type { UploadedSegmentRenderFile } from './effect-segment-render.types';
import { EffectSegmentRenderWorkerGuard } from './effect-segment-render-worker.guard';

@Controller('internal/workers/effect-segment-render')
@UseGuards(EffectSegmentRenderWorkerGuard)
export class EffectSegmentRenderWorkerController {
  constructor(private readonly service: EffectSegmentRenderService) {}

  @Post('tasks/:taskId/claim')
  claim(
    @Param('taskId', new ParseUUIDPipe({ version: '4' })) taskId: string,
    @Body() body: SegmentRenderWorkerProjectDto,
  ) {
    return this.service.claim(body.projectId, taskId);
  }

  @Get('tasks/:taskId/reference-images/:fileObjectId')
  @RawResponse()
  async referenceImage(
    @Param('taskId', new ParseUUIDPipe({ version: '4' })) taskId: string,
    @Param('fileObjectId', new ParseUUIDPipe({ version: '4' })) fileObjectId: string,
    @Headers('x-attempt-token') attemptToken: string,
    @Query() query: SegmentRenderWorkerReferenceImageQueryDto,
    @Res() response: ServerResponse,
  ): Promise<void> {
    const content = await this.service.referenceImage(
      query.projectId,
      taskId,
      fileObjectId,
      attemptToken,
      query.taskVersion,
    );
    response.statusCode = 200;
    response.setHeader('content-type', content.mimeType);
    response.setHeader('content-length', String(content.contentLength));
    response.setHeader('cache-control', 'private, no-store');
    response.setHeader('x-content-type-options', 'nosniff');
    await pipeline(content.stream, response);
  }

  @Post('tasks/:taskId/reference-video-url')
  referenceVideoUrl(
    @Param('taskId', new ParseUUIDPipe({ version: '4' })) taskId: string,
    @Headers('x-attempt-token') attemptToken: string,
    @Body() body: SegmentRenderWorkerReferenceVideoUrlDto,
  ) {
    return this.service.referenceVideoUrl(body.projectId, taskId, attemptToken, body.taskVersion);
  }

  @Put('tasks/:taskId/heartbeat')
  heartbeat(
    @Param('taskId', new ParseUUIDPipe({ version: '4' })) taskId: string,
    @Headers('x-attempt-token') attemptToken: string,
    @Body() body: SegmentRenderWorkerHeartbeatDto,
  ) {
    return this.service.heartbeat(
      body.projectId,
      taskId,
      attemptToken,
      body.taskVersion,
      body.progress,
      body.providerTaskId,
    );
  }

  @Post('tasks/:taskId/complete')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { files: 1, fileSize: EFFECT_SEGMENT_RENDER_LIMITS.maxUploadBytes },
    }),
    UploadTemporaryFileCleanupInterceptor,
  )
  complete(
    @Param('taskId', new ParseUUIDPipe({ version: '4' })) taskId: string,
    @Headers('x-attempt-token') attemptToken: string,
    @Body() body: SegmentRenderWorkerCompleteDto,
    @UploadedFile() file: UploadedSegmentRenderFile | undefined,
  ) {
    return this.service.complete(body.projectId, taskId, attemptToken, body, file);
  }

  @Post('tasks/:taskId/fail')
  fail(
    @Param('taskId', new ParseUUIDPipe({ version: '4' })) taskId: string,
    @Headers('x-attempt-token') attemptToken: string,
    @Body() body: SegmentRenderWorkerFailDto,
  ) {
    return this.service.fail(body.projectId, taskId, attemptToken, body);
  }
}
