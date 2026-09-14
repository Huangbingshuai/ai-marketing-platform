import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';

// DTO and service classes are runtime values for validation and dependency injection.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import {
  ApplyEffectTemplateMixVariantDto,
  EffectTemplateMixRevisionDto,
  EffectTemplateMixWorkspaceQueryDto,
  SaveEffectTemplateMixDraftDto,
  ValidateEffectTemplateMixDto,
} from './dto/effect-template-mix.dto';
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { EffectTemplateMixService } from './effect-template-mix.service';

@Controller('projects/:projectId/workflows/effect/template-mix')
export class EffectTemplateMixController {
  constructor(private readonly service: EffectTemplateMixService) {}

  @Get()
  workspace(
    @Param('projectId', new ParseUUIDPipe({ version: '4' })) projectId: string,
    @Query() query: EffectTemplateMixWorkspaceQueryDto,
  ) {
    return this.service.workspace(projectId, query.workflowRunId);
  }

  @Put('draft')
  saveDraft(
    @Param('projectId', new ParseUUIDPipe({ version: '4' })) projectId: string,
    @Body() body: SaveEffectTemplateMixDraftDto,
  ) {
    return this.service.saveDraft(projectId, body.workflowRunId, body.expectedRevision, body.draft);
  }

  @Post('templates/:templateId/variants')
  createVariant(
    @Param('projectId', new ParseUUIDPipe({ version: '4' })) projectId: string,
    @Param('templateId', new ParseUUIDPipe({ version: '4' })) templateId: string,
    @Body() body: EffectTemplateMixRevisionDto,
  ) {
    return this.service.createVariant(
      projectId,
      body.workflowRunId,
      templateId,
      body.expectedRevision,
    );
  }

  @Post('templates/:templateId/variants/:variantId/refill')
  refillVariant(
    @Param('projectId', new ParseUUIDPipe({ version: '4' })) projectId: string,
    @Param('templateId', new ParseUUIDPipe({ version: '4' })) templateId: string,
    @Param('variantId', new ParseUUIDPipe({ version: '4' })) variantId: string,
    @Body() body: EffectTemplateMixRevisionDto,
  ) {
    return this.service.refillVariant(
      projectId,
      body.workflowRunId,
      templateId,
      variantId,
      body.expectedRevision,
    );
  }

  @Post('templates/:templateId/apply-variant')
  applyVariant(
    @Param('projectId', new ParseUUIDPipe({ version: '4' })) projectId: string,
    @Param('templateId', new ParseUUIDPipe({ version: '4' })) templateId: string,
    @Body() body: ApplyEffectTemplateMixVariantDto,
  ) {
    return this.service.applyVariant(
      projectId,
      body.workflowRunId,
      templateId,
      body.sourceVariantId,
      body.syncOtherVariants,
      body.expectedRevision,
    );
  }

  @Post('validate')
  validate(
    @Param('projectId', new ParseUUIDPipe({ version: '4' })) projectId: string,
    @Body() body: ValidateEffectTemplateMixDto,
  ) {
    return this.service.validate(
      projectId,
      body.workflowRunId,
      body.expectedRevision,
      body.templateId,
    );
  }
}
