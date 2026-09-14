import { Body, Controller, Param, ParseUUIDPipe, Post } from '@nestjs/common';

// DTO and service classes are runtime values for validation and dependency injection.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { ValidateEffectTemplateMixDto } from './dto/effect-template-mix.dto';
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { EffectTemplateMixService } from './effect-template-mix.service';

@Controller('projects/:projectId/workflows/effect/template-mix')
export class EffectTemplateMixController {
  constructor(private readonly service: EffectTemplateMixService) {}

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
