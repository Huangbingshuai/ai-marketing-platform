import { pipeline } from 'node:stream/promises';
import type { ServerResponse } from 'node:http';
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
  UseGuards,
} from '@nestjs/common';
import { RawResponse } from '../../../common/raw-response.decorator';
import { fileContentDisposition } from '../../../platform/file/content-disposition';
import type {
  EffectTemplateMixWorkerClassificationDto,
  EffectTemplateMixWorkerCompleteDto,
  EffectTemplateMixWorkerFailDto,
  EffectTemplateMixWorkerProgressDto,
  EffectTemplateMixWorkerProjectDto,
} from './dto/effect-template-mix.dto';
import { EffectTemplateMixService } from './effect-template-mix.service';
import { EffectTemplateMixWorkerGuard } from './effect-template-mix-worker.guard';

@Controller('internal/workers/effect-template-mix')
@UseGuards(EffectTemplateMixWorkerGuard)
export class EffectTemplateMixWorkerController {
  constructor(
    @Inject(EffectTemplateMixService) private readonly service: EffectTemplateMixService,
  ) {}

  @Post('runs/:runId/claim')
  claim(
    @Param('runId', new ParseUUIDPipe({ version: '4' })) runId: string,
    @Body() body: EffectTemplateMixWorkerProjectDto,
  ) {
    return this.service.claimAiRun(body.projectId, runId);
  }

  @Put('runs/:runId/progress')
  progress(
    @Param('runId', new ParseUUIDPipe({ version: '4' })) runId: string,
    @Headers('x-attempt-token') attemptToken: string,
    @Body() body: EffectTemplateMixWorkerProgressDto,
  ) {
    return this.service.updateAiProgress(
      body.projectId,
      runId,
      attemptToken,
      body.stage,
      body.progress,
    );
  }

  @Post('runs/:runId/classifications')
  classify(
    @Param('runId', new ParseUUIDPipe({ version: '4' })) runId: string,
    @Headers('x-attempt-token') attemptToken: string,
    @Body() body: EffectTemplateMixWorkerClassificationDto,
  ) {
    return this.service.classifyAiRun(body.projectId, runId, attemptToken, body.classifications);
  }

  @Put('runs/:runId/classifications/checkpoint')
  checkpointClassifications(
    @Param('runId', new ParseUUIDPipe({ version: '4' })) runId: string,
    @Headers('x-attempt-token') attemptToken: string,
    @Body() body: EffectTemplateMixWorkerClassificationDto,
  ) {
    return this.service.checkpointAiClassifications(
      body.projectId,
      runId,
      attemptToken,
      body.classifications,
    );
  }

  @Put('runs/:runId/trims/checkpoint')
  checkpointTrims(
    @Param('runId', new ParseUUIDPipe({ version: '4' })) runId: string,
    @Headers('x-attempt-token') attemptToken: string,
    @Body() body: EffectTemplateMixWorkerCompleteDto,
  ) {
    return this.service.checkpointAiTrims(body.projectId, runId, attemptToken, body.trims);
  }

  @Post('runs/:runId/complete')
  complete(
    @Param('runId', new ParseUUIDPipe({ version: '4' })) runId: string,
    @Headers('x-attempt-token') attemptToken: string,
    @Body() body: EffectTemplateMixWorkerCompleteDto,
  ) {
    return this.service.completeAiRun(body.projectId, runId, attemptToken, body.trims);
  }

  @Post('runs/:runId/fail')
  fail(
    @Param('runId', new ParseUUIDPipe({ version: '4' })) runId: string,
    @Headers('x-attempt-token') attemptToken: string,
    @Body() body: EffectTemplateMixWorkerFailDto,
  ) {
    return this.service.failAiRun(
      body.projectId,
      runId,
      attemptToken,
      body.errorCode,
      body.errorMessage,
      body.retryable,
    );
  }

  @Get('runs/:runId/materials/:materialId/content')
  @RawResponse()
  async material(
    @Param('runId', new ParseUUIDPipe({ version: '4' })) runId: string,
    @Param('materialId', new ParseUUIDPipe({ version: '4' })) materialId: string,
    @Headers('x-attempt-token') attemptToken: string,
    @Query() query: EffectTemplateMixWorkerProjectDto,
    @Res() response: ServerResponse,
  ): Promise<void> {
    const source = await this.service.aiVideo(query.projectId, runId, materialId, attemptToken);
    response.statusCode = 200;
    response.setHeader('content-type', source.mimeType);
    response.setHeader('content-length', String(source.contentLength));
    response.setHeader(
      'content-disposition',
      fileContentDisposition('attachment', source.originalFileName),
    );
    response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader('cache-control', 'private, no-store');
    await pipeline(source.stream, response);
  }
}
