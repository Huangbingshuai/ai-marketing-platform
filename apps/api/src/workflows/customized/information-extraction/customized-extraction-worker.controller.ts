import { AuthAccess } from '../../../platform/auth/auth-access.decorator';
import { timingSafeEqual } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import type { ServerResponse } from 'node:http';
import {
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Injectable,
  Param,
  Post,
  Put,
  Query,
  Res,
  UnauthorizedException,
  UploadedFile,
  UseGuards,
  UseInterceptors,
  ParseUUIDPipe,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FileInterceptor } from '@nestjs/platform-express';
import { RawResponse } from '../../../common/raw-response.decorator';
import { UploadTemporaryFileCleanupInterceptor } from '../../../platform/file/upload-temporary-file-cleanup.interceptor';
// Nest constructor injection and DTO validation require runtime classes.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { CustomizedExtractionService } from './customized-extraction.service';
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import {
  WorkerArtifactDto,
  WorkerCompleteDto,
  WorkerFailDto,
  WorkerProgressDto,
  WorkerProjectDto,
  WorkerStepDto,
} from './customized-extraction.dto';
@Injectable()
export class CustomizedExtractionWorkerGuard implements CanActivate {
  constructor(@Inject(ConfigService) private readonly config: ConfigService) {}
  canActivate(context: ExecutionContext) {
    const expected = this.config.get<string>('CUSTOMIZED_EXTRACTION_WORKER_TOKEN');
    const actual = context.switchToHttp().getRequest<{ headers: Record<string, unknown> }>()
      .headers['x-worker-token'];
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
@Controller('internal/workers/customized-extraction')
@AuthAccess('independent')
@UseGuards(CustomizedExtractionWorkerGuard)
export class CustomizedExtractionWorkerController {
  constructor(private readonly service: CustomizedExtractionService) {}
  @Post('tasks/:taskId/claim') claim(
    @Param('taskId', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() b: WorkerProjectDto,
  ) {
    return this.service.claim(b.projectId, id);
  }
  @Put('tasks/:taskId/progress') progress(
    @Param('taskId', new ParseUUIDPipe({ version: '4' })) id: string,
    @Headers('x-attempt-token') token: string,
    @Body() b: WorkerProgressDto,
  ) {
    return this.service.progress(b.projectId, id, token, b.progress, b.nodeId);
  }
  @Put('tasks/:taskId/steps') step(
    @Param('taskId', new ParseUUIDPipe({ version: '4' })) id: string,
    @Headers('x-attempt-token') token: string,
    @Body() b: WorkerStepDto,
  ) {
    return this.service.step(
      b.projectId,
      id,
      token,
      b.nodeId,
      b.sourceId,
      b.status,
      b.output,
      b.errorMessage,
    );
  }
  @Post('tasks/:taskId/complete') complete(
    @Param('taskId', new ParseUUIDPipe({ version: '4' })) id: string,
    @Headers('x-attempt-token') token: string,
    @Body() b: WorkerCompleteDto,
  ) {
    return this.service.complete(b.projectId, id, token, b.candidate);
  }
  @Post('tasks/:taskId/fail') fail(
    @Param('taskId', new ParseUUIDPipe({ version: '4' })) id: string,
    @Headers('x-attempt-token') token: string,
    @Body() b: WorkerFailDto,
  ) {
    return this.service.fail(b.projectId, id, token, b.partial);
  }
  @Post('tasks/:taskId/artifacts')
  @UseInterceptors(
    FileInterceptor('file', { limits: { files: 1, fileSize: 20 * 1024 * 1024 } }),
    UploadTemporaryFileCleanupInterceptor,
  )
  artifact(
    @Param('taskId', new ParseUUIDPipe({ version: '4' })) id: string,
    @Headers('x-attempt-token') token: string,
    @Body() b: WorkerArtifactDto,
    @UploadedFile() file?: { path: string; size: number },
  ) {
    return this.service.artifact(b.projectId, id, token, b.sourceId, file);
  }
  @Get('tasks/:taskId/sources/:sourceId')
  @RawResponse()
  async content(
    @Param('taskId', new ParseUUIDPipe({ version: '4' })) id: string,
    @Param('sourceId', new ParseUUIDPipe({ version: '4' })) source: string,
    @Headers('x-attempt-token') token: string,
    @Query() b: WorkerProjectDto,
    @Res() response: ServerResponse,
  ) {
    const file = await this.service.content(b.projectId, id, token, source);
    response.setHeader('Content-Type', 'application/octet-stream');
    await pipeline(file.stream, response);
  }
  @Get('tasks/:taskId/parsed/:sourceId')
  @RawResponse()
  async parsed(
    @Param('taskId', new ParseUUIDPipe({ version: '4' })) id: string,
    @Param('sourceId', new ParseUUIDPipe({ version: '4' })) source: string,
    @Headers('x-attempt-token') token: string,
    @Query() b: WorkerProjectDto,
    @Res() response: ServerResponse,
  ) {
    const file = await this.service.content(b.projectId, id, token, source, true);
    response.setHeader('Content-Type', 'text/plain; charset=utf-8');
    await pipeline(file.stream, response);
  }
}
