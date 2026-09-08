import type { ServerResponse } from 'node:http';
import { pipeline } from 'node:stream/promises';

import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Res,
} from '@nestjs/common';
import { RawResponse } from '../../../common/raw-response.decorator';
import { fileContentDisposition } from '../../../platform/file/content-disposition';

// DTOs are runtime imports for Nest validation metadata.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import {
  RegenerateSegmentRenderTasksDto,
  DecideSegmentRenderRepairDto,
  SaveSegmentRenderSettingsDto,
  SegmentRenderWorkspaceQueryDto,
  StartSegmentRenderBatchDto,
  StartSegmentRenderRepairDto,
  SegmentRenderTaskContentQueryDto,
  ValidateSegmentRenderBatchDto,
} from './dto/effect-segment-render.dto';
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { EffectSegmentRenderService } from './effect-segment-render.service';

@Controller('projects/:projectId/workflows/effect/segment-render')
export class EffectSegmentRenderController {
  constructor(private readonly service: EffectSegmentRenderService) {}

  @Get('products/:productId')
  workspace(
    @Param('projectId', new ParseUUIDPipe({ version: '4' })) projectId: string,
    @Param('productId', new ParseUUIDPipe({ version: '4' })) productId: string,
    @Query() query: SegmentRenderWorkspaceQueryDto,
  ) {
    return this.service.workspace(projectId, query.workflowRunId, productId);
  }

  @Put('products/:productId/settings')
  saveSettings(
    @Param('projectId', new ParseUUIDPipe({ version: '4' })) projectId: string,
    @Param('productId', new ParseUUIDPipe({ version: '4' })) productId: string,
    @Body() body: SaveSegmentRenderSettingsDto,
  ) {
    return this.service.saveSettings(
      projectId,
      productId,
      body.workflowRunId,
      body.expectedRevision,
      body.settings,
    );
  }

  @Post('products/:productId/batches')
  @HttpCode(202)
  start(
    @Param('projectId', new ParseUUIDPipe({ version: '4' })) projectId: string,
    @Param('productId', new ParseUUIDPipe({ version: '4' })) productId: string,
    @Body() body: StartSegmentRenderBatchDto,
  ) {
    return this.service.start(projectId, productId, body);
  }

  @Get('batches/:batchId')
  batch(
    @Param('projectId', new ParseUUIDPipe({ version: '4' })) projectId: string,
    @Param('batchId', new ParseUUIDPipe({ version: '4' })) batchId: string,
  ) {
    return this.service.batch(projectId, batchId);
  }

  @Post('batches/:batchId/tasks/regenerate')
  @HttpCode(202)
  regenerate(
    @Param('projectId', new ParseUUIDPipe({ version: '4' })) projectId: string,
    @Param('batchId', new ParseUUIDPipe({ version: '4' })) batchId: string,
    @Body() body: RegenerateSegmentRenderTasksDto,
  ) {
    return this.service.regenerate(
      projectId,
      batchId,
      body.taskIds,
      body.expectedBatchRevision,
      body.idempotencyKey,
    );
  }

  @Post('batches/:batchId/tasks/:taskId/repair')
  @HttpCode(202)
  startRepair(
    @Param('projectId', new ParseUUIDPipe({ version: '4' })) projectId: string,
    @Param('batchId', new ParseUUIDPipe({ version: '4' })) batchId: string,
    @Param('taskId', new ParseUUIDPipe({ version: '4' })) taskId: string,
    @Body() body: StartSegmentRenderRepairDto,
  ) {
    return this.service.startRepair(projectId, batchId, taskId, body);
  }

  @Post('batches/:batchId/tasks/:taskId/repair/decision')
  decideRepair(
    @Param('projectId', new ParseUUIDPipe({ version: '4' })) projectId: string,
    @Param('batchId', new ParseUUIDPipe({ version: '4' })) batchId: string,
    @Param('taskId', new ParseUUIDPipe({ version: '4' })) taskId: string,
    @Body() body: DecideSegmentRenderRepairDto,
  ) {
    return this.service.decideRepair(
      projectId,
      batchId,
      taskId,
      body.expectedBatchRevision,
      body.repairVersion,
      body.decision,
      body.idempotencyKey,
    );
  }

  @Get('batches/:batchId/tasks/:taskId/content')
  @RawResponse()
  async taskContent(
    @Param('projectId', new ParseUUIDPipe({ version: '4' })) projectId: string,
    @Param('batchId', new ParseUUIDPipe({ version: '4' })) batchId: string,
    @Param('taskId', new ParseUUIDPipe({ version: '4' })) taskId: string,
    @Headers('range') range: string | undefined,
    @Query() query: SegmentRenderTaskContentQueryDto,
    @Res() response: ServerResponse,
  ): Promise<void> {
    const content = await this.service.taskContent(
      projectId,
      batchId,
      taskId,
      query.variant,
      range,
    );
    response.statusCode = content.partial ? 206 : 200;
    response.setHeader('content-type', content.mimeType);
    response.setHeader('content-length', String(content.contentLength));
    response.setHeader(
      'content-disposition',
      fileContentDisposition('inline', content.originalFileName),
    );
    response.setHeader('accept-ranges', 'bytes');
    response.setHeader('cache-control', 'private, no-store');
    response.setHeader('x-content-type-options', 'nosniff');
    if (content.partial)
      response.setHeader(
        'content-range',
        `bytes ${content.start}-${content.end}/${content.sizeBytes}`,
      );
    await pipeline(content.stream, response);
  }

  @Post('batches/:batchId/validate')
  validate(
    @Param('projectId', new ParseUUIDPipe({ version: '4' })) projectId: string,
    @Param('batchId', new ParseUUIDPipe({ version: '4' })) batchId: string,
    @Body() body: ValidateSegmentRenderBatchDto,
  ) {
    return this.service.validate(projectId, batchId, body.expectedBatchRevision);
  }
}
