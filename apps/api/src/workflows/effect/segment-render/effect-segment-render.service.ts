import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';

import { ZipArchive } from 'archiver';
import type {
  EffectPromptBatchResult,
  EffectPromptRenderCapabilityKey,
  EffectSegmentRenderExportFormat,
  EffectSegmentRenderImportMapping,
  EffectSegmentRenderSettings,
  EffectSegmentRenderRepairDecision,
  EffectSegmentRenderRepairRegion,
  EffectSegmentRenderPoster,
  EffectSegmentRenderBatch,
  EffectSegmentRenderRequestSnapshot,
  EffectSegmentRenderSourcePackage,
  EffectSegmentRenderSummary,
  EffectSegmentRenderTask,
  EffectSegmentRenderUpdateKind,
  GetEffectSegmentRenderWorkspaceData,
  StartEffectSegmentRenderBatchData,
  ValidateEffectSegmentRenderBatchData,
  WorkingArtifact,
} from '@ai-marketing/contracts';
import {
  DEFAULT_EFFECT_SEGMENT_RENDER_SETTINGS,
  EFFECT_PROMPT_RENDER_CAPABILITIES,
  EFFECT_SEGMENT_RENDER_LIMITS,
  effectSegmentRenderSettingsNodeId,
  resolveEffectImportedRenderSettings,
  SEEDANCE_RESOLUTION_SHORT_SIDES,
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
import { WorkflowWorkingService } from '../../../platform/workflow/workflow-working.service';
import {
  compileEffectImportedSeedanceRequest,
  compileEffectSeedanceRepairRequest,
  compileEffectSeedanceRequest,
  EffectSeedanceCompileError,
  validateEffectSeedanceTaskResult,
} from './effect-seedance-request.compiler';
import {
  type EffectSegmentRenderBatchRecord,
  EffectSegmentRenderRepository,
} from './effect-segment-render.repository';
import type { UploadedSegmentRenderFile } from './effect-segment-render.types';
import { inspectImportVideo } from './effect-segment-import-media';
import { confirmedPromptBaseline, renderPromptBaseline, renderPromptUpdateKind } from './effect-segment-render-prompt-update';
import { parseEffectPromptBatchResult } from '../prompt-generation/effect-prompt.quality';

const notFound = (message: string): NotFoundException => new NotFoundException(message);
const conflict = (message: string): ConflictException => new ConflictException(message);
const badRequest = (message: string): BadRequestException => new BadRequestException(message);
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
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
const SEEDANCE_MODEL_CONFIG_KEYS: Record<EffectPromptRenderCapabilityKey, string> = {
  SEEDANCE_1_5_PRO: 'SEEDANCE_MODEL_2_5',
  SEEDANCE_2_0: 'SEEDANCE_MODEL_2_0',
  SEEDANCE_1_0: 'SEEDANCE_MODEL_2_0_MINI',
  SEEDANCE_2_0_FAST: 'SEEDANCE_MODEL_2_0_FAST',
};
const DEFAULT_SEEDANCE_MODELS: Record<EffectPromptRenderCapabilityKey, string> = {
  SEEDANCE_1_5_PRO: 'doubao-seedance-2-5-260628',
  SEEDANCE_2_0: 'doubao-seedance-2-0-260128',
  SEEDANCE_1_0: 'doubao-seedance-2-0-mini-260615',
  SEEDANCE_2_0_FAST: 'doubao-seedance-2-0-fast-260128',
};

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

const renderPoster = (value: unknown, version: number): EffectSegmentRenderPoster | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const poster = value as Record<string, unknown>;
  if (
    typeof poster.fileObjectId !== 'string' ||
    typeof poster.originalFileName !== 'string' ||
    typeof poster.mimeType !== 'string' ||
    typeof poster.sizeBytes !== 'number' ||
    !Number.isSafeInteger(poster.sizeBytes) ||
    poster.sizeBytes < 1 ||
    typeof poster.contentHash !== 'string' ||
    !SHA256_PATTERN.test(poster.contentHash) ||
    poster.version !== version
  )
    return null;
  return {
    fileObjectId: poster.fileObjectId,
    originalFileName: poster.originalFileName,
    mimeType: poster.mimeType,
    sizeBytes: poster.sizeBytes,
    contentHash: poster.contentHash,
    version,
  };
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

const insightProductName = (value: unknown): string | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const productName = (value as Record<string, unknown>).productName;
  return typeof productName === 'string' && productName.trim() ? productName.trim() : null;
};

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
      if (task.errorCode === 'MATERIAL_DELETED') return result;
      result.total += 1;
      if (task.status === 'COMPLETED') result.completed += 1;
      else if (task.status === 'FAILED') result.failed += 1;
      else result.running += 1;
      return result;
    },
    { total: 0, completed: 0, running: 0, failed: 0 },
  );

const activeMediaShortSide = (
  task: { providerTaskId: string | null },
  snapshot: EffectSegmentRenderRequestSnapshot,
): number =>
  task.providerTaskId
    ? SEEDANCE_RESOLUTION_SHORT_SIDES[snapshot.request.resolution]
    : snapshot.importedMaterial
      ? Math.min(snapshot.importedMaterial.width, snapshot.importedMaterial.height)
      : SEEDANCE_RESOLUTION_SHORT_SIDES[snapshot.request.resolution];

const presentTask = (
  task: EffectSegmentRenderBatchRecord['tasks'][number],
  productName: string,
  needsUpdate = false,
  updateKind?: EffectSegmentRenderUpdateKind,
): EffectSegmentRenderTask => {
  const requested = requestSnapshot(task.requestSnapshot);
  const snapshot = task.outputFileObjectId && requested.adoptedInput ? requested.adoptedInput : requested;
  const cancelledFailedReplacement = task.status === 'FAILED' && task.outputFileObjectId &&
    requested.refreshContext && requested.adoptedInput && !needsUpdate;
  const status =
    cancelledFailedReplacement ? 'COMPLETED' : task.status === 'RUNNING'
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
  const activeOutputVersion = task.activeOutputVersion ?? task.renderVersion;
  const outputPoster = renderPoster(task.outputPoster, activeOutputVersion);
  const repairPoster =
    task.repairCandidateVersion === null
      ? null
      : renderPoster(task.repairCandidatePoster, task.repairCandidateVersion);
  const repair =
    task.repairStatus &&
    task.repairSourceVersion !== null &&
    task.repairStartMs !== null &&
    task.repairEndMs !== null &&
    task.repairInstruction
      ? {
          version: task.renderVersion,
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
                poster: repairPoster,
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
    compatiblePurposes: [...snapshot.compatiblePurposes],
    ...(snapshot.creativeCore !== undefined || snapshot.dimensions !== undefined
      ? { creativeCore: snapshot.creativeCore ?? '', dimensions: snapshot.dimensions ?? {} }
      : {}),
    durationSeconds:
      (task.operationKind === 'REPAIR' ? requestSnapshot(task.generationRequestSnapshot) : snapshot)
        .outputDurationSeconds ?? snapshot.request.duration,
    source: 'PROMPT',
    origin: hasOutput && !task.providerTaskId ? 'EXTERNAL_IMPORT' : 'AI_GENERATED',
    ...(snapshot.importedMaterial
      ? {
          independentImport: true,
          mediaShortSidePixels: activeMediaShortSide(
            task,
            task.operationKind === 'REPAIR'
              ? requestSnapshot(task.generationRequestSnapshot)
              : snapshot,
          ),
        }
      : {}),
    sourceName: hasOutput && !task.providerTaskId ? task.outputFileName! : task.promptCode,
    status,
    progress: task.progress,
    retryCount: task.retryCount,
    maxAutoRetries: task.maxAutoRetries,
    abnormal: task.status === 'FAILED',
    needsUpdate,
    ...(updateKind ? { updateKind } : {}),
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
          version: activeOutputVersion,
          poster: outputPoster,
        }
      : null,
    repair,
    updatedAt: task.updatedAt.toISOString(),
  };
};

const promptTaskUpdateKind = (
  task: EffectSegmentRenderBatchRecord['tasks'][number],
  batch: EffectPromptBatchResult | null,
): EffectSegmentRenderUpdateKind | undefined => renderPromptUpdateKind(
  requestSnapshot(task.operationKind === 'REPAIR' ? task.generationRequestSnapshot : task.requestSnapshot),
  batch,
);

const promptTaskNeedsUpdate = (
  task: EffectSegmentRenderBatchRecord['tasks'][number],
  batch: EffectPromptBatchResult | null,
): boolean => Boolean(promptTaskUpdateKind(task, batch));

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
    @Inject(WorkflowWorkingService)
    private readonly workflowWorkingService: WorkflowWorkingService,
  ) {}

  private modelFor(capabilityKey: EffectPromptRenderCapabilityKey): string {
    const configKey = SEEDANCE_MODEL_CONFIG_KEYS[capabilityKey];
    const model =
      this.config.get<string>(configKey)?.trim() ||
      (capabilityKey === 'SEEDANCE_2_0'
        ? this.config.get<string>('SEEDANCE_MODEL')?.trim()
        : undefined) ||
      DEFAULT_SEEDANCE_MODELS[capabilityKey];
    return model;
  }

  private compileSeedanceRequest<T>(compile: () => T): T {
    try {
      return compile();
    } catch (error) {
      if (error instanceof EffectSeedanceCompileError) throw badRequest(error.message);
      throw error;
    }
  }

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
    const [prompt, sourcePackage, marketingInsight, settingsNode] = await Promise.all([
      this.repository.promptArtifact(record.projectId, record.workflowRunId, record.productId),
      this.repository.sourcePackageArtifact(
        record.projectId,
        record.workflowRunId,
        record.productId,
      ),
      this.repository.marketingInsightArtifact(
        record.projectId,
        record.workflowRunId,
        record.productId,
      ),
      this.workingRepository.findNodeState(record.projectId, record.workflowRunId,
        effectSegmentRenderSettingsNodeId(record.productId)),
    ]);
    const productName =
      insightProductName(marketingInsight?.payload) ?? (record.product.name.trim() || '未命名产品');
    const upstreamStale = Boolean(
      !prompt ||
      prompt.freshness !== 'CURRENT' ||
      prompt.availability !== 'AVAILABLE' ||
      !sourceSnapshot ||
      !sourcePackage ||
      sourcePackage.freshness !== 'CURRENT' ||
      sourcePackage.availability !== 'AVAILABLE' ||
      sourcePackage.id !== sourceSnapshot.artifactId ||
      sourcePackage.revision !== sourceSnapshot.revision ||
      sourcePackage.contentHash !== sourceSnapshot.contentHash,
    );
    const latestPromptBatch = prompt ? parseEffectPromptBatchResult(prompt.payload) : null;
    // Legacy tasks did not freeze creative metadata. Only fill it from the exact consumed
    // Prompt version, never from a sibling branch or a newer edited Prompt.
    const consumedPromptItems = prompt?.id === record.sourcePromptArtifactId &&
      prompt.revision === record.sourcePromptRevision && prompt.contentHash === record.sourcePromptHash
      ? new Map(latestPromptBatch?.items.map((item) => [item.id, item]) ?? [])
      : new Map<string, NonNullable<typeof latestPromptBatch>['items'][number]>();
    const updateKinds = new Map(record.tasks
      .filter((task) => task.errorCode !== 'MATERIAL_DELETED' || (
        requestSnapshot(task.requestSnapshot).removedBy === 'PROMPT' &&
        latestPromptBatch?.items.some((item) => item.id === task.promptId)))
      .map((task) => [task.id, upstreamStale &&
        !requestSnapshot(task.requestSnapshot).importedMaterial
        ? 'RENDER' as const : task.status === 'FAILED' && !task.outputFileObjectId && latestPromptBatch?.items.some(
          (item) => item.id === task.promptId) && !requestSnapshot(task.requestSnapshot).importedMaterial
          ? 'RENDER' as const : promptTaskUpdateKind(task, latestPromptBatch)]));
    const taskIdsNeedingUpdate = new Set([...updateKinds]
      .filter(([, kind]) => kind).map(([id]) => id));
    const pendingRemovedTaskIds = [...updateKinds]
      .filter(([, kind]) => kind === 'REMOVE').map(([id]) => id);
    const currentPromptIds = new Set(latestPromptBatch?.items.map(({ id }) => id) ?? []);
    const renderedPromptIds = new Set(
      record.tasks
        .filter((task) => !requestSnapshot(task.requestSnapshot).importedMaterial)
        .map(({ promptId }) => promptId),
    );
    const pendingPromptIds = [...currentPromptIds].filter((id) => !renderedPromptIds.has(id));
    const hasUnrenderedPrompts = pendingPromptIds.length > 0;
    const differenceSignature = (selectedIds?: ReadonlySet<string>) => workflowStateHash({
      references: sourcePackage?.files.map(({ fileObject, sortOrder }) => ({
        id: fileObject.id, hash: fileObject.sha256, status: fileObject.status, sortOrder,
      })),
      ...(!selectedIds && pendingPromptIds.length ? { additionsSettings: settingsNode
        ? this.settingsFromState(settingsNode.state) : this.legacySettings(prompt?.payload) } : {}),
      changes: record.tasks.filter((task) => updateKinds.get(task.id) &&
        (!selectedIds || selectedIds.has(task.id))).map((task) => ({
        promptId: task.promptId, kind: updateKinds.get(task.id),
        latest: latestPromptBatch ? confirmedPromptBaseline(latestPromptBatch, task.promptId) : null,
        renderSettingsHash: requestSnapshot(task.requestSnapshot).renderSettingsHash,
      })).sort((a, b) => a.promptId.localeCompare(b.promptId)),
      additions: selectedIds ? [] : pendingPromptIds.sort().map((id) => ({
        promptId: id, latest: latestPromptBatch ? confirmedPromptBaseline(latestPromptBatch, id) : null,
      })),
    });
    const artifact = await this.repository.renderArtifact(
      record.projectId,
      record.workflowRunId,
      record.productId,
    );
    const artifacts = this.artifactInputs(record, artifact ? [artifact] : []);
    const batchInput = artifacts.find(
      ({ artifactKey }) => artifactKey === 'render-batch:' + record.productId,
    )?.input;
    // "Stale" means the batch no longer renders the current Prompt — that is the only thing a rerender
    // can fix, and the only thing the rerender entry points are offered for. The artifact's own
    // freshness must stay out of it: the committed working copies are marked STALE *by* an upstream
    // change and are made CURRENT *by* a validation commit, so folding that flag in would make every
    // rerendered batch read as stale forever — validation is gated on `!stale`, so the commit that
    // would clear it could never run. `commitStatus` already reports the uncommitted working copies.
    const stale = Boolean(upstreamStale || taskIdsNeedingUpdate.size > 0 || hasUnrenderedPrompts);
    const refreshScope = !stale
      ? 'NONE'
      : upstreamStale
        ? 'FULL'
        : 'SELECTIVE';
    const commitStatus = !artifact
      ? 'UNVALIDATED'
      : stale || artifact.availability !== 'AVAILABLE'
        ? 'STALE'
        : batchInput && artifact.contentHash === workingArtifactContentHash(batchInput)
          ? 'COMMITTED'
          : 'DRAFT_CHANGED';
    return {
      id: record.id,
      projectId: record.projectId,
      workflowRunId: record.workflowRunId,
      productId: record.productId,
      productName,
      sourcePrompt: {
        artifactId: record.sourcePromptArtifactId,
        revision: record.sourcePromptRevision,
        contentHash: record.sourcePromptHash,
      },
      status: record.status,
      stale,
      refreshScope,
      pendingPromptIds,
      pendingRemovedTaskIds,
      refreshSignature: differenceSignature(),
      canSaveFrozenResults: record.tasks.some((task) => requestSnapshot(task.requestSnapshot).refreshContext?.schemaVersion === 1),
      latestPromptRevision: prompt?.revision ?? null,
      latestPromptCount: latestPromptBatch?.items.length ?? 0,
      revision: record.revision,
      commitStatus,
      workingArtifactRevision: artifact?.revision ?? null,
      summary: summary(record),
      tasks: record.tasks.filter((task) => task.errorCode !== 'MATERIAL_DELETED' || updateKinds.has(task.id)).map((task) => {
        const view = presentTask(task, productName, taskIdsNeedingUpdate.has(task.id), updateKinds.get(task.id));
        view.refreshSignature = differenceSignature(new Set([task.id]));
        const consumed = consumedPromptItems.get(task.promptId);
        return consumed && view.creativeCore === undefined
          ? { ...view, creativeCore: consumed.creativeCore, dimensions: { ...consumed.dimensions } }
          : view;
      }),
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
      this.repository.workspaceBatch(projectId, workflowRunId, productId),
      this.workingRepository.findNodeState(
        projectId,
        workflowRunId,
        effectSegmentRenderSettingsNodeId(productId),
      ),
    ]);
    const promptBatch = prompt?.payload ? parseEffectPromptBatchResult(prompt.payload) : null;
    const promptReady = Boolean(
      promptBatch && prompt?.freshness === 'CURRENT' && prompt.availability === 'AVAILABLE',
    );
    if (batch) await this.resumeCommittedBatchPublication(projectId, batch);
    return {
      projectId,
      workflowRunId,
      productId,
      promptReady,
      promptCount: promptReady ? (promptBatch?.items.length ?? 0) : 0,
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
    await this.resumeCommittedBatchPublication(projectId, record);
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
    // Batch generation is an explicit paid action. Before it can mutate a
    // published render result, route it to an unpublished child work context.
    const edit = await this.workflowWorkingService.beginEffectNodeEdit(
      projectId,
      input.workflowRunId,
      'SEGMENT_RENDER',
      'BATCH',
    );
    const workflowRunId = edit.run.id;
    productId = edit.productIdMap[productId] ?? productId;
    const [workflow, product, promptArtifact, sourcePackage, settingsNode] = await Promise.all([
      this.repository.workflowRun(projectId, workflowRunId),
      this.repository.product(projectId, workflowRunId, productId),
      this.repository.promptArtifact(projectId, workflowRunId, productId),
      this.repository.sourcePackageArtifact(projectId, workflowRunId, productId),
      this.workingRepository.findNodeState(
        projectId,
        workflowRunId,
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
    if ((settingsNode?.revision ?? 0) !== input.expectedSettingsRevision)
      throw conflict('视频渲染设置已更新，请刷新后重试');
    const renderSettings = settingsNode
      ? this.settingsFromState(settingsNode.state)
      : this.legacySettings(promptArtifact.payload);
    if (!renderSettings) throw conflict('视频渲染设置无效，请重新保存');
    const model = this.modelFor(renderSettings.capabilityKey);
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
    const snapshots = promptBatch.items.map((item) => {
      const taskSettings = item.origin === 'MANUAL' && item.targetDurationSeconds > 15
        ? resolveEffectImportedRenderSettings(renderSettings, { durationSeconds: item.targetDurationSeconds })
        : renderSettings;
      const compiled = this.compileSeedanceRequest(() =>
        compileEffectSeedanceRequest(promptBatch, item.id,
          this.modelFor(taskSettings.capabilityKey), taskSettings),
      );
      return {
        ...compiled,
        promptCode: item.code,
        promptText: item.content,
        renderSettings: taskSettings,
        sourcePrompt: {
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
      } satisfies EffectSegmentRenderRequestSnapshot;
    });
    const requestHash = workflowStateHash({
      projectId,
      workflowRunId,
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
    const result = await this.repository.createBatch(projectId, workflowRunId, productId, {
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

  private assertRenderablePromptBatch(batch: EffectPromptBatchResult, allowEmpty = false): void {
    if (
      (!allowEmpty && batch.items.length < 1) ||
      batch.items.length > EFFECT_SEGMENT_RENDER_LIMITS.maxTasksPerBatch
    )
      throw badRequest('Prompt 数量不符合视频渲染批次限制');
    if (batch.items.some(({ classificationStatus }) => classificationStatus !== 'VERIFIED'))
      throw conflict('仍有 Prompt 尚未完成用途评估');
    if (new Set(batch.items.map(({ id }) => id)).size !== batch.items.length)
      throw conflict('Prompt 批次包含重复的稳定 ID');
  }

  private async assertEditableBatch(
    projectId: string,
    record: EffectSegmentRenderBatchRecord,
  ): Promise<void> {
    await this.workflowWorkingService.assertEffectNodeWritable(
      projectId,
      record.workflowRunId,
      'SEGMENT_RENDER',
    );
  }

  async importContext(projectId: string, batchId: string) {
    const project = await this.projects.get(projectId);
    const batch = await this.repository.batch(projectId, batchId);
    if (!batch) throw notFound('视频渲染批次不存在');
    await this.assertEditableBatch(projectId, batch);
    if (['QUEUED', 'RUNNING'].includes(batch.status)) throw conflict('批次渲染中，暂不能导入素材');
    return { project, batch };
  }

  async refresh(
    projectId: string,
    batchId: string,
    input: {
      expectedBatchRevision: number;
      expectedPromptArtifactRevision: number;
      idempotencyKey: string;
      taskIds?: string[];
      expectedDifferenceSignature?: string;
    },
  ): Promise<StartEffectSegmentRenderBatchData> {
    await this.projects.get(projectId);
    const idempotencyKey = input.idempotencyKey.trim();
    if (!idempotencyKey) throw badRequest('幂等键不能为空');
    const refreshRequestHash = workflowStateHash({
      operation: 'PROMPT_REFRESH',
      projectId,
      batchId,
      expectedBatchRevision: input.expectedBatchRevision,
      expectedPromptArtifactRevision: input.expectedPromptArtifactRevision,
      ...(input.expectedDifferenceSignature ? { expectedDifferenceSignature: input.expectedDifferenceSignature } : {}),
      ...(input.taskIds ? { taskIds: [...new Set(input.taskIds)].sort() } : {}),
    });
    const receipt = await this.repository.operationReceipt(projectId, idempotencyKey);
    if (receipt) {
      if (receipt.requestHash !== refreshRequestHash)
        throw conflict('幂等键已用于其他素材更新请求');
      const replay =
        (await this.repository.batch(projectId, receipt.batchId)) ??
        (await this.repository.batch(projectId, batchId));
      if (!replay) throw notFound('视频渲染批次不存在');
      return { batch: await this.present(replay), replayed: true };
    }
    const original = await this.repository.batch(projectId, batchId);
    if (!original) throw notFound('视频渲染批次不存在');
    if (original.revision !== input.expectedBatchRevision)
      throw conflict('素材已更新，请刷新后重试');
    const prompt = await this.repository.promptArtifact(
      projectId,
      original.workflowRunId,
      original.productId,
    );
    const view = await this.present(original);
    // A reverted edit is a read-only no-op: no edit Run, receipt, Outbox or paid task.
    const selectedViews = input.taskIds ? view.tasks.filter((task) => input.taskIds!.includes(task.id)) : view.tasks;
    if (view.refreshScope === 'NONE' || (input.taskIds && selectedViews.length === input.taskIds.length &&
      selectedViews.every((task) => !task.needsUpdate)))
      return { batch: view, replayed: false, noChanges: true };
    const signature = input.taskIds?.length === 1 ? selectedViews[0]?.refreshSignature : view.refreshSignature;
    if (input.expectedDifferenceSignature ? input.expectedDifferenceSignature !== signature :
        prompt?.revision !== input.expectedPromptArtifactRevision)
      throw conflict('待更新内容或费用范围已变化，请重新确认');
    if (input.taskIds && input.taskIds.length !== 1 && input.expectedDifferenceSignature)
      throw badRequest('签名单卡更新只能选择一个素材');
    if (view.refreshScope !== 'SELECTIVE')
      throw conflict('当前没有可局部更新的 Prompt，或来源需要重新确认');
    if (input.taskIds && (!input.taskIds.length || input.taskIds.length > EFFECT_SEGMENT_RENDER_LIMITS.maxTaskIdsPerOperation ||
      input.taskIds.some((id) => !view.tasks.some((task) => task.id === id && task.needsUpdate && task.updateKind !== 'REMOVE'))))
      throw badRequest('单条更新只能选择当前待更新且未被删除的素材');
    if (original.tasks.some(({ status }) => status === 'QUEUED' || status === 'RUNNING'))
      throw conflict('当前素材仍在渲染中');
    // MANUAL uses the existing isolated edit workspace; its successful publication merges into
    // the original branch rather than creating a new published version like BATCH does.
    const edit = await this.workflowWorkingService.beginEffectNodeEdit(
      projectId,
      original.workflowRunId,
      'SEGMENT_RENDER',
      'MANUAL',
    );
    const productId = edit.productIdMap[original.productId] ?? original.productId;
    const target =
      edit.run.id === original.workflowRunId
        ? original
        : await this.repository.latestBatch(projectId, edit.run.id, productId);
    if (!target) throw notFound('编辑素材批次不存在');
    const current = await this.present(target);
    if (current.refreshScope !== 'SELECTIVE') throw conflict('Prompt 或素材在更新准备期间已变化');
    const selectedIds = input.taskIds ? new Set(input.taskIds.map((id) => edit.taskIdMap?.[id] ?? id)) : null;
    if (input.expectedDifferenceSignature && input.expectedDifferenceSignature !== (selectedIds
      ? current.tasks.find((task) => selectedIds.has(task.id))?.refreshSignature : current.refreshSignature))
      throw conflict('待更新内容或费用范围在准备期间已变化，请重新确认');
    const selected = current.tasks.filter((task) => task.needsUpdate && (!selectedIds || selectedIds.has(task.id)));
    if (selectedIds && selected.length !== selectedIds.size)
      throw conflict('所选素材在更新准备期间已变化');
    return this.regenerate(
      projectId,
      target.id,
      selected.filter((task) => task.updateKind === 'RENDER').map(({ id }) => id),
      target.revision,
      idempotencyKey,
      {
        addedPromptIds: selectedIds ? [] : current.pendingPromptIds ?? [],
        metadataTaskIds: selected.filter((task) => task.updateKind === 'METADATA').map(({ id }) => id),
        removedTaskIds: selectedIds ? [] : current.pendingRemovedTaskIds ?? [],
        expectedPromptArtifactRevision: prompt!.revision,
        refreshRequestHash,
        ...(input.expectedDifferenceSignature ? { confirmationSignature: input.expectedDifferenceSignature } : {}),
      },
    );
  }

  async regenerate(
    projectId: string,
    batchId: string,
    taskIds: string[],
    expectedBatchRevision: number,
    idempotencyKeyValue: string,
    incremental?: {
      addedPromptIds: string[];
      metadataTaskIds?: string[];
      removedTaskIds?: string[];
      expectedPromptArtifactRevision: number;
      refreshRequestHash: string;
      confirmationSignature?: string;
    },
  ): Promise<{ batch: EffectSegmentRenderBatch; replayed: boolean }> {
    await this.projects.get(projectId);
    const taskIdsNormalized = [...new Set(taskIds)];
    if (
      taskIdsNormalized.length + (incremental?.addedPromptIds.length ?? 0) +
        (incremental?.metadataTaskIds?.length ?? 0) + (incremental?.removedTaskIds?.length ?? 0) < 1 ||
      taskIdsNormalized.length > EFFECT_SEGMENT_RENDER_LIMITS.maxTaskIdsPerOperation
    )
      throw badRequest('请选择需要重新生成的视频任务');
    const idempotencyKey = idempotencyKeyValue.trim();
    if (!idempotencyKey) throw badRequest('幂等键不能为空');
    const record = await this.repository.batch(projectId, batchId);
    if (!record) throw notFound('视频渲染批次不存在');
    await this.assertEditableBatch(projectId, record);
    const [promptArtifact, sourcePackage, settingsNode] = await Promise.all([
      this.repository.promptArtifact(projectId, record.workflowRunId, record.productId),
      this.repository.sourcePackageArtifact(projectId, record.workflowRunId, record.productId),
      this.workingRepository.findNodeState(
        projectId,
        record.workflowRunId,
        effectSegmentRenderSettingsNodeId(record.productId),
      ),
    ]);
    if (
      !promptArtifact?.payload ||
      promptArtifact.freshness !== 'CURRENT' ||
      promptArtifact.availability !== 'AVAILABLE'
    )
      throw conflict('当前 Prompt 尚未完成校验');
    const promptBatch = parseEffectPromptBatchResult(promptArtifact.payload);
    if (!promptBatch) throw conflict('Prompt 批次结构无效，请重新生成并校验');
    if (incremental && promptArtifact.revision !== incremental.expectedPromptArtifactRevision)
      throw conflict('Prompt 在更新准备期间已变化，请刷新后重试');
    this.assertRenderablePromptBatch(promptBatch, Boolean(incremental));
    if (
      !sourcePackage ||
      sourcePackage.freshness !== 'CURRENT' ||
      sourcePackage.availability !== 'AVAILABLE'
    )
      throw conflict('产品资料包已更新，请重新创建渲染批次');
    const currentImages = sourcePackage.files
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
    if ((taskIdsNormalized.length || incremental?.addedPromptIds.length) && !currentImages.length)
      throw conflict('产品资料包至少需要一张可用商品图片');
    const compileSnapshot = (
      promptId: string,
      previous?: EffectSegmentRenderRequestSnapshot,
    ): EffectSegmentRenderRequestSnapshot => {
      const item = promptBatch.items.find(({ id }) => id === promptId);
      if (!item) throw conflict('该 Prompt 已从当前批次移除，请创建新渲染批次');
      const configured =
        previous?.renderSettings ??
        (settingsNode
          ? this.settingsFromState(settingsNode.state)
          : this.legacySettings(promptArtifact.payload));
      if (!configured) throw conflict('视频渲染设置无效，请重新保存');
      const renderSettings = item.origin === 'MANUAL' && item.targetDurationSeconds > 15
        ? resolveEffectImportedRenderSettings(configured, { durationSeconds: item.targetDurationSeconds })
        : configured;
      const compiled = this.compileSeedanceRequest(() =>
        compileEffectSeedanceRequest(
          promptBatch,
          item.id,
          this.modelFor(renderSettings.capabilityKey),
          renderSettings,
        ),
      );
      return {
        ...compiled,
        ...(incremental?.confirmationSignature ? { refreshContext: {
          schemaVersion: 1 as const, confirmationSignature: incremental.confirmationSignature,
          sourcePrompt: { artifactId: promptArtifact.id, revision: promptArtifact.revision, contentHash: promptArtifact.contentHash },
        } } : {}),
        promptCode: item.code,
        promptText: item.content,
        renderSettings,
        sourcePrompt: {
          artifactId: promptArtifact.id,
          revision: promptArtifact.revision,
          contentHash: promptArtifact.contentHash,
        },
        sourcePackage: {
          artifactId: sourcePackage.id,
          revision: sourcePackage.revision,
          contentHash: sourcePackage.contentHash,
        },
        inputImages: currentImages,
      };
    };
    const taskSnapshots = Object.fromEntries(
      taskIdsNormalized.map((taskId) => {
        const task = record.tasks.find(({ id }) => id === taskId);
        if (!task) throw notFound('所选视频任务不存在');
        const previous = requestSnapshot(task.generationRequestSnapshot ?? task.requestSnapshot);
        if (previous.importedMaterial) {
          const configured = settingsNode
            ? this.settingsFromState(settingsNode.state)
            : (previous.renderSettings ?? this.legacySettings(promptArtifact.payload));
          if (!configured) throw conflict('视频渲染设置无效，请重新保存');
          const renderSettings = resolveEffectImportedRenderSettings(configured, {
            durationSeconds: previous.outputDurationSeconds ?? previous.request.duration,
            shortSidePixels: activeMediaShortSide(task, previous),
          });
          const compiled = this.compileSeedanceRequest(() =>
            compileEffectImportedSeedanceRequest(
              previous,
              this.modelFor(renderSettings.capabilityKey),
              renderSettings,
              promptBatch,
            ),
          );
          return [
            taskId,
            {
              ...compiled,
              sourcePackage: {
                artifactId: sourcePackage.id,
                revision: sourcePackage.revision,
                contentHash: sourcePackage.contentHash,
              },
              inputImages: currentImages,
            },
          ];
        }
        return [taskId, compileSnapshot(task.promptId, requestSnapshot(task.requestSnapshot))];
      }),
    );
    const lastCode = Math.max(
      0,
      ...record.tasks.map(({ renderCode }) => Number(/^R-(\d+)$/.exec(renderCode)?.[1] ?? 0)),
    );
    const addedTasks = (incremental?.addedPromptIds ?? []).map((promptId, index) => {
      if (record.tasks.some((task) => task.promptId === promptId))
        throw conflict('新增 Prompt 已有渲染任务');
      const snapshot = compileSnapshot(promptId);
      return {
        id: randomUUID(),
        promptId,
        promptCode: snapshot.promptCode,
        renderCode: 'R-' + String(lastCode + index + 1).padStart(3, '0'),
        sourceFingerprint: workflowStateHash(snapshot),
        requestSnapshot: snapshot,
      };
    });
    const result = await this.repository.regenerateTasks(
      projectId,
      batchId,
      taskIdsNormalized,
      expectedBatchRevision,
      idempotencyKey,
      {
        sourcePrompt: {
          artifactId: promptArtifact.id,
          revision: promptArtifact.revision,
          contentHash: promptArtifact.contentHash,
        },
        taskSnapshots,
        ...(incremental ? {
          addedTasks,
          removedTaskIds: incremental.removedTaskIds ?? [],
          metadataSnapshots: Object.fromEntries((incremental.metadataTaskIds ?? []).map((id) => {
            const task = record.tasks.find((task) => task.id === id);
            if (!task) throw notFound('所选视频任务不存在');
            const previous = requestSnapshot(task.generationRequestSnapshot ?? task.requestSnapshot);
            const item = promptBatch.items.find((item) => item.id === task.promptId);
            if (!item || renderPromptUpdateKind(previous, promptBatch) !== 'METADATA')
              throw conflict('素材信息在更新准备期间已变化');
            const snapshot: EffectSegmentRenderRequestSnapshot = {
              ...previous, promptCode: item.code, promptText: item.content,
              primaryPurpose: item.primaryPurpose, compatiblePurposes: [...item.compatiblePurposes],
              creativeCore: item.creativeCore, dimensions: { ...item.dimensions },
              sourcePrompt: { artifactId: promptArtifact.id, revision: promptArtifact.revision, contentHash: promptArtifact.contentHash },
            };
            snapshot.adoptedPrompt = renderPromptBaseline(snapshot);
            if (incremental.confirmationSignature) snapshot.refreshContext = {
              schemaVersion: 1, confirmationSignature: incremental.confirmationSignature,
              sourcePrompt: snapshot.sourcePrompt!,
            };
            return [id, snapshot];
          })),
          sourcePackage: { artifactId: sourcePackage.id, revision: sourcePackage.revision, contentHash: sourcePackage.contentHash },
          refreshRequestHash: incremental.refreshRequestHash,
          ...(incremental.confirmationSignature ? { refreshContext: {
            schemaVersion: 1 as const, confirmationSignature: incremental.confirmationSignature,
            sourcePrompt: { artifactId: promptArtifact.id, revision: promptArtifact.revision, contentHash: promptArtifact.contentHash },
          } } : {}),
        } : {}),
      },
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
    const updatedRecord = await this.repository.batch(projectId, batchId);
    if (!updatedRecord) throw notFound('视频渲染批次不存在');
    return { batch: await this.present(updatedRecord), replayed: result.kind === 'REPLAYED' };
  }

  async importMaterials(
    projectId: string,
    batchId: string,
    input: { expectedBatchRevision: number; idempotencyKey: string; mappings: string },
    files: UploadedSegmentRenderFile[] | undefined,
  ): Promise<{ batch: EffectSegmentRenderBatch; importedCount: number; replayed: boolean }> {
    const project = await this.projects.get(projectId);
    const idempotencyKey = input.idempotencyKey.trim();
    if (!idempotencyKey) throw badRequest('幂等键不能为空');
    const uploads = files ?? [];
    if (!uploads.length || uploads.length > EFFECT_SEGMENT_RENDER_LIMITS.maxImportFilesPerOperation)
      throw badRequest('请选择需要导入的视频素材');
    let mappings: EffectSegmentRenderImportMapping[];
    try {
      const value = JSON.parse(input.mappings) as unknown;
      if (!Array.isArray(value)) throw new Error('INVALID_MAPPINGS');
      mappings = value as EffectSegmentRenderImportMapping[];
    } catch {
      throw badRequest('素材与 Prompt 槽位的匹配关系无效');
    }
    if (
      mappings.length !== uploads.length ||
      mappings.length > EFFECT_SEGMENT_RENDER_LIMITS.maxImportFilesPerOperation ||
      mappings.some(
        ({ fileIndex, taskId }) =>
          !Number.isSafeInteger(fileIndex) ||
          fileIndex < 0 ||
          fileIndex >= uploads.length ||
          typeof taskId !== 'string' ||
          !UUID_V4_PATTERN.test(taskId),
      ) ||
      new Set(mappings.map(({ fileIndex }) => fileIndex)).size !== mappings.length ||
      new Set(mappings.map(({ taskId }) => taskId)).size !== mappings.length
    )
      throw badRequest('每个视频必须唯一匹配一个 Prompt 槽位');
    const batch = await this.repository.batch(projectId, batchId);
    if (!batch) throw notFound('视频渲染批次不存在');
    await this.assertEditableBatch(projectId, batch);
    const productName = batch.product.name.trim() || '未命名产品';
    const storedImports: Array<{
      taskId: string;
      file: {
        id: string;
        originalFileName: string;
        mimeType: string;
        sizeBytes: number;
        storageKey: string;
        sha256: string;
      };
    }> = [];
    try {
      for (const mapping of mappings) {
        const upload = uploads[mapping.fileIndex]!;
        const displayName = safeFileName(upload.originalname || 'imported-video.mp4');
        const reportedMimeType = upload.mimetype.trim().toLocaleLowerCase('en-US');
        const inferredMimeType = /\.mov$/iu.test(displayName)
          ? 'video/quicktime'
          : /\.webm$/iu.test(displayName)
            ? 'video/webm'
            : /\.mp4$/iu.test(displayName)
              ? 'video/mp4'
              : reportedMimeType;
        const mimeType =
          reportedMimeType && reportedMimeType !== 'application/octet-stream'
            ? reportedMimeType
            : inferredMimeType;
        if (!['video/mp4', 'video/quicktime', 'video/webm'].includes(mimeType))
          throw badRequest(`文件 ${displayName} 不是支持的视频格式`);
        if (upload.size < 1 || upload.size > EFFECT_SEGMENT_RENDER_LIMITS.maxUploadBytes)
          throw badRequest(`文件 ${displayName} 的大小不符合限制`);
        // Historical clients can still replace a Prompt task. They must not bypass actual
        // format/duration validation or insert a clip shorter than that frozen task.
        let metadata;
        try {
          metadata = await inspectImportVideo(upload.path, displayName);
        } catch (error) {
          throw badRequest(error instanceof Error ? error.message : '视频校验失败');
        }
        const target = batch.tasks.find((task) => task.id === mapping.taskId);
        if (!target) throw notFound('匹配的 Prompt 槽位不存在');
        const targetSnapshot = (target.generationRequestSnapshot ??
          target.requestSnapshot) as unknown as EffectSegmentRenderRequestSnapshot;
        if (metadata.durationSeconds + 0.001 < targetSnapshot.request.duration)
          throw badRequest('导入视频短于目标素材时长，请使用独立素材导入');
        const sha256 = await fileSha256(upload.path);
        const stored = await this.storage.put({
          projectId,
          stream: createReadStream(upload.path),
          sizeBytes: upload.size,
          contentType: metadata.mimeType,
          keyContext: {
            projectName: project.name,
            workflow: 'EFFECT',
            lifecycle: 'staging',
            productId: batch.productId,
            productName,
            category: '外部视频素材',
            originalFileName: displayName,
          },
        });
        storedImports.push({
          taskId: mapping.taskId,
          file: {
            id: randomUUID(),
            originalFileName: displayName,
            mimeType: metadata.mimeType,
            sizeBytes: stored.sizeBytes,
            storageKey: stored.key,
            sha256,
          },
        });
      }
      const result = await this.repository.importMaterials(
        projectId,
        batchId,
        storedImports,
        input.expectedBatchRevision,
        idempotencyKey,
      );
      if (result.kind === 'NOT_FOUND') throw notFound('视频渲染批次不存在');
      if (result.kind === 'REVISION_CONFLICT') throw conflict('视频渲染批次已更新，请刷新后重试');
      if (result.kind === 'BATCH_ACTIVE') throw conflict('批次渲染中，暂不能导入素材');
      if (result.kind === 'NOT_LATEST') throw conflict('只能向当前最新批次导入素材');
      if (result.kind === 'PROMPT_CONFLICT')
        throw conflict('Prompt 批次已更新，请重新创建渲染批次');
      if (result.kind === 'SOURCE_CONFLICT') throw conflict('产品资料包已更新，请重新创建渲染批次');
      if (result.kind === 'TASK_NOT_FOUND') throw notFound('匹配的 Prompt 槽位不存在');
      if (result.kind === 'TASK_CONFLICT') throw conflict('同一 Prompt 槽位不能重复匹配');
      if (result.kind === 'TASK_REPAIR_PENDING')
        throw conflict('目标素材存在待处理返修，请先采用或放弃返修结果');
      if (result.kind === 'KEY_CONFLICT') throw conflict('幂等键已用于其他素材导入请求');
      if (result.kind === 'REPLAYED') {
        await Promise.all(
          storedImports.map(({ file }) =>
            this.storage.delete(file.storageKey).catch(() => undefined),
          ),
        );
        storedImports.length = 0;
      } else {
        storedImports.length = 0;
      }
      const updated = await this.repository.batch(projectId, batchId);
      if (!updated) throw notFound('视频渲染批次不存在');
      return {
        batch: await this.present(updated),
        importedCount: mappings.length,
        replayed: result.kind === 'REPLAYED',
      };
    } finally {
      if (storedImports.length)
        await Promise.all(
          storedImports.map(({ file }) =>
            this.storage.delete(file.storageKey).catch(() => undefined),
          ),
        );
    }
  }

  async deleteMaterials(
    projectId: string,
    batchId: string,
    taskIds: string[],
    expectedBatchRevision: number,
    idempotencyKeyValue: string,
  ): Promise<{ batch: EffectSegmentRenderBatch; replayed: boolean }> {
    await this.projects.get(projectId);
    const idempotencyKey = idempotencyKeyValue.trim();
    if (!idempotencyKey) throw badRequest('幂等键不能为空');
    const uniqueTaskIds = [...new Set(taskIds)];
    if (
      !uniqueTaskIds.length ||
      uniqueTaskIds.length > EFFECT_SEGMENT_RENDER_LIMITS.maxTaskIdsPerOperation
    )
      throw badRequest('请选择需要删除的视频素材');
    const batch = await this.repository.batch(projectId, batchId);
    if (!batch) throw notFound('视频渲染批次不存在');
    await this.assertEditableBatch(projectId, batch);
    const result = await this.repository.deleteMaterials(
      projectId,
      batchId,
      uniqueTaskIds,
      expectedBatchRevision,
      idempotencyKey,
    );
    if (result.kind === 'NOT_FOUND') throw notFound('视频渲染批次不存在');
    if (result.kind === 'REVISION_CONFLICT') throw conflict('视频渲染批次已更新，请刷新后重试');
    if (result.kind === 'BATCH_ACTIVE') throw conflict('批次渲染中，暂不能删除素材');
    if (result.kind === 'NOT_LATEST') throw conflict('只能删除当前最新批次的素材');
    if (result.kind === 'PROMPT_CONFLICT') throw conflict('Prompt 批次已更新，请重新创建渲染批次');
    if (result.kind === 'SOURCE_CONFLICT') throw conflict('产品资料包已更新，请重新创建渲染批次');
    if (result.kind === 'TASK_NOT_FOUND') throw notFound('所选视频素材不存在');
    if (result.kind === 'TASK_CONFLICT') throw conflict('只能删除已完成的视频素材');
    if (result.kind === 'TASK_REPAIR_PENDING')
      throw conflict('所选素材存在待处理返修，请先采用或放弃返修结果');
    if (result.kind === 'KEY_CONFLICT') throw conflict('幂等键已用于其他素材删除请求');
    const updated = await this.repository.batch(projectId, batchId);
    if (!updated) throw notFound('视频渲染批次不存在');
    return { batch: await this.present(updated), replayed: result.kind === 'REPLAYED' };
  }

  async exportMaterials(
    projectId: string,
    batchId: string,
    taskIds: string[],
    formats: EffectSegmentRenderExportFormat[],
    expectedBatchRevision: number,
  ) {
    await this.projects.get(projectId);
    const record = await this.repository.batch(projectId, batchId);
    if (!record) throw notFound('视频渲染批次不存在');
    if (record.revision !== expectedBatchRevision)
      throw conflict('视频渲染批次已更新，请刷新后重试');
    const uniqueTaskIds = [...new Set(taskIds)];
    const selected = record.tasks.filter(({ id }) => uniqueTaskIds.includes(id));
    if (!uniqueTaskIds.length || selected.length !== uniqueTaskIds.length)
      throw notFound('导出范围内的视频任务不存在');
    const requestedFormats = new Set(formats);
    if (!requestedFormats.size) throw badRequest('请选择至少一种导出内容');
    const presented = selected.map((task) => presentTask(task, record.product.name));
    const archive = new ZipArchive({ zlib: { level: 6 } });
    let entryCount = 0;
    if (requestedFormats.has('VIDEO_PACKAGE')) {
      for (const task of selected) {
        if (
          task.status !== 'COMPLETED' ||
          !task.outputFileObjectId ||
          !task.outputStorageKey ||
          !task.outputFileName
        )
          continue;
        const fileObject = await this.repository.fileObject(
          projectId,
          record.workflowRunId,
          task.outputFileObjectId,
        );
        if (!fileObject || fileObject.storageKey !== task.outputStorageKey) continue;
        const stored = await this.storage.open(fileObject.storageKey);
        archive.append(stored.stream, {
          name: `videos/${task.renderCode}-${safeFileName(task.outputFileName)}`,
        });
        entryCount += 1;
      }
    }
    if (requestedFormats.has('MANIFEST_JSON')) {
      archive.append(
        Buffer.from(
          JSON.stringify(
            {
              schemaVersion: 1,
              batchId: record.id,
              productId: record.productId,
              sourcePrompt: {
                artifactId: record.sourcePromptArtifactId,
                revision: record.sourcePromptRevision,
                contentHash: record.sourcePromptHash,
              },
              exportedAt: new Date().toISOString(),
              tasks: presented,
            },
            null,
            2,
          ),
          'utf8',
        ),
        { name: 'manifest.json' },
      );
      entryCount += 1;
    }
    if (requestedFormats.has('FAILURE_CSV')) {
      const csvCell = (value: unknown): string => `"${String(value ?? '').replace(/"/gu, '""')}"`;
      const rows = [
        ['renderCode', 'promptCode', 'errorCode', 'errorMessage'],
        ...presented
          .filter(({ status }) => status === 'FAILED')
          .map((task) => [task.renderCode, task.promptCode, task.errorCode, task.errorMessage]),
      ];
      archive.append(
        Buffer.from('\ufeff' + rows.map((row) => row.map(csvCell).join(',')).join('\r\n')),
        { name: 'failures.csv' },
      );
      entryCount += 1;
    }
    if (!entryCount) throw badRequest('当前范围没有可导出的已完成视频素材');
    void archive.finalize().catch((error: unknown) => archive.destroy(error as Error));
    return {
      stream: archive,
      fileName: `${safeFileName(record.product.name || '未命名产品')}-视频素材-${Date.now()}.zip`,
    };
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
    const record = await this.repository.batch(projectId, batchId);
    if (!record) throw notFound('视频渲染批次不存在');
    await this.assertEditableBatch(projectId, record);
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
    const sourceProviderTaskId = task.providerTaskId?.trim() || null;
    if (
      !sourceProviderTaskId &&
      this.config.get<string>('STORAGE_DRIVER')?.trim().toLowerCase() !== 'tos'
    ) {
      const publicBaseUrl = this.config.get<string>('SEEDANCE_REFERENCE_PUBLIC_BASE_URL')?.trim();
      const signingSecret = this.config.get<string>('SEEDANCE_REFERENCE_SIGNING_SECRET')?.trim();
      if (!publicBaseUrl || !signingSecret)
        throw conflict('当前视频无法从 Ark 复用，请先配置 Seedance 参考视频公网访问地址');
      try {
        const parsed = new URL(publicBaseUrl);
        if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('invalid protocol');
      } catch {
        throw conflict('Seedance 参考视频访问地址配置无效');
      }
    }
    const originalSnapshot = requestSnapshot(task.generationRequestSnapshot);
    const duration = originalSnapshot.outputDurationSeconds ?? originalSnapshot.request.duration;
    const settingsNode = originalSnapshot.importedMaterial
      ? await this.workingRepository.findNodeState(
          projectId,
          record.workflowRunId,
          effectSegmentRenderSettingsNodeId(record.productId),
        )
      : null;
    const configured = settingsNode
      ? this.settingsFromState(settingsNode.state)
      : originalSnapshot.renderSettings;
    if (settingsNode && !configured) throw conflict('视频渲染设置无效，请重新保存');
    const repairSettings = originalSnapshot.importedMaterial
      ? resolveEffectImportedRenderSettings(configured ?? DEFAULT_EFFECT_SEGMENT_RENDER_SETTINGS, {
          durationSeconds: duration,
          shortSidePixels: activeMediaShortSide(task, originalSnapshot),
        })
      : {
          ...(configured ?? DEFAULT_EFFECT_SEGMENT_RENDER_SETTINGS),
          capabilityKey: 'SEEDANCE_1_5_PRO' as const,
          resolution:
            originalSnapshot.request.resolution === '4k'
              ? ('1080p' as const)
              : originalSnapshot.request.resolution,
        };
    const repairCapabilityKey = repairSettings.capabilityKey;
    const generationSnapshot = {
      ...originalSnapshot,
      renderSettings: repairSettings,
      renderSettingsHash: workflowStateHash(repairSettings),
      request: {
        ...originalSnapshot.request,
        duration,
        resolution: repairSettings.resolution,
        ratio: repairSettings.ratio,
      },
    };
    const durationMs = generationSnapshot.request.duration * 1000;
    if (
      !Number.isFinite(duration) ||
      duration < EFFECT_SEGMENT_RENDER_LIMITS.minReferenceVideoSeconds ||
      duration > EFFECT_SEGMENT_RENDER_LIMITS.maxReferenceVideoSeconds
    )
      throw badRequest('画面返修支持 4～30 秒的视频');
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
      providerMode:
        repairCapabilityKey === 'SEEDANCE_1_5_PRO'
          ? ('VIDEO_EDIT' as const)
          : ('VIDEO_REFERENCE' as const),
      sourceVersion: task.activeOutputVersion,
      startMs: input.startMs,
      endMs: input.endMs,
      instruction,
      region: normalizedRegion,
    };
    const snapshot = this.compileSeedanceRequest(() =>
      compileEffectSeedanceRepairRequest(
        generationSnapshot,
        {
          fileObjectId: task.outputFileObjectId!,
          providerTaskId: sourceProviderTaskId,
          originalFileName: task.outputFileName!,
          mimeType,
          sizeBytes: task.outputSizeBytes!,
          contentHash: task.outputContentHash!,
          durationSeconds: generationSnapshot.request.duration,
          ratio:
            originalSnapshot.outputRatio ??
            (!sourceProviderTaskId && originalSnapshot.importedMaterial
              ? `${originalSnapshot.importedMaterial.width}:${originalSnapshot.importedMaterial.height}`
              : originalSnapshot.request.ratio),
        },
        repairInput,
        this.modelFor(repairCapabilityKey),
      ),
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
    const batch = await this.repository.batch(projectId, batchId);
    if (!batch) throw notFound('视频渲染批次不存在');
    await this.assertEditableBatch(projectId, batch);
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
    if (this.config.get<string>('STORAGE_DRIVER') === 'tos') {
      const fileObject = await this.repository.fileObject(
        task.projectId,
        task.workflowRunId,
        video.fileObjectId,
      );
      if (
        !fileObject ||
        fileObject.sha256 !== video.contentHash ||
        fileObject.sizeBytes !== video.sizeBytes ||
        fileObject.mimeType.toLocaleLowerCase('en-US') !== video.mimeType
      )
        throw conflict('Seedance 参考视频文件已失效');
      const expiresSeconds = 30 * 60;
      const url = await this.storage.signedReadUrl?.(
        fileObject.storageKey,
        expiresSeconds,
        video.sizeBytes,
      );
      if (!url) throw conflict('Seedance 参考视频访问地址尚未配置');
      return { url, expiresAt: new Date(Date.now() + expiresSeconds * 1000).toISOString() };
    }
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
    kind: 'VIDEO' | 'POSTER',
    expectedVersion?: number,
    rangeHeader?: string,
  ) {
    await this.projects.get(projectId);
    const task = await this.repository.task(projectId, taskId);
    if (!task || task.batchId !== batchId) throw notFound('视频渲染任务不存在');
    const videoMetadata =
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
    const version = variant === 'REPAIR' ? task.repairCandidateVersion : task.activeOutputVersion;
    if (expectedVersion !== undefined && version !== expectedVersion)
      throw conflict('视频输出版本已更新，请刷新后重试');
    const posterMetadata =
      version === null
        ? null
        : renderPoster(
            variant === 'REPAIR' ? task.repairCandidatePoster : task.outputPoster,
            version,
          );
    const metadata = kind === 'POSTER' ? posterMetadata : videoMetadata;
    if (kind === 'POSTER' && !metadata) throw notFound('视频首帧预览不存在');
    if (
      !metadata ||
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
    const range = kind === 'VIDEO' ? parseByteRange(rangeHeader, fileObject.sizeBytes) : undefined;
    return {
      mimeType: metadata.mimeType,
      originalFileName: metadata.originalFileName,
      contentHash: metadata.contentHash,
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
      actualDuration?: number;
      ratio?: string;
      resolution?: string;
    },
    files: UploadedSegmentRenderFile[] | undefined,
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
      await this.autoCommitCompletedBatch(projectId, task.batchId);
      return { completed: true, fileObjectId: replayedFileObjectId };
    }
    if (
      task.status !== 'RUNNING' ||
      task.renderVersion !== input.taskVersion ||
      task.attemptToken !== attemptToken
    )
      throw conflict('视频渲染任务租约或版本已失效');
    const uploadedFiles = files ?? [];
    if (
      uploadedFiles.some((item) => item.fieldname !== 'file' && item.fieldname !== 'poster') ||
      uploadedFiles.filter((item) => item.fieldname === 'file').length > 1 ||
      uploadedFiles.filter((item) => item.fieldname === 'poster').length > 1
    )
      throw badRequest('视频渲染输出文件字段无效');
    const file = uploadedFiles.find((item) => item.fieldname === 'file');
    const poster = uploadedFiles.find((item) => item.fieldname === 'poster');
    if (!file || file.size < 1) throw badRequest('视频渲染输出文件为空');
    if (file.size > EFFECT_SEGMENT_RENDER_LIMITS.maxUploadBytes)
      throw badRequest('视频渲染输出文件过大');
    const mimeType = file.mimetype.trim().toLocaleLowerCase('en-US');
    if (!mimeType.startsWith('video/')) throw badRequest('视频渲染输出文件类型无效');
    const posterMimeType = poster?.mimetype.trim().toLocaleLowerCase('en-US');
    if (poster && (poster.size < 1 || poster.size > EFFECT_SEGMENT_RENDER_LIMITS.maxPosterBytes))
      throw badRequest('视频首帧预览文件大小无效');
    if (poster && posterMimeType !== 'image/jpeg' && posterMimeType !== 'image/webp')
      throw badRequest('视频首帧预览文件类型无效');
    const snapshot = requestSnapshot(task.requestSnapshot);
    if (
      input.actualDuration !== undefined &&
      (!Number.isFinite(input.actualDuration) ||
        input.actualDuration <= 0 ||
        ((snapshot.operation !== 'REPAIR' || snapshot.repair?.providerMode === 'VIDEO_REFERENCE') &&
          Math.abs(input.actualDuration - snapshot.request.duration) > 0.1))
    )
      throw badRequest('Seedance 实际视频时长与任务快照不一致');
    const issues = validateEffectSeedanceTaskResult(snapshot, {
      ...(input.actualDuration !== undefined &&
      snapshot.operation === 'REPAIR' &&
      snapshot.repair?.providerMode !== 'VIDEO_REFERENCE'
        ? { duration: input.actualDuration }
        : input.duration !== undefined
          ? { duration: input.duration }
          : {}),
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
    let storedPoster:
      | {
          id: string;
          originalFileName: string;
          mimeType: string;
          sizeBytes: number;
          storageKey: string;
          sha256: string;
        }
      | undefined;
    try {
      if (poster && posterMimeType) {
        const posterSha256 = await fileSha256(poster.path);
        const posterFileName = safeFileName(
          poster.originalname ||
            task.renderCode + '-v' + String(task.renderVersion) + '-poster.jpg',
        );
        const posterStored = await this.storage.put({
          projectId,
          stream: createReadStream(poster.path),
          sizeBytes: poster.size,
          contentType: posterMimeType,
          keyContext: {
            projectName: project.name,
            workflow: 'EFFECT',
            lifecycle: 'staging',
            productId: task.productId,
            productName: product.name.trim() || '未命名产品',
            category: 'AI视频首帧',
            originalFileName: posterFileName,
          },
        });
        storedPoster = {
          id: randomUUID(),
          originalFileName: posterFileName,
          mimeType: posterMimeType,
          sizeBytes: posterStored.sizeBytes,
          storageKey: posterStored.key,
          sha256: posterSha256,
        };
      }
    } catch (error) {
      await this.storage.delete(stored.key).catch(() => undefined);
      throw error;
    }
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
        storedPoster,
        undefined,
        input.actualDuration ?? input.duration,
        input.ratio,
      );
      if (result.kind === 'NOT_FOUND') throw notFound('视频渲染任务不存在');
      if (result.kind === 'LEASE_CONFLICT') throw conflict('视频渲染任务租约或版本已失效');
      committed = true;
      const fileObjectId =
        result.task.operationKind === 'REPAIR'
          ? result.task.repairCandidateFileObjectId
          : result.task.outputFileObjectId;
      if (!fileObjectId) throw conflict('视频渲染输出文件不存在');
      if (result.task.operationKind !== 'REPAIR')
        await this.autoCommitCompletedBatch(projectId, result.task.batchId);
      return { completed: true, fileObjectId };
    } finally {
      if (!committed) {
        await this.storage.delete(stored.key).catch(() => undefined);
        if (storedPoster) await this.storage.delete(storedPoster.storageKey).catch(() => undefined);
      }
    }
  }

  private async autoCommitCompletedBatch(projectId: string, batchId: string): Promise<void> {
    const batch = await this.repository.batch(projectId, batchId);
    if (!batch) return;
    if (batch.committedAt) {
      await this.resumeCommittedBatchPublication(projectId, batch);
      return;
    }
    if (batch.tasks.some((task) => requestSnapshot(task.requestSnapshot).refreshContext?.schemaVersion === 1)) return;
    const run = await this.repository.workflowRun(projectId, batch.workflowRunId);
    if (run?.editSessionNodeId === 'SEGMENT_RENDER' && run.editSessionPurpose === 'MANUAL') return;
    // Single-clip retries, imports and repair candidates remain editable drafts.
    // Only a newly created complete batch is adopted automatically.
    if (
      batch.status !== 'COMPLETED' ||
      !batch.tasks.length ||
      batch.tasks.some(
        (task) =>
          task.status !== 'COMPLETED' ||
          task.operationKind !== 'GENERATE' ||
          task.repairStatus !== null ||
          !task.outputFileObjectId,
      )
    )
      return;
    const validation = await this.validate(projectId, batchId, batch.revision);
    if (!validation.valid) return;
    // validate commits the artifacts and publishes the hidden edit branch in
    // one repository transaction. The read path below remains for older
    // batches committed before that atomic boundary was introduced.
  }

  private async resumeCommittedBatchPublication(
    projectId: string,
    batch: EffectSegmentRenderBatchRecord,
  ): Promise<void> {
    // Committing the batch artifact and publishing its hidden branch currently
    // use separate transactions. Any subsequent batch read must close that gap,
    // even if the Worker never retries its completion callback. Inherited
    // committed batches predate the edit child and must not publish it.
    if (!batch.committedAt || batch.committedAt < batch.createdAt) return;
    const run = await this.repository.workflowRun(projectId, batch.workflowRunId);
    if (
      run?.parentWorkflowRunId &&
      !run.branchPublishedAt &&
      run.editSessionNodeId === 'SEGMENT_RENDER'
    )
      await this.workflowWorkingService.publishEffectNodeEdit(
        projectId,
        batch.workflowRunId,
        'SEGMENT_RENDER',
      );
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
    existingArtifacts: Array<
      Pick<WorkingArtifact, 'artifactKey' | 'freshness' | 'availability' | 'payload'>
    > = [],
  ): Array<{ artifactKey: string; input: WorkingArtifactUpsertInput }> {
    const sourceSnapshot = sourcePackageSnapshot(record.tasks[0]?.requestSnapshot);
    const promptDependency = (
      sourcePrompt: EffectSegmentRenderRequestSnapshot['sourcePrompt'],
    ) => ({
      sourceType: 'WORKING_ARTIFACT' as const,
      sourceNodeId: 'PROMPT_GENERATION',
      sourceArtifactId: sourcePrompt?.artifactId ?? record.sourcePromptArtifactId,
      sourceKey: 'prompt-batch:' + record.productId,
      sourceRevision: sourcePrompt?.revision ?? record.sourcePromptRevision,
      sourceHash: sourcePrompt?.contentHash ?? record.sourcePromptHash,
    });
    const sourceDependencies = [
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
    const existingByKey = new Map(
      existingArtifacts.map((artifact) => [artifact.artifactKey, artifact]),
    );
    const existingBatchPayload = existingByKey.get('render-batch:' + record.productId)?.payload;
    const confirmedClips = existingBatchPayload && typeof existingBatchPayload === 'object' &&
      !Array.isArray(existingBatchPayload) && 'clips' in existingBatchPayload &&
      Array.isArray(existingBatchPayload.clips)
      ? existingBatchPayload.clips : [];
    const completed = record.tasks.filter(
      (task) =>
        (task.status === 'COMPLETED' || (task.status === 'FAILED' &&
          requestSnapshot(task.requestSnapshot).refreshContext && requestSnapshot(task.requestSnapshot).adoptedInput)) &&
        task.outputFileObjectId &&
        task.outputStorageKey &&
        task.outputFileName &&
        task.outputMimeType &&
        task.outputSizeBytes !== null &&
        task.outputContentHash,
    );
    const clips = completed.map((task) => {
      const requested = requestSnapshot(task.requestSnapshot);
      const snapshot = requested.adoptedInput && task.outputFileObjectId ? requested.adoptedInput : requested;
      const original = requestSnapshot(task.generationRequestSnapshot ?? task.requestSnapshot);
      const confirmed = confirmedClips.find((clip) => clip && typeof clip === 'object' &&
        !Array.isArray(clip) && clip.taskId === task.id) as Record<string, unknown> | undefined;
      // Older imported pools did not serialize creative metadata already frozen at import.
      // Only an already-committed batch with unchanged original metadata may keep that shape;
      // edits clear committedAt, and new/changed fields must enter the content fingerprint.
      const legacyImport = Boolean(record.committedAt && snapshot.importedMaterial && confirmed);
      const includeCreativeCore = snapshot.creativeCore !== undefined && !(legacyImport &&
        !Object.prototype.hasOwnProperty.call(confirmed, 'creativeCore') &&
        snapshot.creativeCore === original.creativeCore);
      const includeDimensions = snapshot.dimensions !== undefined && !(legacyImport &&
        !Object.prototype.hasOwnProperty.call(confirmed, 'dimensions') &&
        workflowStateHash(snapshot.dimensions) === workflowStateHash(original.dimensions));
      return {
        taskId: task.id,
        renderCode: task.renderCode,
        promptId: task.promptId,
        promptCode: task.promptCode,
        promptContentHash: snapshot.promptContentHash,
        ...((snapshot.refreshContext || confirmed?.adoptedPrompt || !record.committedAt) ? { adoptedPrompt: snapshot.adoptedPrompt ?? renderPromptBaseline(snapshot),
          promptText: snapshot.promptText,
          sourcePrompt: snapshot.adoptedPrompt?.sourcePrompt ?? snapshot.sourcePrompt } : {}),
        primaryPurpose: snapshot.primaryPurpose,
        compatiblePurposes: snapshot.compatiblePurposes,
        ...(includeCreativeCore ? { creativeCore: snapshot.creativeCore } : {}),
        ...(includeDimensions ? { dimensions: snapshot.dimensions } : {}),
        durationSeconds: snapshot.outputDurationSeconds ?? snapshot.request.duration,
        ...(snapshot.importedMaterial
          ? {
              origin: 'EXTERNAL_IMPORT' as const,
              promptText: snapshot.promptText,
              importedMaterial: snapshot.importedMaterial,
            }
          : {}),
        ratio: snapshot.request.ratio,
        resolution: snapshot.request.resolution,
        version: task.activeOutputVersion ?? task.renderVersion,
        fileObjectId: task.outputFileObjectId!,
        contentHash: task.outputContentHash!,
      };
    });
    const clipArtifacts = completed
      .map((task) => {
        const requested = requestSnapshot(task.requestSnapshot);
        const snapshot = requested.adoptedInput && task.outputFileObjectId ? requested.adoptedInput : requested;
        const artifactKey = 'render-clip:' + task.id;
        const payload = clips.find(({ taskId }) => taskId === task.id)!;
        const existing = existingByKey.get(artifactKey);
        const existingPayload =
          existing?.payload && typeof existing.payload === 'object'
            ? (existing.payload as Record<string, unknown>)
            : null;
        const unchangedCurrentClip = Boolean(
          existing &&
          existing.freshness === 'CURRENT' &&
          existing.availability === 'AVAILABLE' &&
          existingPayload?.fileObjectId === payload.fileObjectId &&
          existingPayload?.contentHash === payload.contentHash &&
          existingPayload?.promptContentHash === payload.promptContentHash &&
          existingPayload?.durationSeconds === payload.durationSeconds &&
          existingPayload?.primaryPurpose === payload.primaryPurpose &&
          workflowStateHash(existingPayload?.compatiblePurposes) === workflowStateHash(payload.compatiblePurposes) &&
          existingPayload?.creativeCore === payload.creativeCore &&
          workflowStateHash(existingPayload?.dimensions ?? null) === workflowStateHash(payload.dimensions ?? null),
        );
        if (unchangedCurrentClip) return null;
        return {
          artifactKey,
          input: {
            kind: 'FILE',
            name: record.product.name + ' ' + task.renderCode + ' 视频片段',
            directory: 'VIDEO_MATERIALS',
            type: 'VIDEO_MATERIAL',
            tags: ['效果类', 'AI视频片段', snapshot.primaryPurpose],
            payload,
            metadata: { productId: record.productId, taskId: task.id, promptId: task.promptId },
            originalFileName: task.outputFileName!,
            mimeType: task.outputMimeType!,
            sizeBytes: task.outputSizeBytes!,
            storageKey: task.outputStorageKey!,
            fileChecksum: task.outputContentHash!,
            sourceRunId: task.id,
            sourceArtifactId: task.promptId,
            dependencies: snapshot.importedMaterial
              ? sourceDependencies
              : [promptDependency(snapshot.adoptedPrompt?.sourcePrompt ?? snapshot.sourcePrompt), ...sourceDependencies],
          } satisfies WorkingArtifactUpsertInput,
        };
      })
      .filter((artifact): artifact is NonNullable<typeof artifact> => Boolean(artifact));
    const dependencies = [promptDependency(undefined), ...sourceDependencies];
    const removedSources = record.tasks
      .filter((task) => task.errorCode === 'MATERIAL_DELETED')
      .map((task) => ({ taskId: task.id, promptId: task.promptId,
        ...(requestSnapshot(task.requestSnapshot).removedBy ? { removedBy: requestSnapshot(task.requestSnapshot).removedBy } : {}) }));
    // Preserve the persisted representation of an empty deletion list. Older confirmed pools
    // omitted this optional field; adding [] is not a user edit and must not lock navigation or
    // publish an otherwise empty revision. Real deletions always remain in the fingerprint.
    const includeRemovedSources = removedSources.length > 0 || Boolean(
      existingBatchPayload && typeof existingBatchPayload === 'object' &&
      !Array.isArray(existingBatchPayload) &&
      Object.prototype.hasOwnProperty.call(existingBatchPayload, 'removedSources'),
    );
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
          ...(includeRemovedSources ? { removedSources } : {}),
          promptDurationMaxSeconds: Math.max(
                  4,
                  ...record.tasks.map((task) => {
                    const snapshot = requestSnapshot(
                      task.generationRequestSnapshot ?? task.requestSnapshot,
                    );
                    return snapshot.promptDurationMaxSeconds ?? (snapshot.importedMaterial
                      ? (snapshot.importedMaterial.promptDurationMaxSeconds ?? 4)
                      : snapshot.request.duration);
                  }),
                ),
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
    if (record.tasks.some(({ outputFileObjectId, errorCode }) => !outputFileObjectId && errorCode !== 'MATERIAL_DELETED'))
      issues.push({ code: 'OUTPUT_MISSING', message: '仍有视频片段缺少输出文件' });
    if (record.tasks.some(({ repairStatus }) => repairStatus !== null))
      issues.push({ code: 'REPAIR_PENDING', message: '仍有视频返修结果等待采用或放弃' });
    const [currentPrompt, currentSourcePackage] = await Promise.all([
      this.repository.promptArtifact(projectId, record.workflowRunId, record.productId),
      this.repository.sourcePackageArtifact(projectId, record.workflowRunId, record.productId),
    ]);
    const currentPromptBatch = currentPrompt
      ? parseEffectPromptBatchResult(currentPrompt.payload)
      : null;
    const frozenLocalUpdate = record.tasks.some((task) => requestSnapshot(task.requestSnapshot).refreshContext?.schemaVersion === 1);
    if (!currentPrompt || currentPrompt.availability !== 'AVAILABLE' || !currentPromptBatch)
      issues.push({ code: 'PROMPT_UNAVAILABLE', message: '已确认提示词来源不可用，不能保存渲染结果' });
    if (record.tasks.some((task) => task.status === 'FAILED' && task.errorCode !== 'MATERIAL_DELETED' &&
      !(frozenLocalUpdate && task.outputFileObjectId && requestSnapshot(task.requestSnapshot).adoptedInput &&
        currentPromptBatch && !promptTaskNeedsUpdate(task, currentPromptBatch))))
      issues.push({ code: 'TASKS_FAILED', message: '仍有视频片段渲染异常，请重新生成' });
    const stalePromptCount = record.tasks.filter(
      (task) =>
        task.errorCode !== 'MATERIAL_DELETED' && (
        !currentPrompt ||
        currentPrompt.freshness !== 'CURRENT' ||
        currentPrompt.availability !== 'AVAILABLE' ||
        promptTaskNeedsUpdate(task, currentPromptBatch)),
    ).length;
    if (stalePromptCount && !frozenLocalUpdate)
      issues.push({
        code: 'PROMPT_STALE',
        message: `${stalePromptCount} 条素材对应的 Prompt 已变化，请先局部更新`,
      });
    const representedPromptIds = new Set(record.tasks
      .filter((task) => !requestSnapshot(task.requestSnapshot).importedMaterial)
      .map((task) => task.promptId));
    if (!frozenLocalUpdate && currentPromptBatch?.items.some((item) => !representedPromptIds.has(item.id)))
      issues.push({ code: 'PROMPT_ADDED', message: '仍有新增 Prompt 未渲染，请先局部更新' });
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
    const existingArtifacts = await this.workingRepository.listArtifacts(projectId, {
      workflowRunId: record.workflowRunId,
      nodeId: 'SEGMENT_RENDER',
    });
    const result = await this.repository.commitValidatedBatch(
      projectId,
      batchId,
      expectedBatchRevision,
      {
        artifactId: frozenLocalUpdate ? record.sourcePromptArtifactId : currentPrompt!.id,
        revision: frozenLocalUpdate ? record.sourcePromptRevision : currentPrompt!.revision,
        contentHash: frozenLocalUpdate ? record.sourcePromptHash : currentPrompt!.contentHash,
      },
      sourceSnapshot!,
      this.artifactInputs(record, existingArtifacts),
    );
    if (result.kind === 'REVISION_CONFLICT') throw conflict('视频渲染批次已更新，请刷新后重试');
    if (result.kind === 'PROMPT_CONFLICT') throw conflict('Prompt 批次已更新，请重新创建渲染批次');
    if (result.kind === 'SOURCE_CONFLICT') throw conflict('产品资料包已更新，请重新创建渲染批次');
    if (result.kind === 'NOT_READY') throw conflict('视频渲染批次尚未完成');
    if (result.kind === 'BRANCH_CONFLICT') throw conflict('渲染版本状态已变化，请刷新后重试');
    if (result.kind === 'CONFLICT') throw conflict('校验提交遇到并发写入，请稍后重试');
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
