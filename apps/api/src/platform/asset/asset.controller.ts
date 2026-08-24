import { pipeline } from 'node:stream/promises';
import type { ServerResponse } from 'node:http';

import type {
  ArchiveAssetData,
  Asset,
  AssetListData,
  AssetVersion,
  BatchAssetResult,
  StoreArtifactsData,
} from '@ai-marketing/contracts';
import {
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Res,
  UploadedFile,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor, FilesInterceptor } from '@nestjs/platform-express';

import { RawResponse } from '../../common/raw-response.decorator';
import { UploadTemporaryFileCleanupInterceptor } from '../file/upload-temporary-file-cleanup.interceptor';
import { fileContentDisposition } from '../file/content-disposition';
import {
  AssetRangeNotSatisfiableError,
  AssetService,
  type UploadedAssetFile,
} from './asset.service';
// DTO classes must remain runtime imports so Nest can emit validation metadata.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { ContentQueryDto } from './dto/content-query.dto';
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { ImportAssetDto } from './dto/import-asset.dto';
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { ListAssetsQueryDto } from './dto/list-assets-query.dto';
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { UpdateAssetDto } from './dto/update-asset.dto';
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { ImportAssetsDto } from './dto/import-assets.dto';
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { CreateAssetVersionDto } from './dto/create-asset-version.dto';
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { ImportAssetSnapshotDto } from './dto/import-asset-snapshot.dto';
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { BatchArchiveAssetsDto, BatchTagAssetsDto } from './dto/batch-assets.dto';
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { StoreArtifactsDto } from './dto/store-artifacts.dto';
const SAFE_DOCUMENT_MIME_TYPES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);

const responseContentType = (mimeType: string, previewKind: Asset['previewKind']): string =>
  previewKind !== 'DOWNLOAD' || SAFE_DOCUMENT_MIME_TYPES.has(mimeType)
    ? mimeType
    : 'application/octet-stream';

@Controller('projects/:projectId/assets')
export class AssetController {
  constructor(@Inject(AssetService) private readonly assetService: AssetService) {}

  @Get()
  list(
    @Param('projectId', new ParseUUIDPipe({ version: '4' })) projectId: string,
    @Query() query: ListAssetsQueryDto,
  ): Promise<AssetListData> {
    return this.assetService.list(projectId, query);
  }

  @Post()
  @UseInterceptors(FileInterceptor('file'), UploadTemporaryFileCleanupInterceptor)
  import(
    @Param('projectId', new ParseUUIDPipe({ version: '4' })) projectId: string,
    @Body() body: ImportAssetDto,
    @UploadedFile() file: UploadedAssetFile | undefined,
  ): Promise<Asset> {
    let tags: unknown;
    try {
      tags = JSON.parse(body.tags) as unknown;
    } catch {
      tags = undefined;
    }
    return this.assetService.import(projectId, { ...body, tags }, file);
  }

  @Post('imports')
  @UseInterceptors(FilesInterceptor('files', 20), UploadTemporaryFileCleanupInterceptor)
  importMany(
    @Param('projectId', new ParseUUIDPipe({ version: '4' })) projectId: string,
    @Body() body: ImportAssetsDto,
    @UploadedFiles() files: UploadedAssetFile[] | undefined,
  ): Promise<Asset[]> {
    return this.assetService.importMany(projectId, body, files ?? []);
  }

  @Post('import-snapshot')
  importSnapshot(
    @Param('projectId', new ParseUUIDPipe({ version: '4' })) projectId: string,
    @Body() body: ImportAssetSnapshotDto,
  ): Promise<Asset> {
    return this.assetService.importSnapshot(projectId, body);
  }

  @Post('batch-tags')
  batchTags(
    @Param('projectId', new ParseUUIDPipe({ version: '4' })) projectId: string,
    @Body() body: BatchTagAssetsDto,
  ): Promise<BatchAssetResult> {
    return this.assetService.batchTags(projectId, body.assetIds, body.tags);
  }

  @Post('batch-archive')
  batchArchive(
    @Param('projectId', new ParseUUIDPipe({ version: '4' })) projectId: string,
    @Body() body: BatchArchiveAssetsDto,
  ): Promise<BatchAssetResult> {
    return this.assetService.batchArchive(projectId, body.assetIds);
  }

  @Post('store-artifacts')
  storeArtifacts(
    @Param('projectId', new ParseUUIDPipe({ version: '4' })) projectId: string,
    @Body() body: StoreArtifactsDto,
  ): Promise<StoreArtifactsData> {
    return this.assetService.storeArtifacts(projectId, body);
  }

  @Get(':assetId/content')
  @RawResponse()
  async content(
    @Param('projectId', new ParseUUIDPipe({ version: '4' })) projectId: string,
    @Param('assetId', new ParseUUIDPipe({ version: '4' })) assetId: string,
    @Headers('range') range: string | undefined,
    @Query() query: ContentQueryDto,
    @Res() response: ServerResponse,
  ): Promise<void> {
    let content;
    try {
      content = await this.assetService.content(projectId, assetId, range);
    } catch (error) {
      if (error instanceof AssetRangeNotSatisfiableError) {
        response.setHeader('content-range', `bytes */${error.sizeBytes}`);
        response.statusCode = 416;
      }
      throw error;
    }

    const download = query.download === 'true';
    const inline = !download && content.previewKind !== 'DOWNLOAD';
    response.statusCode = content.partial ? 206 : 200;
    response.setHeader('content-type', responseContentType(content.mimeType, content.previewKind));
    response.setHeader('content-length', String(content.contentLength));
    response.setHeader(
      'content-disposition',
      fileContentDisposition(inline ? 'inline' : 'attachment', content.originalFileName),
    );
    response.setHeader(
      'accept-ranges',
      content.previewKind === 'AUDIO' || content.previewKind === 'VIDEO' ? 'bytes' : 'none',
    );
    response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader('cache-control', 'private, no-store');
    if (content.partial) {
      response.setHeader(
        'content-range',
        `bytes ${content.start}-${content.end}/${content.sizeBytes}`,
      );
    }
    await pipeline(content.stream, response);
  }

  @Get(':assetId')
  get(
    @Param('projectId', new ParseUUIDPipe({ version: '4' })) projectId: string,
    @Param('assetId', new ParseUUIDPipe({ version: '4' })) assetId: string,
  ): Promise<Asset> {
    return this.assetService.get(projectId, assetId);
  }

  @Get(':assetId/versions')
  versions(
    @Param('projectId', new ParseUUIDPipe({ version: '4' })) projectId: string,
    @Param('assetId', new ParseUUIDPipe({ version: '4' })) assetId: string,
  ): Promise<AssetVersion[]> {
    return this.assetService.listVersions(projectId, assetId);
  }

  @Post(':assetId/versions')
  createVersion(
    @Param('projectId', new ParseUUIDPipe({ version: '4' })) projectId: string,
    @Param('assetId', new ParseUUIDPipe({ version: '4' })) assetId: string,
    @Body() body: CreateAssetVersionDto,
  ): Promise<Asset> {
    return this.assetService.createVersion(projectId, assetId, body);
  }

  @Post(':assetId/upgrade-source')
  upgradeSource(
    @Param('projectId', new ParseUUIDPipe({ version: '4' })) projectId: string,
    @Param('assetId', new ParseUUIDPipe({ version: '4' })) assetId: string,
  ): Promise<Asset> {
    return this.assetService.upgradeSource(projectId, assetId);
  }

  @Patch(':assetId')
  update(
    @Param('projectId', new ParseUUIDPipe({ version: '4' })) projectId: string,
    @Param('assetId', new ParseUUIDPipe({ version: '4' })) assetId: string,
    @Body() body: UpdateAssetDto,
  ): Promise<Asset> {
    return this.assetService.update(projectId, assetId, body);
  }

  @Post(':assetId/archive')
  archive(
    @Param('projectId', new ParseUUIDPipe({ version: '4' })) projectId: string,
    @Param('assetId', new ParseUUIDPipe({ version: '4' })) assetId: string,
  ): Promise<ArchiveAssetData> {
    return this.assetService.archive(projectId, assetId);
  }
}
