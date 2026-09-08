import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';

import type {
  EffectPromptBatchResult,
  EffectSegmentRenderSettings,
  EffectSegmentRenderRepairDecision,
  EffectSegmentRenderRepairRegion,
  EffectSegmentRenderBatch,
  EffectSegmentRenderRequestSnapshot,
  EffectSegmentRenderSourcePackage,
  EffectSegmentRenderSummary,
  EffectSegmentRenderTask,
  GetEffectSegmentRenderWorkspaceData,
  StartEffectSegmentRenderBatchData,
  ValidateEffectSegmentRenderBatchData,
} from '@ai-marketing/contracts';
import {
  DEFAULT_EFFECT_SEGMENT_RENDER_SETTINGS,
  EFFECT_PROMPT_RENDER_CAPABILITIES,
  EFFECT_SEGMENT_RENDER_LIMITS,
  effectSegmentRenderSettingsNodeId,
} from '@ai-marketing/contracts';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ProjectService } from '../../../platform/project/project.service';
import { STORAGE_PORT, type StoragePort } from '../../../platform/file/storage.port';
import {
  type WorkingArtifactUpsertInput,
  WorkflowWorkingRepository,
  workingArtifactContentHash,
} from '../../../platform/workflow/workflow-working.repository';
import { workflowStateHash } from '../../../platform/workflow/workflow-state-hash';
import {
  compileEffectSeedanceRepairRequest,
  compileEffectSeedanceRequest,
  validateEffectSeedanceTaskResult,
} from './effect-seedance-request.compiler';
import {
  type EffectSegmentRenderBatchRecord,
  EffectSegmentRenderRepository,
} from './effect-segment-render.repository';
import type { UploadedSegmentRenderFile } from './effect-segment-render.types';
import { parseEffectPromptBatchResult } from '../prompt-generation/effect-prompt.quality';

const notFound = (message: string): NotFoundException => new NotFoundException(message);
const conflict = (message: string): ConflictException => new ConflictException(message);
const badRequest = (message: string): BadRequestException => new BadRequestException(message);
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const SUPPORTED_REFERENCE_IMAGE_MIME_TYPES = new Set([
  'image/gif',
  'image/bmp',
  'image/heic',
  'image/heif',
  'image/jpeg',
  'image/png',
  'image/tiff',
  'image/webp',
]);
const SUPPORTED_REFERENCE_VIDEO_MIME_TYPES = new Set(['video/mp4', 'video/quicktime']);
// eslint-disable-next-line no-control-regex
const INVALID_FILE_NAME_PATTERN = /[<>:"/\\|?*\u0000-\u001f]/gu;

const safeFileName = (value: string): string => {
  const name = value.trim().replace(INVALID_FILE_NAME_PATTERN, '_').slice(0, 180);
  return name || 'segment.mp4';
};

const fileSha256 = async (path: string): Promise<string> => {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
};

const safeSignatureEquals = (actual: string, expected: string): boolean => {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return (
    actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer)
  );
};

const parseByteRange = (
  rangeHeader: string | undefined,
  sizeBytes: number,
): { start: number; end: number } | undefined => {
  if (!rangeHeader) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/u.exec(rangeHeader.trim());
  if (!match) throw badRequest('视频读取范围无效');
  const [, startText, endText] = match;
  let start: number;
  let end: number;
  if (!startText) {
    const suffix = Number(endText);
    if (!Number.isSafeInteger(suffix) || suffix < 1) throw badRequest('视频读取范围无效');
    start = Math.max(0, sizeBytes - suffix);
    end = sizeBytes - 1;
  } else {
    start = Number(startText);
    end = endText ? Number(endText) : sizeBytes - 1;
  }
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end < start ||
    end >= sizeBytes
  )
    throw badRequest('视频读取范围无效');
  return { start, end };
};

const repairRegion = (value: unknown): EffectSegmentRenderRepairRegion | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Partial<EffectSegmentRenderRepairRegion>;
  if (
    ![candidate.x, candidate.y, candidate.width, candidate.height].every(
      (item) => typeof item === 'number' && Number.isFinite(item),
    ) ||
    candidate.x! < 0 ||
    candidate.y! < 0 ||
    candidate.width! <= 0 ||
    candidate.height! <= 0 ||
    candidate.x! + candidate.width! > 1 ||
    candidate.y! + candidate.height! > 1
  )
    return null;
  return {
    x: candidate.x!,
    y: candidate.y!,
    width: candidate.width!,
    height: candidate.height!,
  };
};

const requestSnapshot = (value: unknown): EffectSegmentRenderRequestSnapshot =>
  value as EffectSegmentRenderRequestSnapshot;

const sourcePackageSnapshot = (value: unknown): EffectSegmentRenderSourcePackage | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const sourcePackage = (value as { sourcePackage?: unknown }).sourcePackage;
  if (!sourcePackage || typeof sourcePackage !== 'object' || Array.isArray(sourcePackage))
    return null;
  const candidate = sourcePackage as Partial<EffectSegmentRenderSourcePackage>;
  if (
    typeof candidate.artifactId !== 'string' ||
    !candidate.artifactId ||
    typeof candidate.revision !== 'number' ||
    candidate.revision < 1 ||
    typeof candidate.contentHash !== 'string' ||
    !candidate.contentHash
  )
    return null;
  return {
    artifactId: candidate.artifactId,
    revision: candidate.revision,
    contentHash: candidate.contentHash,
  };
};

const summary = (record: EffectSegmentRenderBatchRecord): EffectSegmentRenderSummary =>
  record.tasks.reduce<EffectSegmentRenderSummary>(
    (result, task) => {
      result.total += 1;
      if (task.status === 'COMPLETED') result.completed += 1;
      else if (task.status === 'FAILED') result.failed += 1;
      else result.running += 1;
      return result;
    },
    { total: 0, completed: 0, running: 0, failed: 0 },
  );

const presentTask = (
  task: EffectSegmentRenderBatchRecord['tasks'][number],
  productName: string,
): EffectSegmentRenderTask => {
  const snapshot = requestSnapshot(task.requestSnapshot);
  const status =
    task.status === 'RUNNING'
      ? 'RENDERING'
      : task.status === 'QUEUED' && task.retryCount > 0
        ? 'AUTO_RETRY'
        : task.status;
  const hasOutput =
    task.outputFileObjectId &&
    task.outputFileName &&
    task.outputMimeType &&
    task.outputSizeBytes !== null &&
    task.outputContentHash &&
    SHA256_PATTERN.test(task.outputContentHash);
  const hasRepairCandidate =
    task.repairCandidateFileObjectId &&
    task.repairCandidateFileName &&
    task.repairCandidateMimeType &&
    task.repairCandidateSizeBytes !== null &&
    task.repairCandidateContentHash &&
    task.repairCandidateVersion !== null &&
    SHA256_PATTERN.test(task.repairCandidateContentHash);
  const repair =
    task.repairStatus &&
    task.repairSourceVersion !== null &&
    task.repairStartMs !== null &&
    task.repairEndMs !== null &&
    task.repairInstruction
      ? {
          sourceVersion: task.repairSourceVersion,
          startMs: task.repairStartMs,
          endMs: task.repairEndMs,
          instruction: task.repairInstruction,
          region: repairRegion(task.repairRegion),
          status: task.repairStatus === 'RUNNING' ? ('RENDERING' as const) : task.repairStatus,
          errorCode: task.errorCode,
          errorMessage: task.errorMessage,
          candidate: hasRepairCandidate
            ? {
                fileObjectId: task.repairCandidateFileObjectId!,
                originalFileName: task.repairCandidateFileName!,
                mimeType: task.repairCandidateMimeType!,
                sizeBytes: task.repairCandidateSizeBytes!,
                contentHash: task.repairCandidateContentHash!,
                version: task.repairCandidateVersion!,
              }
            : null,
        }
      : null;
  return {
    id: task.id,
    renderCode: task.renderCode,
    productId: task.productId,
    productName: productName.trim() || '未命名产品',
    promptId: task.promptId,
    promptCode: task.promptCode,
    promptText: snapshot.promptText,
    fragmentType: snapshot.primaryPurpose,
    durationSeconds: snapshot.request.duration,
    modelMatch: 'AUTO_MATCHED',
    source: 'PROMPT',
    sourceName: task.promptCode,
    status,
    progress: task.progress,
    retryCount: task.retryCount,
    maxAutoRetries: task.maxAutoRetries,
    abnormal: task.status === 'FAILED',
    errorCode: task.errorCode,
    errorMessage: task.errorMessage,
    providerTaskId: task.providerTaskId,
    output: hasOutput
      ? {
          fileObjectId: task.outputFileObjectId!,
          originalFileName: task.outputFileName!,
          mimeType: task.outputMimeType!,
          sizeBytes: task.outputSizeBytes!,
          contentHash: task.outputContentHash!,
          version: task.activeOutputVersion ?? task.renderVersion,
        }
      : null,
    repair,
    updatedAt: task.updatedAt.toISOString(),
  };
};

@Injectable()
export class EffectSegmentRenderService {
  constructor(
    @Inject(EffectSegmentRenderRepository)
    private readonly repository: EffectSegmentRenderRepository,
    @Inject(ProjectService) private readonly projects: ProjectService,
    @Inject(ConfigService) private readonly config: ConfigService,
    @Inject(STORAGE_PORT) private readonly storage: StoragePort,
    @Inject(WorkflowWorkingRepository)
    private readonly workingRepository: WorkflowWorkingRepository,
  ) {}

  private settingsFromState(value: unknown): EffectSegmentRenderSettings | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const candidate = value as Partial<EffectSegmentRenderSettings>;
    const capability = candidate.capabilityKey
      ? EFFECT_PROMPT_RENDER_CAPABILITIES[candidate.capabilityKey]
      : undefined;
    if (
      !capability ||
      !candidate.ratio ||
      !candidate.resolution ||
      !capability.ratios.includes(candidate.ratio) ||
      !capability.resolutions.includes(candidate.resolution)
    )
      return null;
    return {
      ratio: candidate.ratio,
      resolution: candidate.resolution,
      capabilityKey: candidate.capabilityKey!,
    };
  }

  private legacySettings(promptPayload: unknown): EffectSegmentRenderSettings {
    const prompt = parseEffectPromptBatchResult(promptPayload);
    if (!prompt?.renderProfile) return { ...DEFAULT_EFFECT_SEGMENT_RENDER_SETTINGS };
    return (
      this.settingsFromState({
        ratio: prompt.renderProfile.ratio,
        resolution: prompt.renderProfile.resolution,
        capabilityKey: prompt.renderProfile.capabilityKey,
      }) ?? { ...DEFAULT_EFFECT_SEGMENT_RENDER_SETTINGS }
    );
  }

  private async present(record: EffectSegmentRenderBatchRecord): Promise<EffectSegmentRenderBatch> {
    const sourceSnapshot = sourcePackageSnapshot(record.tasks[0]?.requestSnapshot);
    const [prompt, sourcePackage] = await Promise.all([
      this.repository.promptArtifact(record.projectId, record.workflowRunId, record.productId),
      this.repository.sourcePackageArtifact(
        record.projectId,
        record.workflowRunId,
        record.productId,
      ),
    ]);
    const stale = Boolean(
      !prompt ||
      prompt.freshness !== 'CURRENT' ||
      prompt.availability !== 'AVAILABLE' ||
      prompt.id !== record.sourcePromptArtifactId ||
      prompt.revision !== record.sourcePromptRevision ||
      prompt.contentHash !== record.sourcePromptHash ||
      !sourceSnapshot ||
      !sourcePackage ||
      sourcePackage.freshness !== 'CURRENT' ||
      sourcePackage.availability !== 'AVAILABLE' ||
      sourcePackage.id !== sourceSnapshot.artifactId ||
      sourcePackage.revision !== sourceSnapshot.revision ||
      sourcePackage.contentHash !== sourceSnapshot.contentHash,
    );
    const artifact = await this.repository.renderArtifact(
      record.projectId,
      record.workflowRunId,
      record.productId,
    );
    const artifacts = this.artifactInputs(record);
    const batchInput = artifacts.find(
      ({ artifactKey }) => artifactKey === 'render-batch:' + record.productId,
    )?.input;
    const commitStatus = !artifact
      ? 'UNVALIDATED'
      : stale || artifact.freshness !== 'CURRENT' || artifact.availability !== 'AVAILABLE'
        ? 'STALE'
        : batchInput && artifact.contentHash === workingArtifactContentHash(batchInput)
          ? 'COMMITTED'
          : 'DRAFT_CHANGED';
    return {
      id: record.id,
      projectId: record.projectId,
      workflowRunId: record.workflowRunId,
      productId: record.productId,
      productName: record.product.name.trim() || '未命名产品',
      sourcePrompt: {
        artifactId: record.sourcePromptArtifactId,
        revision: record.sourcePromptRevision,
        contentHash: record.sourcePromptHash,
      },
      status: record.status,
      stale,
      revision: record.revision,
      commitStatus,
      workingArtifactRevision: artifact?.revision ?? null,
      summary: summary(record),
      tasks: record.tasks.map((task) => presentTask(task, record.product.name)),
      createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString(),
    };
  }

  async workspace(
    projectId: string,
    workflowRunId: string,
    productId: string,
  ): Promise<GetEffectSegmentRenderWorkspaceData> {
    await this.projects.get(projectId);
    if (!(await this.repository.workflowRun(projectId, workflowRunId)))
      throw notFound('效果类工作流运行不存在');
    if (!(await this.repository.product(projectId, workflowRunId, productId)))
      throw notFound('产品不存在');
    const [prompt, batch, settingsNode] = await Promise.all([
      this.repository.promptArtifact(projectId, workflowRunId, productId),
      this.repository.latestBatch(projectId, workflowRunId, productId),
      this.workingRepository.findNodeState(
        projectId,
        workflowRunId,
        effectSegmentRenderSettingsNodeId(productId),
      ),
    ]);
    const promptReady = Boolean(
      prompt?.payload && prompt.freshness === 'CURRENT' && prompt.availability === 'AVAILABLE',
    );
    return {
      projectId,
      workflowRunId,
      productId,
      promptReady,
      promptArtifactRevision: promptReady ? (prompt?.revision ?? null) : null,
      settings:
        this.settingsFromState(settingsNode?.state) ?? this.legacySettings(prompt?.payload ?? null),
      settingsRevision: settingsNode?.revision ?? null,
      batch: batch ? await this.present(batch) : null,
    };
  }

  async saveSettings(
    projectId: string,
    productId: string,
    workflowRunId: string,
    expectedRevision: number | null,
    settings: EffectSegmentRenderSettings,
  ) {
    await this.projects.get(projectId);
    if (!(await this.repository.workflowRun(projectId, workflowRunId)))
      throw notFound('效果类工作流运行不存在');
    if (!(await this.repository.product(projectId, workflowRunId, productId)))
      throw notFound('产品不存在');
    const normalized = this.settingsFromState(settings);
    if (!normalized) throw badRequest('视频渲染设置不符合当前模型能力');
    const hash = workflowStateHash(normalized);
    const result = await this.workingRepository.saveNodeState(
      projectId,
      workflowRunId,
      effectSegmentRenderSettingsNodeId(productId),
      hash,
      normalized,
      expectedRevision,
      1,
      hash,
      1,
    );
    if (result.conflict) throw conflict('视频渲染设置已在其他页面更新，请刷新后重试');
    return {
      productId,
      settings: normalized,
      settingsRevision: result.record.revision,
      unchanged: result.unchanged,
      savedAt: result.record.savedAt.toISOString(),
    };
  }

  async batch(projectId: string, batchId: string): Promise<{ batch: EffectSegmentRenderBatch }> {
    await this.projects.get(projectId);
    const record = await this.repository.batch(projectId, batchId);
    if (!record) throw notFound('视频渲染批次不存在');
    return { batch: await this.present(record) };
  }

  async start(
    projectId: string,
    productId: string,
    input: {
      workflowRunId: string;
      expectedPromptArtifactRevision: number;
      expectedSettingsRevision: number;
      idempotencyKey: string;
    },
  ): Promise<StartEffectSegmentRenderBatchData> {
    await this.projects.get(projectId);
    const idempotencyKey = input.idempotencyKey.trim();
    if (!idempotencyKey) throw badRequest('幂等键不能为空');
    const model = this.config.get<string>('SEEDANCE_MODEL')?.trim();
    if (!model) throw conflict('Seedance 模型尚未配置');
    const [workflow, product, promptArtifact, sourcePackage, settingsNode] = await Promise.all([
      this.repository.workflowRun(projectId, input.workflowRunId),
      this.repository.product(projectId, input.workflowRunId, productId),
      this.repository.promptArtifact(projectId, input.workflowRunId, productId),
      this.repository.sourcePackageArtifact(projectId, input.workflowRunId, productId),
      this.workingRepository.findNodeState(
        projectId,
        input.workflowRunId,
        effectSegmentRenderSettingsNodeId(productId),
      ),
    ]);
    if (!workflow) throw notFound('效果类工作流运行不存在');
    if (!product) throw notFound('产品不存在');
    if (
      !promptArtifact?.payload ||
      promptArtifact.freshness !== 'CURRENT' ||
      promptArtifact.availability !== 'AVAILABLE'
    )
      throw conflict('Prompt 批次尚未完成校验');
    if (promptArtifact.revision !== input.expectedPromptArtifactRevision)
      throw conflict('Prompt 批次已更新，请刷新后重试');
    if (
      !sourcePackage ||
      sourcePackage.freshness !== 'CURRENT' ||
      sourcePackage.availability !== 'AVAILABLE'
    )
      throw conflict('产品资料包尚未完成校验');
    const inputImages = sourcePackage.files
      .filter(
        ({ role, fileObject }) => role === 'PRODUCT_IMAGE' && fileObject.status === 'AVAILABLE',
      )
      .map(({ fileObject, sortOrder }) => ({
        fileObjectId: fileObject.id,
        originalFileName: fileObject.originalFileName,
        mimeType: fileObject.mimeType.toLocaleLowerCase('en-US'),
        sizeBytes: fileObject.sizeBytes,
        contentHash: fileObject.sha256,
        sortOrder,
      }));
    if (!inputImages.length) throw conflict('产品资料包至少需要一张可用商品图片');
    const referenceImageLimit = /seedance[-_.]?2[-_.]?5/iu.test(model)
      ? EFFECT_SEGMENT_RENDER_LIMITS.maxReferenceImages
      : EFFECT_SEGMENT_RENDER_LIMITS.maxReferenceImagesSeedance20;
    if (inputImages.length > referenceImageLimit)
      throw badRequest(
        `当前 Seedance 模型单任务最多支持 ${referenceImageLimit} 张参考图，请减少商品图片后重试`,
      );
    const unsupportedImage = inputImages.find(
      ({ mimeType, sizeBytes }) =>
        !SUPPORTED_REFERENCE_IMAGE_MIME_TYPES.has(mimeType) ||
        sizeBytes < 1 ||
        sizeBytes > EFFECT_SEGMENT_RENDER_LIMITS.maxReferenceImageBytes,
    );
    if (unsupportedImage)
      throw badRequest(
        `商品图片 ${unsupportedImage.originalFileName} 的格式或大小不受 Seedance 支持`,
      );
    const estimatedBase64RequestBytes = inputImages.reduce(
      (total, image) => total + 4 * Math.ceil(image.sizeBytes / 3) + image.mimeType.length + 32,
      0,
    );
    if (
      estimatedBase64RequestBytes + 1024 * 1024 >
      EFFECT_SEGMENT_RENDER_LIMITS.maxBase64ProviderRequestBytes
    )
      throw badRequest('全部商品图片转为 Seedance Base64 请求后超过 64 MB，请压缩图片后重试');
    const promptBatch = parseEffectPromptBatchResult(promptArtifact.payload);
    if (!promptBatch) throw conflict('Prompt 批次结构无效，请重新生成并校验');
    this.assertRenderablePromptBatch(promptBatch);
    if ((settingsNode?.revision ?? 0) !== input.expectedSettingsRevision)
      throw conflict('视频渲染设置已更新，请刷新后重试');
    const renderSettings = settingsNode
      ? this.settingsFromState(settingsNode.state)
      : this.legacySettings(promptArtifact.payload);
    if (!renderSettings) throw conflict('视频渲染设置无效，请重新保存');
    const snapshots = promptBatch.items.map((item) => {
      const compiled = compileEffectSeedanceRequest(promptBatch, item.id, model, renderSettings);
      return {
        ...compiled,
        promptCode: item.code,
        promptText: item.content,
        sourcePackage: {
          artifactId: sourcePackage.id,
          revision: sourcePackage.revision,
          contentHash: sourcePackage.contentHash,
        },
        inputImages,
      } satisfies EffectSegmentRenderRequestSnapshot;
    });
    const requestHash = workflowStateHash({
      projectId,
      workflowRunId: input.workflowRunId,
      productId,
      promptArtifactId: promptArtifact.id,
      promptArtifactRevision: promptArtifact.revision,
      promptArtifactHash: promptArtifact.contentHash,
      sourcePackageArtifactId: sourcePackage.id,
      sourcePackageRevision: sourcePackage.revision,
      sourcePackageHash: sourcePackage.contentHash,
      renderSettings,
      renderSettingsRevision: settingsNode?.revision ?? 0,
      snapshots,
    });
    const batchId = randomUUID();
    const result = await this.repository.createBatch(projectId, input.workflowRunId, productId, {
      batchId,
      promptArtifact: {
        id: promptArtifact.id,
        revision: promptArtifact.revision,
        contentHash: promptArtifact.contentHash,
      },
      sourcePackage: {
        id: sourcePackage.id,
        revision: sourcePackage.revision,
        contentHash: sourcePackage.contentHash,
      },
      inputImages,
      sourceFingerprint: workflowStateHash({
        promptArtifact: {
          artifactId: promptArtifact.id,
          revision: promptArtifact.revision,
          contentHash: promptArtifact.contentHash,
        },
        sourcePackage: {
          artifactId: sourcePackage.id,
          revision: sourcePackage.revision,
          contentHash: sourcePackage.contentHash,
        },
        inputImages,
      }),
      idempotencyKey,
      requestHash,
      tasks: snapshots.map((snapshot, index) => ({
        id: randomUUID(),
        promptId: snapshot.promptId,
        promptCode: snapshot.promptCode,
        renderCode: 'R-' + String(index + 1).padStart(3, '0'),
        sourceFingerprint: workflowStateHash(snapshot),
        requestSnapshot: snapshot,
      })),
    });
    if (result.kind === 'KEY_CONFLICT') throw conflict('幂等键已用于其他视频渲染请求');
    if (result.kind === 'ACTIVE_CONFLICT') throw conflict('当前产品已有进行中的视频渲染批次');
    if (result.kind === 'PROMPT_CONFLICT') throw conflict('Prompt 批次已更新，请刷新后重试');
    if (result.kind === 'SOURCE_CONFLICT') throw conflict('产品资料包已更新，请刷新后重试');
    if (result.kind === 'NOT_FOUND') throw notFound('工作流或产品不存在');
    return { batch: await this.present(result.batch), replayed: result.kind === 'REPLAYED' };
  }

  private assertRenderablePromptBatch(batch: EffectPromptBatchResult): void {
    if (
      batch.items.length < 1 ||
      batch.items.length > EFFECT_SEGMENT_RENDER_LIMITS.maxTasksPerBatch
    )
      throw badRequest('Prompt 数量不符合视频渲染批次限制');
    if (batch.items.some(({ classificationStatus }) => classificationStatus !== 'VERIFIED'))
      throw conflict('仍有 Prompt 尚未完成用途评估');
    if (new Set(batch.items.map(({ id }) => id)).size !== batch.items.length)
      throw conflict('Prompt 批次包含重复的稳定 ID');
  }

  async regenerate(
    projectId: string,
    batchId: string,
    taskIds: string[],
    expectedBatchRevision: number,
    idempotencyKeyValue: string,
  ): Promise<{ batch: EffectSegmentRenderBatch; replayed: boolean }> {
    await this.projects.get(projectId);
    const taskIdsNormalized = [...new Set(taskIds)];
    if (
      taskIdsNormalized.length < 1 ||
      taskIdsNormalized.length > EFFECT_SEGMENT_RENDER_LIMITS.maxTaskIdsPerOperation
    )
      throw badRequest('请选择需要重新生成的视频任务');
    const idempotencyKey = idempotencyKeyValue.trim();
    if (!idempotencyKey) throw badRequest('幂等键不能为空');
    const result = await this.repository.regenerateTasks(
      projectId,
      batchId,
      taskIdsNormalized,
      expectedBatchRevision,
      idempotencyKey,
    );
    if (result.kind === 'NOT_FOUND') throw notFound('视频渲染批次不存在');
    if (result.kind === 'REVISION_CONFLICT') throw conflict('视频渲染批次已更新，请刷新后重试');
    if (result.kind === 'NOT_LATEST') throw conflict('只能重新生成当前最新批次');
    if (result.kind === 'PROMPT_CONFLICT') throw conflict('Prompt 批次已更新，请重新创建渲染批次');
    if (result.kind === 'SOURCE_CONFLICT') throw conflict('产品资料包已更新，请重新创建渲染批次');
    if (result.kind === 'TASK_NOT_FOUND') throw notFound('所选视频任务不存在');
    if (result.kind === 'TASK_ACTIVE') throw conflict('所选任务仍在运行中');
    if (result.kind === 'TASK_REPAIR_PENDING')
      throw conflict('所选任务存在待处理的视频返修，请先采用或放弃返修结果');
    if (result.kind === 'ACTIVE_CONFLICT') throw conflict('当前产品已有进行中的视频渲染批次');
    if (result.kind === 'KEY_CONFLICT') throw conflict('幂等键已用于其他视频重生成请求');
    const record = await this.repository.batch(projectId, batchId);
    if (!record) throw notFound('视频渲染批次不存在');
    return { batch: await this.present(record), replayed: result.kind === 'REPLAYED' };
  }

  async startRepair(
    projectId: string,
    batchId: string,
    taskId: string,
    input: {
      expectedBatchRevision: number;
      expectedSourceVersion: number;
      startMs: number;
      endMs: number;
      instruction: string;
      region?: EffectSegmentRenderRepairRegion | null;
      idempotencyKey: string;
    },
  ): Promise<{ batch: EffectSegmentRenderBatch; replayed: boolean }> {
    await this.projects.get(projectId);
    const idempotencyKey = input.idempotencyKey.trim();
    if (!idempotencyKey) throw badRequest('幂等键不能为空');
    const instruction = input.instruction.trim();
    if (!instruction) throw badRequest('请填写需要修改的画面问题');
    if (instruction.length > EFFECT_SEGMENT_RENDER_LIMITS.maxRepairInstructionLength)
      throw badRequest('视频返修要求过长');
    const normalizedRegion =
      input.region === undefined || input.region === null ? null : repairRegion(input.region);
    if (input.region && !normalizedRegion) throw badRequest('视频返修框选区域无效');
    const publicBaseUrl = this.config.get<string>('SEEDANCE_REFERENCE_PUBLIC_BASE_URL')?.trim();
    const signingSecret = this.config.get<string>('SEEDANCE_REFERENCE_SIGNING_SECRET')?.trim();
    if (!publicBaseUrl || !signingSecret) throw conflict('Seedance 参考视频访问地址尚未配置');
    try {
      const parsed = new URL(publicBaseUrl);
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('invalid protocol');
    } catch {
      throw conflict('Seedance 参考视频访问地址配置无效');
    }
    const record = await this.repository.batch(projectId, batchId);
    if (!record) throw notFound('视频渲染批次不存在');
    const task = record.tasks.find(({ id }) => id === taskId);
    if (!task) throw notFound('视频渲染任务不存在');
    if (
      task.status !== 'COMPLETED' ||
      !task.outputFileObjectId ||
      !task.outputFileName ||
      !task.outputMimeType ||
      task.outputSizeBytes === null ||
      !task.outputContentHash ||
      task.activeOutputVersion === null
    )
      throw conflict('当前视频尚未生成完成，不能进行画面返修');
    if (task.repairStatus !== null) throw conflict('当前视频已有待处理的返修任务');
    if (task.activeOutputVersion !== input.expectedSourceVersion)
      throw conflict('当前采用的视频版本已更新，请刷新后重试');
    const generationSnapshot = requestSnapshot(task.generationRequestSnapshot);
    const durationMs = generationSnapshot.request.duration * 1000;
    if (generationSnapshot.request.duration > 15)
      throw badRequest('第一版局部返修只支持最长 15 秒的视频');
    if (
      input.startMs < 0 ||
      input.endMs - input.startMs < EFFECT_SEGMENT_RENDER_LIMITS.minRepairDurationMs ||
      input.endMs > durationMs
    )
      throw badRequest('视频返修时间范围无效');
    const mimeType = task.outputMimeType.toLocaleLowerCase('en-US');
    if (
      !SUPPORTED_REFERENCE_VIDEO_MIME_TYPES.has(mimeType) ||
      task.outputSizeBytes > EFFECT_SEGMENT_RENDER_LIMITS.maxReferenceVideoBytes
    )
      throw badRequest('当前视频格式或大小不符合 Seedance 参考视频要求');
    const repairInput = {
      sourceVersion: task.activeOutputVersion,
      startMs: input.startMs,
      endMs: input.endMs,
      instruction,
      region: normalizedRegion,
    };
    const snapshot = compileEffectSeedanceRepairRequest(
      generationSnapshot,
      {
        fileObjectId: task.outputFileObjectId,
        originalFileName: task.outputFileName,
        mimeType,
        sizeBytes: task.outputSizeBytes,
        contentHash: task.outputContentHash,
        durationSeconds: generationSnapshot.request.duration,
      },
      repairInput,
    );
    const requestHash = workflowStateHash({
      batchId,
      taskId,
      sourceVersion: task.activeOutputVersion,
      sourceContentHash: task.outputContentHash,
      request: snapshot.request,
      repair: repairInput,
    });
    const result = await this.repository.startRepair(
      projectId,
      batchId,
      taskId,
      input.expectedBatchRevision,
      input.expectedSourceVersion,
      idempotencyKey,
      requestHash,
      workflowStateHash(snapshot),
      snapshot,
      repairInput,
    );
    if (result.kind === 'KEY_CONFLICT') throw conflict('幂等键已用于其他视频返修请求');
    if (result.kind === 'NOT_FOUND') throw notFound('视频渲染批次不存在');
    if (result.kind === 'REVISION_CONFLICT') throw conflict('视频渲染批次已更新，请刷新后重试');
    if (result.kind === 'NOT_LATEST') throw conflict('只能返修当前最新批次的视频');
    if (result.kind === 'TASK_NOT_FOUND') throw notFound('视频渲染任务不存在');
    if (result.kind === 'TASK_NOT_READY') throw conflict('当前视频尚未生成完成');
    if (result.kind === 'TASK_REPAIR_PENDING') throw conflict('当前视频已有待处理的返修任务');
    if (result.kind === 'SOURCE_VERSION_CONFLICT')
      throw conflict('当前采用的视频版本已更新，请刷新后重试');
    if (result.kind === 'PROMPT_CONFLICT') throw conflict('Prompt 批次已更新，请重新创建渲染批次');
    if (result.kind === 'SOURCE_CONFLICT') throw conflict('产品资料包已更新，请重新创建渲染批次');
    if (result.kind === 'ACTIVE_CONFLICT') throw conflict('当前产品已有进行中的视频任务');
    const updated = await this.repository.batch(projectId, batchId);
    if (!updated) throw notFound('视频渲染批次不存在');
    return { batch: await this.present(updated), replayed: result.kind === 'REPLAYED' };
  }

  async decideRepair(
    projectId: string,
    batchId: string,
    taskId: string,
    expectedBatchRevision: number,
    repairVersion: number,
    decision: EffectSegmentRenderRepairDecision,
    idempotencyKeyValue: string,
  ): Promise<{ batch: EffectSegmentRenderBatch; replayed: boolean }> {
    await this.projects.get(projectId);
    const idempotencyKey = idempotencyKeyValue.trim();
    if (!idempotencyKey) throw badRequest('幂等键不能为空');
    const result = await this.repository.decideRepair(
      projectId,
      batchId,
      taskId,
      expectedBatchRevision,
      repairVersion,
      decision,
      idempotencyKey,
    );
    if (result.kind === 'KEY_CONFLICT') throw conflict('幂等键已用于其他返修决定');
    if (result.kind === 'NOT_FOUND') throw notFound('视频渲染批次不存在');
    if (result.kind === 'REVISION_CONFLICT') throw conflict('视频渲染批次已更新，请刷新后重试');
    if (result.kind === 'NOT_LATEST') throw conflict('只能处理当前最新批次的视频返修');
    if (result.kind === 'TASK_NOT_FOUND') throw notFound('视频渲染任务不存在');
    if (result.kind === 'REPAIR_NOT_READY') throw conflict('视频返修候选尚未生成完成');
    if (result.kind === 'REPAIR_CONFLICT') throw conflict('视频返修状态或来源版本已更新');
    const updated = await this.repository.batch(projectId, batchId);
    if (!updated) throw notFound('视频渲染批次不存在');
    return { batch: await this.present(updated), replayed: result.kind === 'REPLAYED' };
  }

  async claim(projectId: string, taskId: string) {
    const result = await this.repository.claim(projectId, taskId);
    if (result.kind === 'NOT_FOUND') throw notFound('视频渲染任务不存在');
    if (result.kind === 'LEASE_CONFLICT') throw conflict('视频渲染任务已被其他 Worker 领取');
    if (result.kind === 'TERMINAL')
      return {
        terminal: true,
        taskId,
        taskVersion: result.task.renderVersion,
        attemptToken: null,
        sourceFingerprint: result.task.sourceFingerprint,
        providerTaskId: result.task.providerTaskId,
        input: null,
      };
    return {
      terminal: false,
      taskId,
      taskVersion: result.task.renderVersion,
      attemptToken: result.task.attemptToken,
      sourceFingerprint: result.task.sourceFingerprint,
      providerTaskId: result.task.providerTaskId,
      input: requestSnapshot(result.task.requestSnapshot),
    };
  }

  async referenceImage(
    projectId: string,
    taskId: string,
    fileObjectId: string,
    attemptToken: string,
    taskVersion: number,
  ) {
    if (!attemptToken) throw conflict('视频渲染任务租约无效');
    const task = await this.repository.task(projectId, taskId);
    if (!task) throw notFound('视频渲染任务不存在');
    if (
      task.status !== 'RUNNING' ||
      task.renderVersion !== taskVersion ||
      task.attemptToken !== attemptToken ||
      !task.leaseExpiresAt ||
      task.leaseExpiresAt <= new Date()
    )
      throw conflict('视频渲染任务租约或版本已失效');
    const snapshot = requestSnapshot(task.requestSnapshot);
    const image = snapshot.inputImages?.find((item) => item.fileObjectId === fileObjectId);
    if (!image) throw notFound('视频渲染参考图不存在');
    const fileObject = await this.repository.fileObject(
      projectId,
      task.workflowRunId,
      fileObjectId,
    );
    if (
      !fileObject ||
      fileObject.sha256 !== image.contentHash ||
      fileObject.sizeBytes !== image.sizeBytes ||
      fileObject.mimeType.toLocaleLowerCase('en-US') !== image.mimeType
    )
      throw conflict('视频渲染参考图已失效');
    return {
      ...image,
      ...(await this.storage.open(fileObject.storageKey)),
    };
  }

  async referenceVideoUrl(
    projectId: string,
    taskId: string,
    attemptToken: string,
    taskVersion: number,
  ): Promise<{ url: string; expiresAt: string }> {
    if (!attemptToken) throw conflict('视频渲染任务租约无效');
    const task = await this.repository.task(projectId, taskId);
    if (!task) throw notFound('视频渲染任务不存在');
    if (
      task.status !== 'RUNNING' ||
      task.operationKind !== 'REPAIR' ||
      task.renderVersion !== taskVersion ||
      task.attemptToken !== attemptToken ||
      !task.leaseExpiresAt ||
      task.leaseExpiresAt <= new Date()
    )
      throw conflict('视频返修任务租约或版本已失效');
    const snapshot = requestSnapshot(task.requestSnapshot);
    const video = snapshot.inputVideo;
    if (
      snapshot.operation !== 'REPAIR' ||
      !video ||
      video.fileObjectId !== task.outputFileObjectId ||
      video.contentHash !== task.outputContentHash ||
      snapshot.repair?.sourceVersion !== task.activeOutputVersion
    )
      throw conflict('视频返修来源快照已失效');
    const publicBaseUrl = this.config.get<string>('SEEDANCE_REFERENCE_PUBLIC_BASE_URL')?.trim();
    const signingSecret = this.config.get<string>('SEEDANCE_REFERENCE_SIGNING_SECRET')?.trim();
    if (!publicBaseUrl || !signingSecret) throw conflict('Seedance 参考视频访问地址尚未配置');
    const expires = Math.floor(Date.now() / 1000) + 30 * 60;
    const signaturePayload = [
      task.projectId,
      taskId,
      String(taskVersion),
      video.fileObjectId,
      video.contentHash,
      String(expires),
    ].join(':');
    const signature = createHmac('sha256', signingSecret)
      .update(signaturePayload)
      .digest('base64url');
    let url: URL;
    try {
      url = new URL(
        `provider-inputs/effect-segment-render/${encodeURIComponent(taskId)}/${encodeURIComponent(video.fileObjectId)}`,
        publicBaseUrl.replace(/\/+$/u, '') + '/',
      );
    } catch {
      throw conflict('Seedance 参考视频访问地址配置无效');
    }
    url.searchParams.set('taskVersion', String(taskVersion));
    url.searchParams.set('expires', String(expires));
    url.searchParams.set('signature', signature);
    return { url: url.toString(), expiresAt: new Date(expires * 1000).toISOString() };
  }

  async providerReferenceVideo(
    taskId: string,
    fileObjectId: string,
    taskVersion: number,
    expires: number,
    signature: string,
    rangeHeader?: string,
  ) {
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (expires < nowSeconds || expires > nowSeconds + 60 * 60)
      throw conflict('Seedance 参考视频访问地址已过期');
    const task = await this.repository.taskById(taskId);
    if (!task || task.renderVersion !== taskVersion || task.operationKind !== 'REPAIR')
      throw notFound('Seedance 参考视频不存在');
    const snapshot = requestSnapshot(task.requestSnapshot);
    const video = snapshot.inputVideo;
    if (
      snapshot.operation !== 'REPAIR' ||
      !video ||
      video.fileObjectId !== fileObjectId ||
      video.fileObjectId !== task.outputFileObjectId ||
      video.contentHash !== task.outputContentHash ||
      snapshot.repair?.sourceVersion !== task.activeOutputVersion
    )
      throw conflict('Seedance 参考视频来源快照已失效');
    const signingSecret = this.config.get<string>('SEEDANCE_REFERENCE_SIGNING_SECRET')?.trim();
    if (!signingSecret) throw conflict('Seedance 参考视频签名配置缺失');
    const expected = createHmac('sha256', signingSecret)
      .update(
        [
          task.projectId,
          taskId,
          String(taskVersion),
          fileObjectId,
          video.contentHash,
          String(expires),
        ].join(':'),
      )
      .digest('base64url');
    if (!safeSignatureEquals(signature, expected)) throw conflict('Seedance 参考视频签名无效');
    const fileObject = await this.repository.fileObject(
      task.projectId,
      task.workflowRunId,
      fileObjectId,
    );
    if (
      !fileObject ||
      fileObject.sha256 !== video.contentHash ||
      fileObject.sizeBytes !== video.sizeBytes ||
      fileObject.mimeType.toLocaleLowerCase('en-US') !== video.mimeType
    )
      throw conflict('Seedance 参考视频文件已失效');
    const range = parseByteRange(rangeHeader, fileObject.sizeBytes);
    return {
      mimeType: fileObject.mimeType,
      originalFileName: fileObject.originalFileName,
      partial: Boolean(range),
      ...(await this.storage.open(fileObject.storageKey, range)),
    };
  }

  async taskContent(
    projectId: string,
    batchId: string,
    taskId: string,
    variant: 'ACTIVE' | 'REPAIR',
    rangeHeader?: string,
  ) {
    await this.projects.get(projectId);
    const task = await this.repository.task(projectId, taskId);
    if (!task || task.batchId !== batchId) throw notFound('视频渲染任务不存在');
    const metadata =
      variant === 'REPAIR'
        ? {
            fileObjectId: task.repairCandidateFileObjectId,
            originalFileName: task.repairCandidateFileName,
            mimeType: task.repairCandidateMimeType,
            sizeBytes: task.repairCandidateSizeBytes,
            contentHash: task.repairCandidateContentHash,
          }
        : {
            fileObjectId: task.outputFileObjectId,
            originalFileName: task.outputFileName,
            mimeType: task.outputMimeType,
            sizeBytes: task.outputSizeBytes,
            contentHash: task.outputContentHash,
          };
    if (
      !metadata.fileObjectId ||
      !metadata.originalFileName ||
      !metadata.mimeType ||
      metadata.sizeBytes === null ||
      !metadata.contentHash
    )
      throw notFound(variant === 'REPAIR' ? '视频返修候选不存在' : '视频渲染输出不存在');
    const fileObject = await this.repository.fileObject(
      projectId,
      task.workflowRunId,
      metadata.fileObjectId,
    );
    if (
      !fileObject ||
      fileObject.sha256 !== metadata.contentHash ||
      fileObject.sizeBytes !== metadata.sizeBytes
    )
      throw conflict('视频文件已失效');
    const range = parseByteRange(rangeHeader, fileObject.sizeBytes);
    return {
      mimeType: metadata.mimeType,
      originalFileName: metadata.originalFileName,
      partial: Boolean(range),
      ...(await this.storage.open(fileObject.storageKey, range)),
    };
  }

  async heartbeat(
    projectId: string,
    taskId: string,
    attemptToken: string,
    taskVersion: number,
    progress: number,
    providerTaskId?: string,
  ): Promise<{ accepted: true }> {
    if (!attemptToken) throw conflict('视频渲染任务租约无效');
    const result = await this.repository.heartbeat(
      projectId,
      taskId,
      attemptToken,
      taskVersion,
      progress,
      providerTaskId?.trim() || undefined,
    );
    if (result.count !== 1) throw conflict('视频渲染任务租约或版本已失效');
    return { accepted: true };
  }

  async complete(
    projectId: string,
    taskId: string,
    attemptToken: string,
    input: {
      taskVersion: number;
      providerTaskId: string;
      duration?: number;
      ratio?: string;
      resolution?: string;
    },
    file: UploadedSegmentRenderFile | undefined,
  ): Promise<{ completed: true; fileObjectId: string }> {
    if (!attemptToken) throw conflict('视频渲染任务租约无效');
    const providerTaskId = input.providerTaskId.trim();
    if (!providerTaskId) throw badRequest('Seedance 任务 ID 不能为空');
    const task = await this.repository.task(projectId, taskId);
    if (!task) throw notFound('视频渲染任务不存在');
    if (task.status === 'COMPLETED' && task.renderVersion === input.taskVersion) {
      const replayedFileObjectId =
        task.operationKind === 'REPAIR'
          ? task.repairCandidateFileObjectId
          : task.outputFileObjectId;
      if (!replayedFileObjectId) throw conflict('视频渲染输出文件不存在');
      return { completed: true, fileObjectId: replayedFileObjectId };
    }
    if (
      task.status !== 'RUNNING' ||
      task.renderVersion !== input.taskVersion ||
      task.attemptToken !== attemptToken
    )
      throw conflict('视频渲染任务租约或版本已失效');
    if (!file || file.size < 1) throw badRequest('视频渲染输出文件为空');
    if (file.size > EFFECT_SEGMENT_RENDER_LIMITS.maxUploadBytes)
      throw badRequest('视频渲染输出文件过大');
    const mimeType = file.mimetype.trim().toLocaleLowerCase('en-US');
    if (!mimeType.startsWith('video/')) throw badRequest('视频渲染输出文件类型无效');
    const snapshot = requestSnapshot(task.requestSnapshot);
    const issues = validateEffectSeedanceTaskResult(snapshot, {
      ...(input.duration !== undefined ? { duration: input.duration } : {}),
      ...(input.ratio !== undefined ? { ratio: input.ratio } : {}),
      ...(input.resolution !== undefined ? { resolution: input.resolution } : {}),
    });
    if (issues.length) throw badRequest('Seedance 输出参数与任务快照不一致');
    const project = await this.projects.get(projectId);
    const product = await this.repository.product(projectId, task.workflowRunId, task.productId);
    if (!product) throw notFound('产品不存在');
    const sha256 = await fileSha256(file.path);
    const originalFileName = safeFileName(
      file.originalname || task.renderCode + '-v' + String(task.renderVersion) + '.mp4',
    );
    const stored = await this.storage.put({
      projectId,
      stream: createReadStream(file.path),
      sizeBytes: file.size,
      contentType: mimeType,
      keyContext: {
        projectName: project.name,
        workflow: 'EFFECT',
        lifecycle: 'staging',
        productId: task.productId,
        productName: product.name.trim() || '未命名产品',
        category: 'AI视频片段',
        originalFileName,
      },
    });
    let committed = false;
    try {
      const result = await this.repository.complete(
        projectId,
        taskId,
        attemptToken,
        input.taskVersion,
        providerTaskId,
        {
          id: randomUUID(),
          originalFileName,
          mimeType,
          sizeBytes: stored.sizeBytes,
          storageKey: stored.key,
          sha256,
        },
      );
      if (result.kind === 'NOT_FOUND') throw notFound('视频渲染任务不存在');
      if (result.kind === 'LEASE_CONFLICT') throw conflict('视频渲染任务租约或版本已失效');
      committed = true;
      const fileObjectId =
        result.task.operationKind === 'REPAIR'
          ? result.task.repairCandidateFileObjectId
          : result.task.outputFileObjectId;
      if (!fileObjectId) throw conflict('视频渲染输出文件不存在');
      return { completed: true, fileObjectId };
    } finally {
      if (!committed) await this.storage.delete(stored.key).catch(() => undefined);
    }
  }

  async fail(
    projectId: string,
    taskId: string,
    attemptToken: string,
    input: {
      taskVersion: number;
      errorCode: string;
      errorMessage: string;
      retryable: boolean;
      providerTaskId?: string;
      resetProviderTask?: boolean;
    },
  ): Promise<{ outcome: 'FAILED' | 'REQUEUED' }> {
    const providerTaskId = input.providerTaskId?.trim().slice(0, 255);
    const outcome = await this.repository.fail(projectId, taskId, attemptToken, input.taskVersion, {
      errorCode: input.errorCode.trim().slice(0, 120) || 'SEEDANCE_UNKNOWN',
      errorMessage: input.errorMessage.trim().slice(0, 1000) || '视频渲染失败',
      retryable: input.retryable,
      ...(providerTaskId ? { providerTaskId } : {}),
      resetProviderTask: input.resetProviderTask === true,
    });
    if (outcome === 'NOT_FOUND') throw notFound('视频渲染任务不存在');
    if (outcome === 'LEASE_CONFLICT') throw conflict('视频渲染任务租约或版本已失效');
    return { outcome };
  }

  private artifactInputs(
    record: EffectSegmentRenderBatchRecord,
  ): Array<{ artifactKey: string; input: WorkingArtifactUpsertInput }> {
    const sourceSnapshot = sourcePackageSnapshot(record.tasks[0]?.requestSnapshot);
    const dependencies = [
      {
        sourceType: 'WORKING_ARTIFACT' as const,
        sourceNodeId: 'PROMPT_GENERATION',
        sourceArtifactId: record.sourcePromptArtifactId,
        sourceKey: 'prompt-batch:' + record.productId,
        sourceRevision: record.sourcePromptRevision,
        sourceHash: record.sourcePromptHash,
      },
      ...(sourceSnapshot
        ? [
            {
              sourceType: 'WORKING_ARTIFACT' as const,
              sourceNodeId: 'SOURCE_IMPORT',
              sourceArtifactId: sourceSnapshot.artifactId,
              sourceKey: 'source-package:' + record.productId,
              sourceRevision: sourceSnapshot.revision,
              sourceHash: sourceSnapshot.contentHash,
            },
          ]
        : []),
    ];
    const completed = record.tasks.filter(
      (task) =>
        task.status === 'COMPLETED' &&
        task.outputFileObjectId &&
        task.outputStorageKey &&
        task.outputFileName &&
        task.outputMimeType &&
        task.outputSizeBytes !== null &&
        task.outputContentHash,
    );
    const clips = completed.map((task) => {
      const snapshot = requestSnapshot(task.requestSnapshot);
      return {
        taskId: task.id,
        renderCode: task.renderCode,
        promptId: task.promptId,
        promptCode: task.promptCode,
        promptContentHash: snapshot.promptContentHash,
        primaryPurpose: snapshot.primaryPurpose,
        compatiblePurposes: snapshot.compatiblePurposes,
        durationSeconds: snapshot.request.duration,
        ratio: snapshot.request.ratio,
        resolution: snapshot.request.resolution,
        version: task.activeOutputVersion ?? task.renderVersion,
        fileObjectId: task.outputFileObjectId!,
        contentHash: task.outputContentHash!,
      };
    });
    const clipArtifacts = completed.map((task) => {
      const snapshot = requestSnapshot(task.requestSnapshot);
      return {
        artifactKey: 'render-clip:' + task.id,
        input: {
          kind: 'FILE',
          name: record.product.name + ' ' + task.renderCode + ' 视频片段',
          directory: 'VIDEO_MATERIALS',
          type: 'VIDEO_MATERIAL',
          tags: ['效果类', 'AI视频片段', snapshot.primaryPurpose],
          payload: clips.find(({ taskId }) => taskId === task.id),
          metadata: { productId: record.productId, taskId: task.id, promptId: task.promptId },
          originalFileName: task.outputFileName!,
          mimeType: task.outputMimeType!,
          sizeBytes: task.outputSizeBytes!,
          storageKey: task.outputStorageKey!,
          fileChecksum: task.outputContentHash!,
          sourceRunId: task.id,
          sourceArtifactId: task.promptId,
          dependencies,
        } satisfies WorkingArtifactUpsertInput,
      };
    });
    const batchArtifact = {
      artifactKey: 'render-batch:' + record.productId,
      input: {
        kind: 'STRUCTURED',
        name: record.product.name + ' AI 视频片段素材池',
        directory: 'VIDEO_MATERIALS',
        type: 'VIDEO_MATERIAL',
        tags: ['效果类', 'AI视频片段', '素材池'],
        payload: {
          schemaVersion: 1,
          productId: record.productId,
          sourcePrompt: {
            artifactId: record.sourcePromptArtifactId,
            revision: record.sourcePromptRevision,
            contentHash: record.sourcePromptHash,
          },
          clips,
        },
        metadata: {
          productId: record.productId,
          completedCount: completed.length,
          failedCount: record.tasks.filter(({ status }) => status === 'FAILED').length,
        },
        sourceRunId: record.id,
        sourceArtifactId: record.id,
        files: completed.map((task, index) => ({
          fileObjectId: task.outputFileObjectId!,
          role: 'SEGMENT_CLIP',
          sortOrder: index,
          originalFileName: task.outputFileName!,
          mimeType: task.outputMimeType!,
          sha256: task.outputContentHash!,
        })),
        dependencies,
      } satisfies WorkingArtifactUpsertInput,
    };
    return [...clipArtifacts, batchArtifact];
  }

  async validate(
    projectId: string,
    batchId: string,
    expectedBatchRevision: number,
  ): Promise<ValidateEffectSegmentRenderBatchData> {
    await this.projects.get(projectId);
    const record = await this.repository.batch(projectId, batchId);
    if (!record) throw notFound('视频渲染批次不存在');
    if (record.revision !== expectedBatchRevision)
      throw conflict('视频渲染批次已更新，请刷新后重试');
    const issues: Array<{ code: string; message: string }> = [];
    if (record.tasks.some(({ status }) => status === 'QUEUED' || status === 'RUNNING'))
      issues.push({ code: 'TASKS_RUNNING', message: '仍有视频片段正在渲染' });
    if (record.tasks.some(({ status }) => status === 'FAILED'))
      issues.push({ code: 'TASKS_FAILED', message: '仍有视频片段渲染异常，请重新生成' });
    if (record.tasks.some(({ outputFileObjectId }) => !outputFileObjectId))
      issues.push({ code: 'OUTPUT_MISSING', message: '仍有视频片段缺少输出文件' });
    if (record.tasks.some(({ repairStatus }) => repairStatus !== null))
      issues.push({ code: 'REPAIR_PENDING', message: '仍有视频返修结果等待采用或放弃' });
    const [currentPrompt, currentSourcePackage] = await Promise.all([
      this.repository.promptArtifact(projectId, record.workflowRunId, record.productId),
      this.repository.sourcePackageArtifact(projectId, record.workflowRunId, record.productId),
    ]);
    if (
      !currentPrompt ||
      currentPrompt.freshness !== 'CURRENT' ||
      currentPrompt.availability !== 'AVAILABLE' ||
      currentPrompt.id !== record.sourcePromptArtifactId ||
      currentPrompt.revision !== record.sourcePromptRevision ||
      currentPrompt.contentHash !== record.sourcePromptHash
    )
      issues.push({ code: 'PROMPT_STALE', message: 'Prompt 批次已更新，请重新创建渲染批次' });
    const sourceSnapshot = sourcePackageSnapshot(record.tasks[0]?.requestSnapshot);
    if (
      !sourceSnapshot ||
      !currentSourcePackage ||
      currentSourcePackage.freshness !== 'CURRENT' ||
      currentSourcePackage.availability !== 'AVAILABLE' ||
      currentSourcePackage.id !== sourceSnapshot.artifactId ||
      currentSourcePackage.revision !== sourceSnapshot.revision ||
      currentSourcePackage.contentHash !== sourceSnapshot.contentHash
    )
      issues.push({ code: 'SOURCE_STALE', message: '产品资料包已更新，请重新创建渲染批次' });
    if (issues.length)
      return {
        valid: false,
        issues,
        productId: record.productId,
        artifacts: [],
        validatedAt: new Date().toISOString(),
      };
    const result = await this.repository.commitValidatedBatch(
      projectId,
      batchId,
      expectedBatchRevision,
      sourceSnapshot!,
      this.artifactInputs(record),
    );
    if (result.kind === 'REVISION_CONFLICT') throw conflict('视频渲染批次已更新，请刷新后重试');
    if (result.kind === 'PROMPT_CONFLICT') throw conflict('Prompt 批次已更新，请重新创建渲染批次');
    if (result.kind === 'SOURCE_CONFLICT') throw conflict('产品资料包已更新，请重新创建渲染批次');
    if (result.kind === 'NOT_READY') throw conflict('视频渲染批次尚未完成');
    if (result.kind === 'NOT_FOUND') throw notFound('视频渲染批次不存在');
    return {
      valid: true,
      issues: [],
      productId: record.productId,
      artifacts: result.artifacts,
      validatedAt: new Date().toISOString(),
    };
  }
}
