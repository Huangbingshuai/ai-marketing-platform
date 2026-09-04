import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';

import type {
  EffectPromptBatchResult,
  EffectSegmentRenderSettings,
  EffectSegmentRenderBatch,
  EffectSegmentRenderRequestSnapshot,
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

const requestSnapshot = (value: unknown): EffectSegmentRenderRequestSnapshot =>
  value as EffectSegmentRenderRequestSnapshot;

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
          version: task.renderVersion,
        }
      : null,
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
    const prompt = await this.repository.promptArtifact(
      record.projectId,
      record.workflowRunId,
      record.productId,
    );
    const stale = Boolean(
      !prompt ||
      prompt.freshness !== 'CURRENT' ||
      prompt.availability !== 'AVAILABLE' ||
      prompt.id !== record.sourcePromptArtifactId ||
      prompt.revision !== record.sourcePromptRevision ||
      prompt.contentHash !== record.sourcePromptHash,
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
    const [workflow, product, promptArtifact, settingsNode] = await Promise.all([
      this.repository.workflowRun(projectId, input.workflowRunId),
      this.repository.product(projectId, input.workflowRunId, productId),
      this.repository.promptArtifact(projectId, input.workflowRunId, productId),
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
      } satisfies EffectSegmentRenderRequestSnapshot;
    });
    const requestHash = workflowStateHash({
      projectId,
      workflowRunId: input.workflowRunId,
      productId,
      promptArtifactId: promptArtifact.id,
      promptArtifactRevision: promptArtifact.revision,
      promptArtifactHash: promptArtifact.contentHash,
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
      sourceFingerprint: workflowStateHash({
        artifactId: promptArtifact.id,
        revision: promptArtifact.revision,
        contentHash: promptArtifact.contentHash,
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
    if (result.kind === 'TASK_NOT_FOUND') throw notFound('所选视频任务不存在');
    if (result.kind === 'TASK_ACTIVE') throw conflict('所选任务仍在运行中');
    if (result.kind === 'ACTIVE_CONFLICT') throw conflict('当前产品已有进行中的视频渲染批次');
    if (result.kind === 'KEY_CONFLICT') throw conflict('幂等键已用于其他视频重生成请求');
    const record = await this.repository.batch(projectId, batchId);
    if (!record) throw notFound('视频渲染批次不存在');
    return { batch: await this.present(record), replayed: result.kind === 'REPLAYED' };
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
        input: null,
      };
    return {
      terminal: false,
      taskId,
      taskVersion: result.task.renderVersion,
      attemptToken: result.task.attemptToken,
      sourceFingerprint: result.task.sourceFingerprint,
      input: requestSnapshot(result.task.requestSnapshot),
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
      if (!task.outputFileObjectId) throw conflict('视频渲染输出文件不存在');
      return { completed: true, fileObjectId: task.outputFileObjectId };
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
      return { completed: true, fileObjectId: result.task.outputFileObjectId! };
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
    },
  ): Promise<{ outcome: 'FAILED' | 'REQUEUED' }> {
    const outcome = await this.repository.fail(projectId, taskId, attemptToken, input.taskVersion, {
      errorCode: input.errorCode.trim().slice(0, 120) || 'SEEDANCE_UNKNOWN',
      errorMessage: input.errorMessage.trim().slice(0, 1000) || '视频渲染失败',
      retryable: input.retryable,
    });
    if (outcome === 'NOT_FOUND') throw notFound('视频渲染任务不存在');
    if (outcome === 'LEASE_CONFLICT') throw conflict('视频渲染任务租约或版本已失效');
    return { outcome };
  }

  private artifactInputs(
    record: EffectSegmentRenderBatchRecord,
  ): Array<{ artifactKey: string; input: WorkingArtifactUpsertInput }> {
    const dependency = {
      sourceType: 'WORKING_ARTIFACT' as const,
      sourceNodeId: 'PROMPT_GENERATION',
      sourceArtifactId: record.sourcePromptArtifactId,
      sourceKey: 'prompt-batch:' + record.productId,
      sourceRevision: record.sourcePromptRevision,
      sourceHash: record.sourcePromptHash,
    };
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
        version: task.renderVersion,
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
          dependencies: [dependency],
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
        dependencies: [dependency],
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
    const currentPrompt = await this.repository.promptArtifact(
      projectId,
      record.workflowRunId,
      record.productId,
    );
    if (
      !currentPrompt ||
      currentPrompt.freshness !== 'CURRENT' ||
      currentPrompt.availability !== 'AVAILABLE' ||
      currentPrompt.id !== record.sourcePromptArtifactId ||
      currentPrompt.revision !== record.sourcePromptRevision ||
      currentPrompt.contentHash !== record.sourcePromptHash
    )
      issues.push({ code: 'PROMPT_STALE', message: 'Prompt 批次已更新，请重新创建渲染批次' });
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
      this.artifactInputs(record),
    );
    if (result.kind === 'REVISION_CONFLICT') throw conflict('视频渲染批次已更新，请刷新后重试');
    if (result.kind === 'PROMPT_CONFLICT') throw conflict('Prompt 批次已更新，请重新创建渲染批次');
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
