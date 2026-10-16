import { workerNodeForPath, type ProductionWorkerNode } from './production-worker-policy';
import { timingSafeEqual } from 'node:crypto';
import {
  Body,
  Req,
  Controller,
  Get,
  Post,
  Put,
  Param,
  Query,
  Headers,
  ParseUUIDPipe,
  ParseIntPipe,
  Injectable,
  Inject,
  UseGuards,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
  type OnModuleInit,
  type OnModuleDestroy,
  Logger,
  UploadedFile,
  UseInterceptors,
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
import { FileInterceptor } from '@nestjs/platform-express';
import {
  CUSTOMIZED_IMAGE_MAX_BYTES,
  CUSTOMIZED_IMAGE_REFERENCE_MAX_BYTES,
  type CustomizedImageSettings,
} from '@ai-marketing/contracts';
import { ApiHttpException } from '../../../common/api-http-exception';
import { RawResponse } from '../../../common/raw-response.decorator';
import { UploadTemporaryFileCleanupInterceptor } from '../../../platform/file/upload-temporary-file-cleanup.interceptor';
import type { UploadedAssetFile } from '../../../platform/asset/asset.service';
import { ProductionImageService } from './production-image.service';
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
class ReviewDraft {
  @IsInt() @Min(0) expectedRevision!: number;
}
class Save extends Scope {
  @IsInt() @Min(0) expectedRevision!: number;
  @IsObject() document!: ProductionDocument;
  @IsIn(['ASSETS', 'SHOTS']) section!: 'ASSETS' | 'SHOTS';
  @IsBoolean() confirm!: boolean;
}
class Start extends Scope {
  @IsInt() @Min(0) expectedRevision!: number;
  @IsIn(['ASSETS', 'SHOTS', 'PROMPT', 'IMAGE']) operation!: ProductionOperation;
  @IsOptional() @IsObject() imageSettings?: CustomizedImageSettings;
  @IsString() @MaxLength(200) idempotencyKey!: string;
  @IsOptional() @IsString() @MaxLength(200) shotId?: string;
  @IsOptional() @IsString() @MaxLength(200) targetAssetId?: string;
}
class Worker {
  @IsUUID() projectId!: string;
}
class Step implements ProductionStep {
  @IsIn([
    'SNAPSHOT',
    'PLAN',
    'GENERATE',
    'INVENTORY',
    'IDENTITY',
    'PRODUCT',
    'CHARACTER',
    'SCENE',
    'PROP',
    'IMAGE_PLAN',
    'REVIEW',
    'REPAIR',
  ])
  id!: string;
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
    if (b.operation === 'IMAGE' && !this.config.get<string>('CUSTOMIZED_ASSETS_WORKER_TOKEN'))
      throw new ApiHttpException(
        '资产图片服务未配置，请联系管理员配置资产Worker通道',
        503,
        'VALIDATION_ERROR',
      );
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
      b.targetAssetId ?? null,
      b.imageSettings,
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
  async reviewDraft(p: string, id: string, b: ReviewDraft) {
    await this.projects.get(p);
    return this.repository.reviewDraft(p, id, b.expectedRevision);
  }
}
@Controller('projects/:projectId/workflows/customized/production')
export class ProductionController {
  constructor(
    private readonly service: ProductionService,
    @Inject(ProductionImageService) private readonly images: ProductionImageService,
  ) {}
  @Post('image-references')
  @UseInterceptors(
    FileInterceptor('image', {
      limits: { files: 1, fileSize: CUSTOMIZED_IMAGE_REFERENCE_MAX_BYTES },
    }),
    UploadTemporaryFileCleanupInterceptor,
  )
  reference(
    @Param('projectId', ParseUUIDPipe) p: string,
    @Body() b: Scope,
    @UploadedFile() file?: UploadedAssetFile,
  ) {
    return this.images.uploadReference(p, b.workflowRunId, file);
  }
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
  @Post('tasks/:id/review-draft') reviewDraft(
    @Param('projectId', ParseUUIDPipe) p: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() b: ReviewDraft,
  ) {
    return this.service.reviewDraft(p, id, b);
  }
  @Post('tasks/:id/cancel') cancel(
    @Param('projectId', ParseUUIDPipe) p: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.action(p, id, true);
  }
}
interface NodeWorkerRequest {
  path: string;
  headers: Record<string, unknown>;
  workerNode: ProductionWorkerNode;
}
@Injectable()
export class ProductionWorkerGuard implements CanActivate {
  constructor(@Inject(ConfigService) private readonly config: ConfigService) {}
  canActivate(c: ExecutionContext) {
    const request = c.switchToHttp().getRequest<NodeWorkerRequest>();
    const node = workerNodeForPath(request.path);
    if (!node) throw new UnauthorizedException('Worker 路径无效');
    request.workerNode = node;
    const expected = this.config.get<string>(
        node === 'ASSETS' ? 'CUSTOMIZED_ASSETS_WORKER_TOKEN' : 'CUSTOMIZED_PRODUCTION_WORKER_TOKEN',
      ),
      actual = request.headers['x-worker-token'];
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
@Controller(['internal/workers/customized-production', 'internal/workers/customized-assets'])
@UseGuards(ProductionWorkerGuard)
export class ProductionWorkerController {
  constructor(
    private readonly repository: ProductionRepository,
    @Inject(ProductionImageService) private readonly images: ProductionImageService,
  ) {}
  @Get('tasks/:id/references/:assetId/:version')
  @RawResponse()
  reference(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('assetId', ParseUUIDPipe) assetId: string,
    @Param('version', ParseIntPipe) version: number,
    @Query() q: Worker,
    @Headers('x-attempt-token') token: string,
    @Req() request: NodeWorkerRequest,
  ) {
    if (request.workerNode !== 'ASSETS')
      throw new UnauthorizedException('仅资产 Worker 可读取参考图片');
    return this.images.reference(q.projectId, id, token, assetId, version);
  }
  @Post('tasks/:id/images/:objectId')
  @UseInterceptors(
    FileInterceptor('image', { limits: { files: 1, fileSize: CUSTOMIZED_IMAGE_MAX_BYTES } }),
    UploadTemporaryFileCleanupInterceptor,
  )
  uploadImage(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('objectId') objectId: string,
    @Headers('x-attempt-token') token: string,
    @Body() body: Worker,
    @Req() request: NodeWorkerRequest,
    @UploadedFile() file?: UploadedAssetFile,
  ) {
    if (request.workerNode !== 'ASSETS')
      throw new UnauthorizedException('仅资产 Worker 可保存图片');
    return this.images.upload(body.projectId, id, token, objectId, file);
  }
  @Post('tasks/:id/route') route(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() b: Worker,
    @Req() request: NodeWorkerRequest,
  ) {
    if (request.workerNode !== 'VIDEO')
      throw new UnauthorizedException('仅旧视频队列允许迁移资产消息');
    return this.repository.rerouteLegacyAssets(b.projectId, id);
  }
  @Post('tasks/:id/claim') claim(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() b: Worker,
    @Req() request: NodeWorkerRequest,
  ) {
    return this.repository.claim(b.projectId, id, request.workerNode);
  }
  @Put('tasks/:id/heartbeat') heartbeat(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('x-attempt-token') token: string,
    @Body() b: Worker,
    @Req() request: NodeWorkerRequest,
  ) {
    return this.repository.heartbeat(b.projectId, id, token, request.workerNode);
  }
  @Put('tasks/:id/checkpoint') checkpoint(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('x-attempt-token') token: string,
    @Body() b: Checkpoint,
    @Req() request: NodeWorkerRequest,
  ) {
    return this.repository.checkpoint(b.projectId, id, token, b.step, b.output, request.workerNode);
  }
  @Post('tasks/:id/complete') complete(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('x-attempt-token') token: string,
    @Body() b: Complete,
    @Req() request: NodeWorkerRequest,
  ) {
    return this.repository.complete(b.projectId, id, token, b.output, request.workerNode);
  }
  @Post('tasks/:id/fail') fail(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('x-attempt-token') token: string,
    @Body() b: Failure,
    @Req() request: NodeWorkerRequest,
  ) {
    return this.repository.fail(b.projectId, id, token, b.retryable, request.workerNode);
  }
}
