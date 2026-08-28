import { pipeline } from 'node:stream/promises';
import type { ServerResponse } from 'node:http';

import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';

import { RawResponse } from '../../../common/raw-response.decorator';
import { fileContentDisposition } from '../../../platform/file/content-disposition';
import { UploadTemporaryFileCleanupInterceptor } from '../../../platform/file/upload-temporary-file-cleanup.interceptor';
// DTO classes must remain runtime imports so Nest can emit validation metadata.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import {
  WorkerArtifactDto,
  WorkerBranchOutputDto,
  WorkerCompleteDto,
  WorkerFailDto,
  WorkerImageCacheQueryDto,
  WorkerImageCacheWriteDto,
  WorkerProgressDto,
  WorkerProjectDto,
} from './dto/effect-extraction.dto';
// The service class must remain a runtime import for Nest constructor injection metadata.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import {
  EffectExtractionService,
  type UploadedExtractionArtifact,
} from './effect-extraction.service';
import { EffectExtractionWorkerGuard } from './effect-extraction-worker.guard';

@Controller('internal/workers/effect-extraction')
@UseGuards(EffectExtractionWorkerGuard)
export class EffectExtractionWorkerController {
  constructor(private readonly service: EffectExtractionService) {}

  @Post('runs/:runId/claim')
  claim(
    @Param('runId', new ParseUUIDPipe({ version: '4' })) runId: string,
    @Body() body: WorkerProjectDto,
  ) {
    return this.service.claim(body.projectId, runId);
  }

  @Put('runs/:runId/progress')
  progress(
    @Param('runId', new ParseUUIDPipe({ version: '4' })) runId: string,
    @Headers('x-attempt-token') attemptToken: string,
    @Body() body: WorkerProgressDto,
  ) {
    return this.service.progress(
      body.projectId,
      runId,
      attemptToken,
      body.progress,
      body.currentNode,
    );
  }

  @Put('runs/:runId/branches')
  branch(
    @Param('runId', new ParseUUIDPipe({ version: '4' })) runId: string,
    @Headers('x-attempt-token') attemptToken: string,
    @Body() body: WorkerBranchOutputDto,
  ) {
    return this.service.saveBranch(body.projectId, runId, attemptToken, {
      branch: body.branch,
      status: body.status,
      warnings: body.warnings,
      ...(body.structuredOutput === undefined ? {} : { structuredOutput: body.structuredOutput }),
      ...(body.textStorageKey === undefined ? {} : { textStorageKey: body.textStorageKey }),
      ...(body.errorCode === undefined ? {} : { errorCode: body.errorCode }),
      ...(body.errorMessage === undefined ? {} : { errorMessage: body.errorMessage }),
    });
  }

  @Get('runs/:runId/branches')
  branches(
    @Param('runId', new ParseUUIDPipe({ version: '4' })) runId: string,
    @Headers('x-attempt-token') attemptToken: string,
    @Query() query: WorkerProjectDto,
  ) {
    return this.service.branches(query.projectId, runId, attemptToken);
  }

  @Get('runs/:runId/image-cache')
  imageCache(
    @Param('runId', new ParseUUIDPipe({ version: '4' })) runId: string,
    @Headers('x-attempt-token') attemptToken: string,
    @Query() query: WorkerImageCacheQueryDto,
  ) {
    return this.service.imageCache(query.projectId, runId, attemptToken, query.cacheKey);
  }

  @Put('runs/:runId/image-cache')
  saveImageCache(
    @Param('runId', new ParseUUIDPipe({ version: '4' })) runId: string,
    @Headers('x-attempt-token') attemptToken: string,
    @Body() body: WorkerImageCacheWriteDto,
  ) {
    return this.service.saveImageCache(body.projectId, runId, attemptToken, {
      cacheKey: body.cacheKey,
      candidate: body.candidate,
      metadata: body.metadata ?? {},
    });
  }

  @Post('runs/:runId/artifacts')
  @UseInterceptors(
    FileInterceptor('file', { limits: { files: 1, fileSize: 20 * 1024 * 1024 } }),
    UploadTemporaryFileCleanupInterceptor,
  )
  artifact(
    @Param('runId', new ParseUUIDPipe({ version: '4' })) runId: string,
    @Headers('x-attempt-token') attemptToken: string,
    @Body() body: WorkerArtifactDto,
    @UploadedFile() file: UploadedExtractionArtifact | undefined,
  ) {
    return this.service.storeArtifact(body.projectId, runId, attemptToken, body, file);
  }

  @Post('runs/:runId/complete')
  complete(
    @Param('runId', new ParseUUIDPipe({ version: '4' })) runId: string,
    @Headers('x-attempt-token') attemptToken: string,
    @Body() body: WorkerCompleteDto,
  ) {
    return this.service.complete(body.projectId, runId, attemptToken, {
      result: body.result,
      provenance: body.provenance,
      conflictReport: body.conflictReport,
      warnings: body.warnings,
    });
  }

  @Post('runs/:runId/fail')
  fail(
    @Param('runId', new ParseUUIDPipe({ version: '4' })) runId: string,
    @Headers('x-attempt-token') attemptToken: string,
    @Body() body: WorkerFailDto,
  ) {
    return this.service.fail(body.projectId, runId, attemptToken, body);
  }

  @Get('runs/:runId/sources/:materialId/content')
  @RawResponse()
  async source(
    @Param('runId', new ParseUUIDPipe({ version: '4' })) runId: string,
    @Param('materialId', new ParseUUIDPipe({ version: '4' })) materialId: string,
    @Headers('x-attempt-token') attemptToken: string,
    @Query() query: WorkerProjectDto,
    @Res() response: ServerResponse,
  ): Promise<void> {
    const source = await this.service.source(query.projectId, runId, materialId, attemptToken);
    response.statusCode = 200;
    response.setHeader('content-type', source.material.mimeType);
    response.setHeader('content-length', String(source.contentLength));
    response.setHeader(
      'content-disposition',
      fileContentDisposition('attachment', source.material.originalFileName),
    );
    response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader('cache-control', 'private, no-store');
    await pipeline(source.stream, response);
  }
}
