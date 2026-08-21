import { pipeline } from 'node:stream/promises';
import type { ServerResponse } from 'node:http';

import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Res,
  UploadedFile,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { AnyFilesInterceptor, FileInterceptor } from '@nestjs/platform-express';

import { ApiHttpException } from '../../../common/api-http-exception';
import { RawResponse } from '../../../common/raw-response.decorator';
import { UploadTemporaryFileCleanupInterceptor } from '../../../platform/file/upload-temporary-file-cleanup.interceptor';
// DTO classes must remain runtime imports so Nest can emit validation metadata.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import {
  BatchProductsDto,
  CommitManifestDto,
  CreateMaterialDto,
  CreateProductDto,
  ExpectedRevisionDto,
  ListProductsQueryDto,
  ManifestTemplateQueryDto,
  PreviewManifestDto,
  PublishDraftDto,
  SwitchModeDto,
  UpdateDraftDto,
  UpdateProductDto,
  ValidateLinkDto,
} from './dto/effect-source-import.dto';
import { EffectSourceImportService, type UploadedEffectFile } from './effect-source-import.service';

const revision = (bodyRevision: number | undefined, header: string | undefined): number => {
  const cleaned = header?.trim().replace(/^W\//, '').replace(/^"|"$/g, '');
  const value = cleaned ? Number(cleaned) : bodyRevision;
  if (!Number.isInteger(value) || (value ?? 0) < 1) {
    throw new ApiHttpException('缺少有效的 expectedRevision/If-Match', 400, 'VALIDATION_ERROR');
  }
  return value!;
};

const disposition = (fileName: string, inline = false): string =>
  `${inline ? 'inline' : 'attachment'}; filename="download"; filename*=UTF-8''${encodeURIComponent(fileName)}`;

const EFFECT_IMPORT_MANIFEST_COMPANION_MAX_BYTES = 100 * 1024 * 1024;
const EFFECT_IMPORT_SINGLE_UPLOAD_MAX_BYTES = 100 * 1024 * 1024;

@Controller('projects/:projectId/workflows/effect/source-import')
export class EffectSourceImportController {
  constructor(
    @Inject(EffectSourceImportService) private readonly service: EffectSourceImportService,
  ) {}

  @Get()
  workspace(@Param('projectId', new ParseUUIDPipe({ version: '4' })) projectId: string) {
    return this.service.getWorkspace(projectId);
  }

  @Patch('mode')
  switchMode(
    @Param('projectId', new ParseUUIDPipe({ version: '4' })) projectId: string,
    @Headers('if-match') match: string | undefined,
    @Body() body: SwitchModeDto,
  ) {
    return this.service.switchMode(projectId, body.mode, revision(body.expectedRevision, match));
  }

  @Get('drafts/:mode')
  draft(
    @Param('projectId', new ParseUUIDPipe({ version: '4' })) projectId: string,
    @Param('mode') mode: string,
  ) {
    return this.service.getDraft(projectId, mode);
  }

  @Put('drafts/:mode')
  updateDraft(
    @Param('projectId', new ParseUUIDPipe({ version: '4' })) projectId: string,
    @Param('mode') mode: string,
    @Headers('if-match') match: string | undefined,
    @Body() body: UpdateDraftDto,
  ) {
    return this.service.updateDraft(
      projectId,
      mode,
      body.globalConfig,
      revision(body.expectedRevision, match),
    );
  }

  @Get('drafts/:mode/products')
  products(
    @Param('projectId', new ParseUUIDPipe({ version: '4' })) projectId: string,
    @Param('mode') mode: string,
    @Query() query: ListProductsQueryDto,
  ) {
    return this.service.listProducts(projectId, mode, query);
  }

  @Post('drafts/:mode/products')
  createProduct(
    @Param('projectId', new ParseUUIDPipe({ version: '4' })) projectId: string,
    @Param('mode') mode: string,
    @Headers('if-match') match: string | undefined,
    @Body() body: CreateProductDto,
  ) {
    return this.service.createProduct(projectId, mode, {
      ...body,
      expectedRevision: revision(body.expectedRevision, match),
    });
  }

  @Patch('drafts/:mode/products/:productId')
  updateProduct(
    @Param('projectId', new ParseUUIDPipe({ version: '4' })) projectId: string,
    @Param('mode') mode: string,
    @Param('productId', new ParseUUIDPipe({ version: '4' })) productId: string,
    @Headers('if-match') match: string | undefined,
    @Body() body: UpdateProductDto,
  ) {
    return this.service.updateProduct(projectId, mode, productId, {
      ...body,
      expectedRevision: revision(body.expectedRevision, match),
    });
  }

  @Delete('drafts/:mode/products/:productId')
  deleteProduct(
    @Param('projectId', new ParseUUIDPipe({ version: '4' })) projectId: string,
    @Param('mode') mode: string,
    @Param('productId', new ParseUUIDPipe({ version: '4' })) productId: string,
    @Headers('if-match') match: string | undefined,
  ) {
    return this.service.deleteProduct(projectId, mode, productId, revision(undefined, match));
  }

  @Post('drafts/:mode/products/batch-delete')
  batchDelete(
    @Param('projectId', new ParseUUIDPipe({ version: '4' })) projectId: string,
    @Param('mode') mode: string,
    @Headers('if-match') match: string | undefined,
    @Body() body: BatchProductsDto,
  ) {
    return this.service.deleteProducts(
      projectId,
      mode,
      body.productIds,
      revision(body.expectedRevision, match),
    );
  }

  @Post('drafts/:mode/products/batch-retry')
  batchRetry(
    @Param('projectId', new ParseUUIDPipe({ version: '4' })) projectId: string,
    @Param('mode') mode: string,
    @Headers('if-match') match: string | undefined,
    @Body() body: BatchProductsDto,
  ) {
    return this.service.batchRetry(
      projectId,
      mode,
      body.productIds,
      revision(body.expectedRevision, match),
    );
  }

  @Post('drafts/:mode/products/:productId/validate-link')
  validateLink(
    @Param('projectId', new ParseUUIDPipe({ version: '4' })) projectId: string,
    @Param('mode') mode: string,
    @Param('productId', new ParseUUIDPipe({ version: '4' })) productId: string,
    @Body() body: ValidateLinkDto,
  ) {
    return this.service.validateLinkScoped(projectId, mode, productId, body.commerceUrl);
  }

  @Post('drafts/:mode/products/:productId/materials')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { files: 1, fileSize: EFFECT_IMPORT_SINGLE_UPLOAD_MAX_BYTES },
    }),
    UploadTemporaryFileCleanupInterceptor,
  )
  uploadMaterial(
    @Param('projectId', new ParseUUIDPipe({ version: '4' })) projectId: string,
    @Param('mode') mode: string,
    @Param('productId', new ParseUUIDPipe({ version: '4' })) productId: string,
    @Headers('if-match') match: string | undefined,
    @Body() body: CreateMaterialDto,
    @UploadedFile() file: UploadedEffectFile | undefined,
  ) {
    return this.service.uploadMaterial(
      projectId,
      mode,
      productId,
      { ...body, expectedRevision: revision(body.expectedRevision, match) },
      file,
    );
  }

  @Put('drafts/:mode/products/:productId/materials/:materialId/content')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { files: 1, fileSize: EFFECT_IMPORT_SINGLE_UPLOAD_MAX_BYTES },
    }),
    UploadTemporaryFileCleanupInterceptor,
  )
  replaceMaterial(
    @Param('projectId', new ParseUUIDPipe({ version: '4' })) projectId: string,
    @Param('mode') mode: string,
    @Param('productId', new ParseUUIDPipe({ version: '4' })) productId: string,
    @Param('materialId', new ParseUUIDPipe({ version: '4' })) materialId: string,
    @Headers('if-match') match: string | undefined,
    @Body() body: ExpectedRevisionDto,
    @UploadedFile() file: UploadedEffectFile | undefined,
  ) {
    return this.service.replaceMaterial(
      projectId,
      mode,
      productId,
      materialId,
      revision(body.expectedRevision, match),
      file,
    );
  }

  @Delete('drafts/:mode/products/:productId/materials/:materialId')
  deleteMaterial(
    @Param('projectId', new ParseUUIDPipe({ version: '4' })) projectId: string,
    @Param('mode') mode: string,
    @Param('productId', new ParseUUIDPipe({ version: '4' })) productId: string,
    @Param('materialId', new ParseUUIDPipe({ version: '4' })) materialId: string,
    @Headers('if-match') match: string | undefined,
  ) {
    return this.service.deleteMaterial(
      projectId,
      mode,
      productId,
      materialId,
      revision(undefined, match),
    );
  }

  @Get('drafts/:mode/products/:productId/materials/:materialId/content')
  @RawResponse()
  async materialContent(
    @Param('projectId', new ParseUUIDPipe({ version: '4' })) projectId: string,
    @Param('mode') mode: string,
    @Param('productId', new ParseUUIDPipe({ version: '4' })) productId: string,
    @Param('materialId', new ParseUUIDPipe({ version: '4' })) materialId: string,
    @Headers('range') range: string | undefined,
    @Res() response: ServerResponse,
  ): Promise<void> {
    const content = await this.service.materialContent(
      projectId,
      mode,
      productId,
      materialId,
      range,
    );
    response.statusCode = content.partial ? 206 : 200;
    response.setHeader('content-type', content.mimeType);
    response.setHeader('content-length', String(content.contentLength));
    response.setHeader('content-disposition', disposition(content.originalFileName, true));
    response.setHeader('accept-ranges', 'bytes');
    response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader('cache-control', 'private, no-store');
    if (content.partial)
      response.setHeader(
        'content-range',
        `bytes ${content.start}-${content.end}/${content.sizeBytes}`,
      );
    await pipeline(content.stream, response);
  }

  @Post('drafts/BATCH/manifest-imports/preview')
  @UseInterceptors(
    AnyFilesInterceptor({
      limits: { files: 21, parts: 25, fileSize: EFFECT_IMPORT_MANIFEST_COMPANION_MAX_BYTES },
    }),
    UploadTemporaryFileCleanupInterceptor,
  )
  previewManifest(
    @Param('projectId', new ParseUUIDPipe({ version: '4' })) projectId: string,
    @Headers('if-match') match: string | undefined,
    @Body() body: PreviewManifestDto,
    @UploadedFiles() uploads: UploadedEffectFile[] | undefined,
  ) {
    const files = uploads ?? [];
    const manifest =
      files.find((file) => file.fieldname === 'manifest') ??
      files.find(
        (file) =>
          file.originalname.toLowerCase().endsWith('.csv') ||
          file.originalname.toLowerCase().endsWith('.xlsx'),
      );
    return this.service.previewManifest(
      projectId,
      revision(body.expectedRevision, match),
      body.idempotencyKey,
      manifest,
      files.filter((file) => file !== manifest),
    );
  }

  @Post('drafts/BATCH/manifest-imports/:importId/commit')
  commitManifest(
    @Param('projectId', new ParseUUIDPipe({ version: '4' })) projectId: string,
    @Param('importId', new ParseUUIDPipe({ version: '4' })) importId: string,
    @Headers('if-match') match: string | undefined,
    @Body() body: CommitManifestDto,
  ) {
    return this.service.commitManifest(
      projectId,
      importId,
      revision(body.expectedRevision, match),
      body.idempotencyKey,
    );
  }

  @Delete('drafts/BATCH/manifest-imports/:importId')
  cancelManifest(
    @Param('projectId', new ParseUUIDPipe({ version: '4' })) projectId: string,
    @Param('importId', new ParseUUIDPipe({ version: '4' })) importId: string,
    @Headers('if-match') match: string | undefined,
  ) {
    return this.service.cancelManifest(projectId, importId, revision(undefined, match));
  }

  @Get('manifest-template')
  @RawResponse()
  async template(
    @Query() query: ManifestTemplateQueryDto,
    @Res() response: ServerResponse,
  ): Promise<void> {
    const file = await this.service.template(query.format);
    response.statusCode = 200;
    response.setHeader('content-type', file.contentType);
    response.setHeader('content-length', String(file.buffer.length));
    response.setHeader('content-disposition', disposition(file.fileName));
    response.end(file.buffer);
  }

  @Post('drafts/:mode/validate')
  validate(
    @Param('projectId', new ParseUUIDPipe({ version: '4' })) projectId: string,
    @Param('mode') mode: string,
    @Headers('if-match') match: string | undefined,
    @Body() body: ExpectedRevisionDto,
  ) {
    return this.service.validate(projectId, mode, revision(body.expectedRevision, match));
  }

  @Post('drafts/:mode/publish')
  publish(
    @Param('projectId', new ParseUUIDPipe({ version: '4' })) projectId: string,
    @Param('mode') mode: string,
    @Headers('if-match') match: string | undefined,
    @Body() body: PublishDraftDto,
  ) {
    return this.service.publish(
      projectId,
      mode,
      revision(body.expectedRevision, match),
      body.idempotencyKey,
    );
  }

  @Post('drafts/:mode/advance')
  advance(
    @Param('projectId', new ParseUUIDPipe({ version: '4' })) projectId: string,
    @Param('mode') mode: string,
    @Headers('if-match') match: string | undefined,
    @Body() body: ExpectedRevisionDto,
  ) {
    return this.service.advance(projectId, mode, revision(body.expectedRevision, match));
  }
}
