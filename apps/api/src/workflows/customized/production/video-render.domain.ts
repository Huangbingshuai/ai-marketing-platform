import {
  customizedVideoRenderIssues,
  isCustomizedVideoRenderSettings,
  isProductionClipPrompt,
  validateClipPromptReferences,
  isVideoDocument,
  videoClipMs,
  videoPromptReferences,
  resolveCustomizedAssetImageSource,
  type CustomizedVideoRenderInput,
  type CustomizedVideoRenderSettings,
  type ProductionWorkspace,
} from '@ai-marketing/contracts';
import type { Prisma, WorkingArtifact } from '../../../generated/prisma/client';
import { ApiHttpException } from '../../../common/api-http-exception';
import { workflowStateHash } from '../../../platform/workflow/workflow-state-hash';
import { clipPayload } from './video-production.domain';

export const renderSettingsNode = (clipId: string) =>
  `CUSTOMIZED_VIDEO_RENDER_SETTINGS:${workflowStateHash(clipId)}`;
export function renderInvalid(message: string): never {
  throw new ApiHttpException(message, 400, 'VALIDATION_ERROR');
}
export async function freezeVideoRender(
  tx: Prisma.TransactionClient,
  projectId: string,
  workspace: ProductionWorkspace,
  artifacts: WorkingArtifact[],
  clipId: string,
  settings: CustomizedVideoRenderSettings,
  model: string,
) {
  if (!isCustomizedVideoRenderSettings(settings) || !model?.trim())
    renderInvalid('请选择可用的视频模型、画幅和分辨率');
  if (!isVideoDocument(workspace.document)) renderInvalid('请先生成新版完整分镜');
  const document = workspace.document;
  if (!isVideoDocument(document)) throw new Error('unreachable');
  const clip = document.videoPlan.clips.find((c) => c.id === clipId);
  const clipArtifact = artifacts.find(
    (a) => a.artifactKey === `customized-video-clip:${clipId}` && a.freshness === 'CURRENT',
  );
  const promptArtifact = artifacts.find(
    (a) => a.artifactKey === `customized-clip-prompt:${clipId}` && a.freshness === 'CURRENT',
  );
  const prompt = promptArtifact?.payload;
  if (
    !clip ||
    !clipArtifact ||
    workflowStateHash(clipArtifact.payload) !== workflowStateHash(clipPayload(document, clipId))
  )
    renderInvalid('请先保存当前分镜，再生成视频');
  if (
    !isProductionClipPrompt(prompt, document.videoPlan) ||
    prompt.target.id !== clipId ||
    validateClipPromptReferences(prompt, document)
  )
    renderInvalid('请先为当前分镜生成并保存有效提示词');
  if (!isProductionClipPrompt(prompt, document.videoPlan) || !clip) throw new Error('unreachable');
  const refs = videoPromptReferences(prompt.content, document.assets).assetIds;
  const seconds = videoClipMs(document.videoPlan, clip) / 1000;
  const resolved = refs.map((objectId) => {
    const result = resolveCustomizedAssetImageSource(document.assets, objectId);
    if (!result.ok) renderInvalid('参考对象归属无效，请在当前资产目录核对父对象');
    if (!result.ok) throw new Error('unreachable');
    return { objectId, source: result.source };
  });
  const imageCount = new Set(
    resolved.map(({ source }) =>
      source.image ? `${source.image.assetId}:${source.image.version}` : source.id,
    ),
  ).size;
  const issues = customizedVideoRenderIssues(settings, seconds, imageCount);
  if (issues.length) renderInvalid(issues.join('；'));
  const references: CustomizedVideoRenderInput['references'] = [];
  for (const { objectId, source } of resolved) {
    const asset = document.assets.find((a) => a.id === objectId)!;
    if (!source.image) renderInvalid(`请先生成“${source.name}”的参考图，或从提示词中移除该引用`);
    const version = await tx.assetVersion.findFirst({
      where: {
        projectId,
        assetId: source.image!.assetId,
        version: source.image!.version,
        status: { not: 'UNAVAILABLE' },
        mimeType: { in: ['image/png', 'image/jpeg', 'image/webp'] },
        asset: {
          archivedAt: null,
          storageWorkflow: 'CUSTOMIZED',
          workflowSpace: 'CUSTOMIZED_PROJECT',
        },
      },
    });
    if (!version?.storageKey || version.sizeBytes <= 0 || version.sizeBytes >= 30 * 1024 * 1024)
      renderInvalid(`“${source.name}”的参考图不可用，请重新准备图片`);
    const file = await tx.fileObject.findFirst({
      where: { projectId, storageKey: version!.storageKey, status: 'AVAILABLE' },
    });
    if (!file || file.sizeBytes !== version!.sizeBytes || !/^[a-f0-9]{64}$/i.test(file.sha256))
      renderInvalid(`“${source.name}”缺少可校验的图片版本，请重新准备图片`);
    references.push({
      objectId,
      name: asset.name,
      ...(source.id !== objectId ? { sourceObjectId: source.id, sourceName: source.name } : {}),
      assetId: source.image!.assetId,
      version: source.image!.version,
      storageKey: version!.storageKey,
      mimeType: version!.mimeType,
      sizeBytes: version!.sizeBytes,
      sha256: file!.sha256,
    });
  }
  return {
    input: {
      settings,
      model,
      clipId,
      title: clip.title,
      seconds,
      prompt: prompt.content,
      references,
    } satisfies CustomizedVideoRenderInput,
    sources: [clipArtifact!, promptArtifact!],
  };
}

export function videoFileIssues(
  settings: CustomizedVideoRenderSettings,
  seconds: number,
  file: { durationSeconds: number; width: number; height: number },
) {
  if (!Number.isFinite(file.durationSeconds) || Math.abs(file.durationSeconds - seconds) > 1)
    return '返回视频时长与当前分镜不一致';
  const expected = { '480p': 480, '720p': 720, '1080p': 1080, '4k': 2160 }[settings.resolution];
  if (
    !Number.isInteger(file.width) ||
    !Number.isInteger(file.height) ||
    Math.abs(Math.min(file.width, file.height) - expected) > 32
  )
    return '返回视频尺寸与所选分辨率不一致';
  if (settings.ratio !== 'adaptive') {
    const [w, h] = settings.ratio.split(':').map(Number);
    const actual = file.width / file.height,
      ratio = w! / h!;
    if (Math.max(actual / ratio, ratio / actual) - 1 > 0.025) return '返回视频画幅与所选配置不一致';
  }
  return null;
}
