import { EFFECT_SEGMENT_RENDER_LIMITS } from '@ai-marketing/contracts';
import {
  Body,
  Controller,
  Headers,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { UploadTemporaryFileCleanupInterceptor } from '../../../platform/file/upload-temporary-file-cleanup.interceptor';
// DTOs are runtime imports for Nest validation metadata.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import {
  SegmentRenderWorkerCompleteDto,
  SegmentRenderWorkerFailDto,
  SegmentRenderWorkerHeartbeatDto,
  SegmentRenderWorkerProjectDto,
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
