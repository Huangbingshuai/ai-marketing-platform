import { resolve } from 'node:path';

import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { validateEnvironment } from './config/environment';
import { PrismaModule } from './database/prisma.module';
import { HealthModule } from './platform/health/health.module';
import { AssetModule } from './platform/asset/asset.module';
import { ProjectModule } from './platform/project/project.module';
import { WorkflowModule } from './platform/workflow/workflow.module';
import { EffectExtractionModule } from './workflows/effect/information-extraction/effect-extraction.module';
import { EffectPromptModule } from './workflows/effect/prompt-generation/effect-prompt.module';
import { EffectSegmentRenderModule } from './workflows/effect/segment-render/effect-segment-render.module';
import { EffectSourceImportModule } from './workflows/effect/source-import/effect-source-import.module';
import { EffectTemplateMixModule } from './workflows/effect/template-mix/effect-template-mix.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      envFilePath: [resolve(process.cwd(), '.env'), resolve(process.cwd(), '../../.env')],
      validate: validateEnvironment,
    }),
    PrismaModule,
    HealthModule,
    ProjectModule,
    AssetModule,
    WorkflowModule,
    EffectSourceImportModule,
    EffectExtractionModule,
    EffectPromptModule,
    EffectSegmentRenderModule,
    EffectTemplateMixModule,
  ],
})
export class AppModule {}
