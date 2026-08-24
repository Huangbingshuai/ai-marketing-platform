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
import { EffectSourceImportModule } from './workflows/effect/source-import/effect-source-import.module';

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
  ],
})
export class AppModule {}
