import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';

// DTOs are runtime imports for Nest validation metadata.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import {
  RegenerateSegmentRenderTasksDto,
  SegmentRenderWorkspaceQueryDto,
  StartSegmentRenderBatchDto,
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

  @Post('batches/:batchId/validate')
  validate(
    @Param('projectId', new ParseUUIDPipe({ version: '4' })) projectId: string,
    @Param('batchId', new ParseUUIDPipe({ version: '4' })) batchId: string,
    @Body() body: ValidateSegmentRenderBatchDto,
  ) {
    return this.service.validate(projectId, batchId, body.expectedBatchRevision);
  }
}
