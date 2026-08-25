import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';

// DTOs are runtime imports for Nest validation metadata.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import {
  DeletePromptItemDto,
  PromptItemDto,
  PromptResultQueryDto,
  PromptWorkspaceQueryDto,
  SavePromptSettingsDto,
  StartPromptRunDto,
  ValidatePromptResultDto,
} from './dto/effect-prompt.dto';
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { EffectPromptService } from './effect-prompt.service';

const expectedRevision = (ifMatch: string | undefined, fallback: number): number => {
  if (!ifMatch) return fallback;
  const normalized = ifMatch.replace(/^W\//u, '').replaceAll('"', '').trim();
  const value = Number(normalized);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
};

@Controller('projects/:projectId/workflows/effect/prompt-generation')
export class EffectPromptController {
  constructor(private readonly service: EffectPromptService) {}

  @Get()
  workspace(
    @Param('projectId', new ParseUUIDPipe({ version: '4' })) projectId: string,
    @Query() query: PromptWorkspaceQueryDto,
  ) {
    return this.service.workspace(projectId, query.workflowRunId);
  }

  @Put('products/:productId/settings')
  saveSettings(
    @Param('projectId', new ParseUUIDPipe({ version: '4' })) projectId: string,
    @Param('productId', new ParseUUIDPipe({ version: '4' })) productId: string,
    @Body() body: SavePromptSettingsDto,
  ) {
    return this.service.saveSettings(
      projectId,
      productId,
      body.workflowRunId,
      body.expectedRevision,
      body.settings,
    );
  }

  @Get('products/:productId/result')
  result(
    @Param('projectId', new ParseUUIDPipe({ version: '4' })) projectId: string,
    @Param('productId', new ParseUUIDPipe({ version: '4' })) productId: string,
    @Query() query: PromptResultQueryDto,
  ) {
    return this.service.result(
      projectId,
      query.workflowRunId,
      productId,
      query.page,
      query.pageSize,
      query.query,
      query.fragmentType,
    );
  }

  @Post('products/:productId/runs')
  @HttpCode(202)
  start(
    @Param('projectId', new ParseUUIDPipe({ version: '4' })) projectId: string,
    @Param('productId', new ParseUUIDPipe({ version: '4' })) productId: string,
    @Body() body: StartPromptRunDto,
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

  @Post('results/:resultId/items')
  addItem(
    @Param('projectId', new ParseUUIDPipe({ version: '4' })) projectId: string,
    @Param('resultId', new ParseUUIDPipe({ version: '4' })) resultId: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body() body: PromptItemDto,
  ) {
    return this.service.addItem(
      projectId,
      resultId,
      expectedRevision(ifMatch, body.expectedRevision),
      body,
    );
  }

  @Put('results/:resultId/items/:itemId')
  updateItem(
    @Param('projectId', new ParseUUIDPipe({ version: '4' })) projectId: string,
    @Param('resultId', new ParseUUIDPipe({ version: '4' })) resultId: string,
    @Param('itemId', new ParseUUIDPipe({ version: '4' })) itemId: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body() body: PromptItemDto,
  ) {
    return this.service.updateItem(
      projectId,
      resultId,
      itemId,
      expectedRevision(ifMatch, body.expectedRevision),
      body,
    );
  }

  @Delete('results/:resultId/items/:itemId')
  deleteItem(
    @Param('projectId', new ParseUUIDPipe({ version: '4' })) projectId: string,
    @Param('resultId', new ParseUUIDPipe({ version: '4' })) resultId: string,
    @Param('itemId', new ParseUUIDPipe({ version: '4' })) itemId: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body() body: DeletePromptItemDto,
  ) {
    return this.service.deleteItem(
      projectId,
      resultId,
      itemId,
      expectedRevision(ifMatch, body.expectedRevision),
    );
  }

  @Post('results/:resultId/validate')
  validateResult(
    @Param('projectId', new ParseUUIDPipe({ version: '4' })) projectId: string,
    @Param('resultId', new ParseUUIDPipe({ version: '4' })) resultId: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body() body: ValidatePromptResultDto,
  ) {
    return this.service.validateResult(
      projectId,
      resultId,
      expectedRevision(ifMatch, body.expectedRevision),
    );
  }

  @Get('results/:resultId/export')
  exportResult(
    @Param('projectId', new ParseUUIDPipe({ version: '4' })) projectId: string,
    @Param('resultId', new ParseUUIDPipe({ version: '4' })) resultId: string,
  ) {
    return this.service.exportResult(projectId, resultId);
  }
}
