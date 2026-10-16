import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { Inject, Injectable, StreamableFile } from '@nestjs/common';
import {
  CUSTOMIZED_IMAGE_MAX_BYTES,
  CUSTOMIZED_IMAGE_REFERENCE_MAX_BYTES,
} from '@ai-marketing/contracts';
import { AssetService } from '../../../platform/asset/asset.service';
import { ApiHttpException } from '../../../common/api-http-exception';
import { STORAGE_PORT, type StoragePort } from '../../../platform/file/storage.port';
import { validateImportFile } from '../../../platform/file/import-file-validation';
import { safeOriginalFileName } from '../../../platform/file/file-name';
import type { UploadedAssetFile } from '../../../platform/asset/asset.service';
import { ProductionRepository } from './production.repository';

@Injectable()
export class ProductionImageService {
  constructor(
    @Inject(ProductionRepository) private readonly repository: ProductionRepository,
    @Inject(STORAGE_PORT) private readonly storage: StoragePort,
    @Inject(AssetService) private readonly assets: AssetService,
  ) {}
  async uploadReference(projectId: string, runId: string, file?: UploadedAssetFile) {
    await this.repository.workspace(projectId, runId);
    const validated = await validateImportFile(file, 'IMAGE', CUSTOMIZED_IMAGE_REFERENCE_MAX_BYTES);
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(validated.mimetype))
      throw new ApiHttpException('参考图片支持 PNG、JPG、WebP', 400, 'FILE_TYPE_UNSUPPORTED');
    const [asset] = await this.assets.importMany(
      projectId,
      {
        workflow: 'CUSTOMIZED',
        space: 'CUSTOMIZED_PROJECT',
        type: 'SOURCE_MATERIAL',
        contentIdentity: 'customized-image-reference-v1',
        sourceRunId: runId,
        sourceNode: 'SHOT_PROMPT',
      },
      [validated],
    );
    await this.repository.workspace(projectId, runId);
    return asset!;
  }
  async reference(
    projectId: string,
    taskId: string,
    token: string,
    assetId: string,
    version: number,
  ) {
    const file = await this.repository.imageReferenceScope(
      projectId,
      taskId,
      token,
      assetId,
      version,
    );
    const stored = await this.storage.open(file.storageKey);
    if (stored.sizeBytes !== file.sizeBytes)
      throw new ApiHttpException('参考图片文件已变化', 409, 'VALIDATION_ERROR');
    return new StreamableFile(stored.stream, { type: file.mimeType, length: file.sizeBytes });
  }
  async upload(
    projectId: string,
    taskId: string,
    token: string,
    objectId: string,
    file?: UploadedAssetFile,
  ) {
    const scope = await this.repository.imageScope(projectId, taskId, token, objectId);
    const image = await validateImportFile(file, 'IMAGE', CUSTOMIZED_IMAGE_MAX_BYTES);
    const originalFileName = safeOriginalFileName(`${scope.name.slice(0, 120)}.png`);
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(image.path)) hash.update(chunk);
    const stored = await this.storage.put({
      projectId,
      stream: createReadStream(image.path),
      sizeBytes: image.size,
      contentType: image.mimetype,
      keyContext: {
        projectName: scope.projectName,
        workflow: 'CUSTOMIZED',
        lifecycle: 'assets',
        category: '视觉资产',
        originalFileName,
      },
    });
    try {
      const result = await this.repository.acceptImage(projectId, taskId, token, objectId, {
        storageKey: stored.key,
        sizeBytes: stored.sizeBytes,
        mimeType: image.mimetype,
        originalFileName,
        sha256: hash.digest('hex'),
      });
      if (!result.stored) await this.storage.delete(stored.key).catch(() => undefined);
      return result.image;
    } catch (error) {
      await this.storage.delete(stored.key).catch(() => undefined);
      throw error;
    }
  }
}
