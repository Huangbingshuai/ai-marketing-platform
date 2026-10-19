import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { Inject, Injectable, StreamableFile } from '@nestjs/common';
import { CUSTOMIZED_VIDEO_MAX_BYTES } from '@ai-marketing/contracts';
import type { ServerResponse } from 'node:http';
import { ProjectService } from '../../../platform/project/project.service';
import { STORAGE_PORT, type StoragePort } from '../../../platform/file/storage.port';
import { validateImportFile } from '../../../platform/file/import-file-validation';
import { inspectImportVideo } from '../../../platform/file/video-media';
import { parseRangeHeader, type UploadedAssetFile } from '../../../platform/asset/asset.service';
import { ApiHttpException } from '../../../common/api-http-exception';
import { ProductionRepository } from './production.repository';
import { videoFileIssues } from './video-render.domain';

@Injectable()
export class ProductionVideoService {
  constructor(
    @Inject(ProductionRepository) private readonly repository: ProductionRepository,
    @Inject(STORAGE_PORT) private readonly storage: StoragePort,
    @Inject(ProjectService) private readonly projects: ProjectService,
  ) {}
  async reference(p: string, taskId: string, token: string, index: number) {
    const scope = await this.repository.videoRenderScope(p, taskId, token);
    const file = scope.input.references[index];
    if (!file) throw new ApiHttpException('参考图不属于本次视频任务', 404, 'ASSET_NOT_FOUND');
    const stored = await this.storage.open(file.storageKey);
    if (stored.sizeBytes !== file.sizeBytes)
      throw new ApiHttpException('参考图片文件已变化', 409, 'VALIDATION_ERROR');
    return new StreamableFile(stored.stream, { type: file.mimeType, length: stored.sizeBytes });
  }
  async content(
    p: string,
    runId: string,
    clipId: string,
    poster: boolean,
    range: string | undefined,
    download: boolean,
    response: ServerResponse,
  ) {
    await this.projects.get(p);
    const file = await this.repository.videoFile(p, runId, clipId, poster);
    const requestedRange = !poster ? parseRangeHeader(range, file.sizeBytes) : undefined;
    const stored = await this.storage.open(file.storageKey, requestedRange);
    if (stored.sizeBytes !== file.sizeBytes)
      throw new ApiHttpException('视频文件暂不可用', 409, 'VALIDATION_ERROR');
    response.setHeader('accept-ranges', poster ? 'none' : 'bytes');
    response.setHeader('cache-control', 'private, no-store');
    if (requestedRange) {
      response.statusCode = 206;
      response.setHeader('content-range', `bytes ${stored.start}-${stored.end}/${file.sizeBytes}`);
    }
    if (download)
      response.setHeader(
        'content-disposition',
        `attachment; filename*=UTF-8''${encodeURIComponent(file.originalFileName)}`,
      );
    return new StreamableFile(stored.stream, { type: file.mimeType, length: stored.contentLength });
  }
  async upload(
    p: string,
    taskId: string,
    token: string,
    video?: UploadedAssetFile,
    poster?: UploadedAssetFile,
  ) {
    const scope = await this.repository.videoRenderScope(p, taskId, token, true);
    if (scope.result) return scope.result;
    if (
      !video ||
      video.size < 32 ||
      video.size > CUSTOMIZED_VIDEO_MAX_BYTES ||
      video.mimetype !== 'video/mp4'
    )
      throw new ApiHttpException('请选择有效MP4视频', 400, 'FILE_TYPE_UNSUPPORTED');
    let metadata;
    try {
      metadata = await inspectImportVideo(video.path, 'video.mp4', {
        minSeconds: 1,
        maxSeconds: 31,
      });
    } catch {
      throw new ApiHttpException('视频文件无法校验，请稍后重新生成', 400, 'VALIDATION_ERROR');
    }
    const issue = videoFileIssues(scope.input.settings, scope.input.seconds, metadata);
    if (issue) throw new ApiHttpException(issue, 400, 'VALIDATION_ERROR');
    const image = await validateImportFile(poster, 'IMAGE', 2 * 1024 * 1024);
    if (image.mimetype !== 'image/jpeg')
      throw new ApiHttpException('视频封面必须为JPG', 400, 'FILE_TYPE_UNSUPPORTED');
    const uploaded: { key: string }[] = [];
    const save = async (file: UploadedAssetFile, fileName: string) => {
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(file.path)) hash.update(chunk);
      const stored = await this.storage.put({
        projectId: p,
        stream: createReadStream(file.path),
        sizeBytes: file.size,
        contentType: file.mimetype,
        keyContext: {
          projectName: scope.projectName,
          workflow: 'CUSTOMIZED',
          lifecycle: 'assets',
          category: '分镜视频',
          originalFileName: fileName,
        },
      });
      uploaded.push(stored);
      return { storageKey: stored.key, sizeBytes: stored.sizeBytes, sha256: hash.digest('hex') };
    };
    try {
      const result = await this.repository.acceptVideo(p, taskId, token, metadata, {
        video: await save(video, `${scope.input.clipId}.mp4`),
        poster: await save(image, `${scope.input.clipId}-poster.jpg`),
      });
      if (!result.stored)
        await Promise.all(uploaded.map((f) => this.storage.delete(f.key).catch(() => undefined)));
      return result.video;
    } catch (error) {
      await Promise.all(uploaded.map((f) => this.storage.delete(f.key).catch(() => undefined)));
      throw error;
    }
  }
}
