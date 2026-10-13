import { timingSafeEqual } from 'node:crypto';
import {
  Body,
  Controller,
  Get,
  Post,
  Put,
  Param,
  Query,
  Headers,
  ParseUUIDPipe,
  Injectable,
  Inject,
  UseGuards,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
  type OnModuleInit,
  type OnModuleDestroy,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  IsUUID,
  IsInt,
  Min,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  IsObject,
  IsBoolean,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import type {
  ProductionDocument,
  ProductionOperation,
  ProductionStep,
  ProductionPrompt,
} from '@ai-marketing/contracts';
import { ProjectService } from '../../../platform/project/project.service';
import { ProductionRepository } from './production.repository';
class Scope {
  @IsUUID() workflowRunId!: string;
}
class SavePrompt extends Scope {
  @IsInt() @Min(0) expectedRevision!: number;
  @IsObject() prompt!: ProductionPrompt;
}
class Save extends Scope {
  @IsInt() @Min(0) expectedRevision!: number;
  @IsObject() document!: ProductionDocument;
  @IsIn(['ASSETS', 'SHOTS']) section!: 'ASSETS' | 'SHOTS';
  @IsBoolean() confirm!: boolean;
}
class Start extends Scope {
  @IsInt() @Min(0) expectedRevision!: number;
  @IsIn(['ASSETS', 'SHOTS', 'PROMPT']) operation!: ProductionOperation;
  @IsString() @MaxLength(200) idempotencyKey!: string;
  @IsOptional() @IsString() @MaxLength(200) shotId?: string;
}
class Worker {
  @IsUUID() projectId!: string;
}
class Step implements ProductionStep {
  @IsIn(['SNAPSHOT', 'PLAN', 'GENERATE', 'REVIEW', 'REPAIR']) id!: string;
  @IsIn(['RUNNING', 'SUCCEEDED', 'FAILED']) status!: string;
  @IsString() @MaxLength(200) title!: string;
  @IsString() @MaxLength(100000) content!: string;
}
class Checkpoint extends Worker {
  @ValidateNested() @Type(() => Step) step!: Step;
  @IsOptional() @IsObject() output?: object;
}
class Complete extends Worker {
  @IsObject() output!: object;
}
class Failure extends Worker {
  @IsBoolean() retryable!: boolean;
}
@Injectable()
export class ProductionService implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private recovering = false;
  private readonly logger = new Logger(ProductionService.name);
  constructor(
    @Inject(ProductionRepository) readonly repository: ProductionRepository,
    @Inject(ProjectService) private readonly projects: ProjectService,
    @Inject(ConfigService) private readonly config: ConfigService,
  ) {}
  onModuleInit() {
    this.timer = setInterval(() => {
      if (this.recovering) return;
      this.recovering = true;
      void this.repository
        .recoverExpired()
        .catch(() => this.logger.warn('制作任务恢复稍后重试'))
        .finally(() => {
          this.recovering = false;
        });
    }, 30000);
    this.timer.unref();
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }
  async workspace(p: string, q: Scope) {
    await this.projects.get(p);
    return this.repository.workspace(p, q.workflowRunId);
  }
  async save(p: string, b: Save) {
    await this.projects.get(p);
    return this.repository.save(
      p,
      b.workflowRunId,
      b.expectedRevision,
      b.document,
      b.section,
      b.confirm,
    );
  }
  async start(p: string, b: Start) {
    await this.projects.get(p);
    return this.repository.start(
      p,
      b.workflowRunId,
      b.expectedRevision,
      b.operation,
      b.idempotencyKey,
      b.shotId ?? null,
      {
        creative:
          this.config.get<string>('CUSTOMIZED_STORYBOARD_CREATIVE_MODEL') ||
          'doubao-seed-2-1-pro-260915',
        detail:
          this.config.get<string>('CUSTOMIZED_STORYBOARD_DETAIL_MODEL') ||
          'doubao-seed-2-1-turbo-260628',
      },
    );
  }
  async task(p: string, id: string) {
    await this.projects.get(p);
    return this.repository.getTask(p, id);
  }
  async prompt(p: string, b: SavePrompt) {
    await this.projects.get(p);
    return this.repository.savePrompt(p, b.workflowRunId, b.expectedRevision, b.prompt);
  }
  async action(p: string, id: string, cancel: boolean) {
    await this.projects.get(p);
    return this.repository.action(p, id, cancel);
  }
}
@Controller('projects/:projectId/workflows/customized/production')
export class ProductionController {
  constructor(private readonly service: ProductionService) {}
  @Get() workspace(@Param('projectId', ParseUUIDPipe) p: string, @Query() q: Scope) {
    return this.service.workspace(p, q);
  }
  @Put() save(@Param('projectId', ParseUUIDPipe) p: string, @Body() b: Save) {
    return this.service.save(p, b);
  }
  @Post('tasks') start(@Param('projectId', ParseUUIDPipe) p: string, @Body() b: Start) {
    return this.service.start(p, b);
  }
  @Put('prompt') prompt(@Param('projectId', ParseUUIDPipe) p: string, @Body() b: SavePrompt) {
    return this.service.prompt(p, b);
  }
  @Get('tasks/:id') task(
    @Param('projectId', ParseUUIDPipe) p: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.task(p, id);
  }
  @Post('tasks/:id/retry') retry(
    @Param('projectId', ParseUUIDPipe) p: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.action(p, id, false);
  }
  @Post('tasks/:id/cancel') cancel(
    @Param('projectId', ParseUUIDPipe) p: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.action(p, id, true);
  }
}
@Injectable()
export class ProductionWorkerGuard implements CanActivate {
  constructor(@Inject(ConfigService) private readonly config: ConfigService) {}
  canActivate(c: ExecutionContext) {
    const expected = this.config.get<string>('CUSTOMIZED_PRODUCTION_WORKER_TOKEN'),
      actual = c.switchToHttp().getRequest<{ headers: Record<string, unknown> }>().headers[
        'x-worker-token'
      ];
    if (
      !expected ||
      typeof actual !== 'string' ||
      Buffer.byteLength(expected) !== Buffer.byteLength(actual) ||
      !timingSafeEqual(Buffer.from(expected), Buffer.from(actual))
    )
      throw new UnauthorizedException('Worker token 无效');
    return true;
  }
}
@Controller('internal/workers/customized-production')
@UseGuards(ProductionWorkerGuard)
export class ProductionWorkerController {
  constructor(private readonly repository: ProductionRepository) {}
  @Post('tasks/:id/claim') claim(@Param('id', ParseUUIDPipe) id: string, @Body() b: Worker) {
    return this.repository.claim(b.projectId, id);
  }
  @Put('tasks/:id/heartbeat') heartbeat(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('x-attempt-token') token: string,
    @Body() b: Worker,
  ) {
    return this.repository.heartbeat(b.projectId, id, token);
  }
  @Put('tasks/:id/checkpoint') checkpoint(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('x-attempt-token') token: string,
    @Body() b: Checkpoint,
  ) {
    return this.repository.checkpoint(b.projectId, id, token, b.step, b.output);
  }
  @Post('tasks/:id/complete') complete(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('x-attempt-token') token: string,
    @Body() b: Complete,
  ) {
    return this.repository.complete(b.projectId, id, token, b.output);
  }
  @Post('tasks/:id/fail') fail(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('x-attempt-token') token: string,
    @Body() b: Failure,
  ) {
    return this.repository.fail(b.projectId, id, token, b.retryable);
  }
}
