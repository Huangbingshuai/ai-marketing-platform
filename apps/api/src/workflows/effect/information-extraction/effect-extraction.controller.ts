import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';

// DTO classes must remain runtime imports so Nest can emit validation metadata.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import {
  ExtractionWorkspaceQueryDto,
  StartExtractionRunDto,
  UpdateExtractionResultDto,
  ValidateExtractionResultDto,
} from './dto/effect-extraction.dto';
// The service class must remain a runtime import for Nest constructor injection metadata.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { EffectExtractionService } from './effect-extraction.service';

@Controller('projects/:projectId/workflows/effect/information-extraction')
export class EffectExtractionController {
  constructor(private readonly service: EffectExtractionService) {}

  @Get()
  workspace(
    @Param('projectId', new ParseUUIDPipe({ version: '4' })) projectId: string,
    @Query() query: ExtractionWorkspaceQueryDto,
  ) {
    return this.service.workspace(projectId, query.draftId);
  }

  @Post('products/:productId/runs')
  @HttpCode(202)
  start(
    @Param('projectId', new ParseUUIDPipe({ version: '4' })) projectId: string,
    @Param('productId', new ParseUUIDPipe({ version: '4' })) productId: string,
    @Body() body: StartExtractionRunDto,
  ) {
    return this.service.start(projectId, productId, body);
  }

  @Get('runs/:runId')
  run(
    @Param('projectId', new ParseUUIDPipe({ version: '4' })) projectId: string,
    @Param('runId', new ParseUUIDPipe({ version: '4' })) runId: string,
  ) {
    return this.service.run(projectId, runId);
  }

  @Get('runs/:runId/nodes/:nodeId')
  nodeDetail(
    @Param('projectId', new ParseUUIDPipe({ version: '4' })) projectId: string,
    @Param('runId', new ParseUUIDPipe({ version: '4' })) runId: string,
    @Param('nodeId') nodeId: string,
  ) {
    return this.service.nodeDetail(projectId, runId, nodeId);
  }

  @Put('results/:resultId')
  updateResult(
    @Param('projectId', new ParseUUIDPipe({ version: '4' })) projectId: string,
    @Param('resultId', new ParseUUIDPipe({ version: '4' })) resultId: string,
    @Body() body: UpdateExtractionResultDto,
  ) {
    return this.service.updateResult(projectId, resultId, body.expectedRevision, body.result);
  }

  @Post('results/:resultId/validate')
  validateResult(
    @Param('projectId', new ParseUUIDPipe({ version: '4' })) projectId: string,
    @Param('resultId', new ParseUUIDPipe({ version: '4' })) resultId: string,
    @Body() body: ValidateExtractionResultDto,
  ) {
    return this.service.validateResult(projectId, resultId, body.expectedRevision);
  }
}
