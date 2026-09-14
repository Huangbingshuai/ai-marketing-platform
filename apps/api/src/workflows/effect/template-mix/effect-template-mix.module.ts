import { Module } from '@nestjs/common';

import { WorkflowModule } from '../../../platform/workflow/workflow.module';
import { EffectTemplateMixController } from './effect-template-mix.controller';
import { EffectTemplateMixService } from './effect-template-mix.service';

@Module({
  imports: [WorkflowModule],
  controllers: [EffectTemplateMixController],
  providers: [EffectTemplateMixService],
})
export class EffectTemplateMixModule {}
