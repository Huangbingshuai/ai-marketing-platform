import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';

// DTOs are runtime imports for Nest validation metadata.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import {
  WorkerCompleteDto,
  WorkerFailDto,
  WorkerProjectDto,
  WorkerShardDto,
  WorkerShardQueryDto,
  WorkerStageDto,
} from './dto/effect-prompt.dto';
import type { EffectPromptShardPhase } from '@ai-marketing/contracts';
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { EffectPromptService } from './effect-prompt.service';
import { EffectPromptWorkerGuard } from './effect-prompt-worker.guard';

@Controller('internal/workers/effect-prompt-generation')
@UseGuards(EffectPromptWorkerGuard)
export class EffectPromptWorkerController {
  constructor(private readonly service: EffectPromptService) {}

  @Post('runs/:runId/claim')
  claim(
    @Param('runId', new ParseUUIDPipe({ version: '4' })) runId: string,
    @Body() body: WorkerProjectDto,
  ) {
    return this.service.claim(body.projectId, runId);
  }

  @Put('runs/:runId/heartbeat')
  heartbeat(
    @Param('runId', new ParseUUIDPipe({ version: '4' })) runId: string,
    @Headers('x-attempt-token') attemptToken: string,
    @Body() body: WorkerProjectDto,
  ) {
    return this.service.heartbeat(body.projectId, runId, attemptToken);
  }

  @Put('runs/:runId/stages/:nodeId')
  stage(
    @Param('runId', new ParseUUIDPipe({ version: '4' })) runId: string,
    @Param('nodeId') nodeId: string,
    @Headers('x-attempt-token') attemptToken: string,
    @Body() body: WorkerStageDto,
  ) {
    return this.service.saveStage(body.projectId, runId, attemptToken, nodeId, body);
  }

  @Put('runs/:runId/shards/:round/:shardIndex')
  legacyPromptShard(
    @Param('runId', new ParseUUIDPipe({ version: '4' })) runId: string,
    @Param('round', ParseIntPipe) round: number,
    @Param('shardIndex', ParseIntPipe) shardIndex: number,
    @Headers('x-attempt-token') attemptToken: string,
    @Body() body: WorkerShardDto,
  ) {
    return this.service.saveShard(
      body.projectId,
      runId,
      attemptToken,
      round,
      shardIndex,
      'PROMPT',
      body,
    );
  }

  @Put('runs/:runId/shards/:phase/:round/:shardIndex')
  shard(
    @Param('runId', new ParseUUIDPipe({ version: '4' })) runId: string,
    @Param('phase') phase: EffectPromptShardPhase,
    @Param('round', ParseIntPipe) round: number,
    @Param('shardIndex', ParseIntPipe) shardIndex: number,
    @Headers('x-attempt-token') attemptToken: string,
    @Body() body: WorkerShardDto,
  ) {
    return this.service.saveShard(
      body.projectId,
      runId,
      attemptToken,
      round,
      shardIndex,
      phase,
      body,
    );
  }

  @Get('runs/:runId/shards')
  shards(
    @Param('runId', new ParseUUIDPipe({ version: '4' })) runId: string,
    @Headers('x-attempt-token') attemptToken: string,
    @Query() query: WorkerShardQueryDto,
  ) {
    return this.service.shards(query.projectId, runId, attemptToken, query.phase);
  }

  @Post('runs/:runId/complete')
  complete(
    @Param('runId', new ParseUUIDPipe({ version: '4' })) runId: string,
    @Headers('x-attempt-token') attemptToken: string,
    @Body() body: WorkerCompleteDto,
  ) {
    return this.service.complete(body.projectId, runId, attemptToken, body);
  }

  @Post('runs/:runId/fail')
  fail(
    @Param('runId', new ParseUUIDPipe({ version: '4' })) runId: string,
    @Headers('x-attempt-token') attemptToken: string,
    @Body() body: WorkerFailDto,
  ) {
    return this.service.fail(body.projectId, runId, attemptToken, body);
  }
}
