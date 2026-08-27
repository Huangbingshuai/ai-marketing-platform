import { createHash, randomUUID } from 'node:crypto';

import type {
  EffectPromptBatchResult,
  EffectPromptDimensions,
  EffectPromptFragmentType,
  EffectPromptGraphVersion,
  EffectPromptItem,
  EffectPromptRenderProfile,
  EffectPromptNodeExecution,
  EffectPromptNodeId,
  EffectPromptProductState,
  EffectPromptRun,
  EffectPromptShardPhase,
  EffectPromptSharedPrompt,
  GetEffectPromptNodeDetailData,
  GetEffectPromptResultData,
  GetEffectPromptRunData,
  GetEffectPromptWorkspaceData,
  StartEffectPromptRunData,
  UpdateEffectPromptResultData,
  ValidateEffectPromptResultData,
} from '@ai-marketing/contracts';
import {
  EFFECT_PROMPT_DIMENSIONS,
  EFFECT_PROMPT_FRAGMENT_TYPES,
  EFFECT_PROMPT_GRAPH_NODES,
  EFFECT_PROMPT_GRAPH_VERSIONS,
  EFFECT_PROMPT_LIMITS,
  EFFECT_PROMPT_MAX_RUN_ATTEMPTS,
  EFFECT_PROMPT_SCHEMA_VERSION,
  EFFECT_PROMPT_SHARD_PHASES,
  CURRENT_EFFECT_PROMPT_GRAPH_VERSION,
  effectPromptTargetCount,
  effectPromptSettingsNodeId,
  migrateEffectPromptSettings,
  normalizeEffectPromptSettings,
  effectPromptGraphNodeIds,
} from '@ai-marketing/contracts';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';

import { ApiHttpException } from '../../../common/api-http-exception';
import { ProjectService } from '../../../platform/project/project.service';
import {
  WorkflowWorkingRepository,
  workingArtifactContentHash,
  type WorkingArtifactUpsertInput,
} from '../../../platform/workflow/workflow-working.repository';
import { workflowStateHash } from '../../../platform/workflow/workflow-state-hash';
import {
  EffectPromptRepository,
  type EffectPromptPreviewRunRecord,
  type EffectPromptRunRecord,
} from './effect-prompt.repository';
import {
  dimensionDistance,
  defaultEffectPromptRenderProfile,
  effectPromptExecutionIssues,
  effectPromptExactDuplicatePairs,
  effectPromptHardExecutionIssues,
  effectPromptSoftQualityWarnings,
  isEffectPromptItem,
  isEffectPromptSettings,
  parseEffectPromptBatchResult,
  parseLegacyV4EffectPromptBatchResultForRead,
  recomputePromptQuality,
  compileEffectPromptSharedPrompt,
} from './effect-prompt.quality';
import type {
  EffectPromptCompleteInput,
  EffectPromptShardInput,
  EffectPromptStageInput,
  EffectPromptInputSnapshot,
} from './effect-prompt.types';
import { presentEffectPromptNodeDetail } from './effect-prompt-node-detail';

const badRequest = (message: string) =>
  new ApiHttpException(message, HttpStatus.BAD_REQUEST, 'VALIDATION_ERROR');
const notFound = (message: string) =>
  new ApiHttpException(message, HttpStatus.NOT_FOUND, 'ASSET_NOT_FOUND');
const conflict = (message: string) =>
  new ApiHttpException(message, HttpStatus.CONFLICT, 'CONFLICT');

const publicWarnings = (value: unknown): string[] =>
  Array.isArray(value)
    ? [...new Set(value.filter((item): item is string => typeof item === 'string'))]
    : [];

const promptArtifactProductName = (snapshot: EffectPromptInputSnapshot): string => {
  const insight = snapshot.insightArtifact.result;
  if (insight && typeof insight === 'object' && !Array.isArray(insight)) {
    const record = insight as Record<string, unknown>;
    const value = [record.productName, record.product_name].find(
      (item): item is string => typeof item === 'string' && item.trim().length > 0,
    );
    if (value) return value.trim().slice(0, 96);
  }
  return `产品 ${snapshot.productId}`;
};

const graphVersionOf = (record: EffectPromptRunRecord): EffectPromptGraphVersion => {
  const snapshot = record.inputSnapshot as Partial<EffectPromptInputSnapshot> | null;
  if (
    snapshot?.graphVersion &&
    EFFECT_PROMPT_GRAPH_VERSIONS.includes(snapshot.graphVersion as EffectPromptGraphVersion)
  )
    return snapshot.graphVersion as EffectPromptGraphVersion;
  const legacyNodeIds = new Set(effectPromptGraphNodeIds('V8_SINGLE_STRATEGY'));
  const v9NodeIds = new Set(effectPromptGraphNodeIds('V9_SIX_BRANCH_STRATEGY'));
  const hasPersistedV10Stage = (record.stages ?? []).some(
    ({ nodeId }) =>
      !v9NodeIds.has(nodeId as EffectPromptNodeId) &&
      effectPromptGraphNodeIds('V10_RELATION_COORDINATE_BLUEPRINT').includes(
        nodeId as EffectPromptNodeId,
      ),
  );
  if (hasPersistedV10Stage) return 'V10_RELATION_COORDINATE_BLUEPRINT';
  const hasPersistedV9Stage = (record.stages ?? []).some(
    ({ nodeId }) =>
      !legacyNodeIds.has(nodeId as EffectPromptNodeId) &&
      effectPromptGraphNodeIds('V9_SIX_BRANCH_STRATEGY').includes(nodeId as EffectPromptNodeId),
  );
  return hasPersistedV9Stage ? 'V9_SIX_BRANCH_STRATEGY' : 'V8_SINGLE_STRATEGY';
};

const stageProgress = (
  nodeId: EffectPromptNodeId,
  status: string,
  graphVersion: EffectPromptGraphVersion,
): number => {
  const nodeIds = effectPromptGraphNodeIds(graphVersion);
  const index = nodeIds.indexOf(nodeId);
  const base = Math.round((Math.max(0, index) / nodeIds.length) * 95);
  return status === 'SUCCEEDED' || status === 'PARTIAL' || status === 'SKIPPED'
    ? Math.min(99, base + Math.round(95 / nodeIds.length))
    : Math.max(1, base);
};

const persistedFailedNode = (record: EffectPromptRunRecord): string | null =>
  record.stages.find(({ status }) => status === 'FAILED')?.nodeId ?? null;

const effectiveFailedNode = (record: EffectPromptRunRecord): string | null =>
  record.status === 'FAILED' ? (persistedFailedNode(record) ?? record.currentNode) : null;

const presentNodes = (record: EffectPromptRunRecord): EffectPromptNodeExecution[] =>
  effectPromptGraphNodeIds(graphVersionOf(record)).map((id) => {
    const stage = record.stages.find(({ nodeId }) => nodeId === id);
    const failedNode = effectiveFailedNode(record);
    const terminalFailure = record.status === 'FAILED' && failedNode === id;
    const abortedSibling =
      record.status === 'FAILED' && stage?.status === 'RUNNING' && failedNode !== id;
    return {
      nodeId: id,
      status: terminalFailure
        ? 'FAILED'
        : abortedSibling
          ? 'SKIPPED'
          : (stage?.status ?? 'PENDING'),
      summary: abortedSibling ? '任务已停止，该分支未完成' : (stage?.summary ?? ''),
      warnings: publicWarnings(stage?.warnings),
      errorMessage: terminalFailure
        ? (stage?.errorMessage ?? record.errorMessage)
        : abortedSibling
          ? null
          : (stage?.errorMessage ?? null),
    };
  });

const presentRun = (record: EffectPromptRunRecord): EffectPromptRun => ({
  id: record.id,
  projectId: record.projectId,
  workflowRunId: record.workflowRunId,
  productId: record.productId,
  operation: record.operation,
  targetItemId: record.targetItemId,
  status: record.status,
  graphVersion: graphVersionOf(record),
  progress: record.progress,
  attemptCount: record.attemptCount,
  maxAttempts: EFFECT_PROMPT_MAX_RUN_ATTEMPTS,
  currentNode:
    record.currentNode === 'COMPLETED'
      ? 'COMPLETED'
      : (EFFECT_PROMPT_GRAPH_NODES.find(
          ({ id }) => id === (effectiveFailedNode(record) ?? record.currentNode),
        )?.id ?? null),
  warnings: publicWarnings(record.warnings),
  errorCode: record.errorCode,
  errorMessage: record.errorMessage,
  promptResultId: record.result?.id ?? null,
  nodes: presentNodes(record),
  createdAt: record.createdAt.toISOString(),
  updatedAt: record.updatedAt.toISOString(),
});

const searchable = (item: EffectPromptItem, query: string): boolean => {
  const target = query.trim().toLocaleLowerCase('zh-CN');
  if (!target) return true;
  return [
    item.code,
    item.content,
    item.fragmentType,
    ...item.materialTags,
    ...EFFECT_PROMPT_DIMENSIONS.map(({ key }) => item.dimensions[key]),
  ].some((value) => value.toLocaleLowerCase('zh-CN').includes(target));
};

const fragmentDisplayOrder = new Map(
  EFFECT_PROMPT_FRAGMENT_TYPES.map((fragmentType, index) => [fragmentType, index]),
);

const comparePromptItemsForDisplay = (left: EffectPromptItem, right: EffectPromptItem): number => {
  const fragmentOrder =
    (fragmentDisplayOrder.get(left.fragmentType) ?? EFFECT_PROMPT_FRAGMENT_TYPES.length) -
    (fragmentDisplayOrder.get(right.fragmentType) ?? EFFECT_PROMPT_FRAGMENT_TYPES.length);
  if (fragmentOrder !== 0) return fragmentOrder;
  return left.code.localeCompare(right.code, 'zh-CN', { numeric: true });
};

const unknownRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const previewItemId = (sourceFingerprint: string, slotId: string): string => {
  const bytes = createHash('sha256')
    .update(`${sourceFingerprint}:${slotId}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

const promptPreviewItems = (run: EffectPromptPreviewRunRecord): EffectPromptItem[] => {
  const unique = new Map<string, EffectPromptItem>();
  for (const shard of run.shards) {
    for (const value of Array.isArray(shard.items) ? shard.items : []) {
      const item = unknownRecord(value);
      if (!item) continue;
      const invalidReasons = Array.isArray(item.executionInvalidReasons)
        ? item.executionInvalidReasons.filter((reason): reason is string => typeof reason === 'string')
        : [];
      if (effectPromptHardExecutionIssues(invalidReasons).length > 0) continue;
      const slotId = typeof item.slotId === 'string' ? item.slotId : '';
      const ordinal = typeof item.ordinal === 'number' ? item.ordinal : 0;
      const generatedAt = typeof item.generatedAt === 'string' ? item.generatedAt : '';
      if (!slotId || !Number.isSafeInteger(ordinal) || ordinal < 1 || !generatedAt) continue;
      const candidate = {
        id: previewItemId(run.sourceFingerprint, slotId),
        code: `P${String(ordinal).padStart(3, '0')}`,
        origin: 'AI',
        fragmentType: item.fragmentType,
        materialTags: item.materialTags,
        targetDurationSeconds: item.targetDurationSeconds,
        dimensions: item.dimensions,
        content: item.content,
        insightBindings: item.insightBindings,
        manualEdited: false,
        createdAt: generatedAt,
        updatedAt: generatedAt,
      };
      if (isEffectPromptItem(candidate)) unique.set(candidate.id, candidate);
    }
  }
  return [...unique.values()].sort(comparePromptItemsForDisplay);
};

const previewRenderProfile = (snapshot: EffectPromptInputSnapshot): EffectPromptRenderProfile => {
  const profile = defaultEffectPromptRenderProfile();
  const insight = unknownRecord(snapshot.insightArtifact.result);
  if (!insight) return profile;
  const ratioRaw = [insight.aspectRatio, insight.aspect_ratio].find(
    (value): value is string => typeof value === 'string' && value.trim().length > 0,
  );
  const resolutionRaw =
    typeof insight.resolution === 'string' ? insight.resolution.toLowerCase() : '';
  const ratio = ratioRaw?.replace('：', ':');
  const supportedRatios: EffectPromptRenderProfile['ratio'][] = [
    '16:9',
    '4:3',
    '1:1',
    '3:4',
    '9:16',
    '21:9',
    'adaptive',
  ];
  const supportedResolutions: EffectPromptRenderProfile['resolution'][] = ['480p', '720p', '1080p'];
  const disabledRaw = [insight.disabledElements, insight.disabled_elements].find(Array.isArray);
  const disabledElements = Array.isArray(disabledRaw)
    ? disabledRaw.filter(
        (value): value is string => typeof value === 'string' && value.trim().length > 0,
      )
    : [];
  return {
    ...profile,
    ratio: supportedRatios.includes(ratio as EffectPromptRenderProfile['ratio'])
      ? (ratio as EffectPromptRenderProfile['ratio'])
      : profile.ratio,
    resolution: supportedResolutions.includes(
      resolutionRaw as EffectPromptRenderProfile['resolution'],
    )
      ? (resolutionRaw as EffectPromptRenderProfile['resolution'])
      : profile.resolution,
    sharedConstraints: {
      disabledElements,
      contentHash: createHash('sha256').update(JSON.stringify(disabledElements)).digest('hex'),
    },
  };
};

const validateDimensions = (dimensions: EffectPromptDimensions): boolean =>
  Boolean(
    dimensions &&
    Object.keys(dimensions).length === EFFECT_PROMPT_DIMENSIONS.length &&
    EFFECT_PROMPT_DIMENSIONS.every(({ key }) => {
      const maximum = {
        narrative: 120,
        scene: 120,
        persona: 160,
        sellingPoint: 240,
        camera: 160,
        emotion: 120,
      }[key];
      return (
        typeof dimensions[key] === 'string' &&
        dimensions[key].trim().length > 0 &&
        dimensions[key].length <= maximum
      );
    }),
  );

@Injectable()
export class EffectPromptService {
  constructor(
    @Inject(EffectPromptRepository) private readonly repository: EffectPromptRepository,
    @Inject(ProjectService) private readonly projects: ProjectService,
    @Inject(WorkflowWorkingRepository)
    private readonly workingRepository: WorkflowWorkingRepository,
  ) {}

  private async requireWorkflow(projectId: string, workflowRunId: string): Promise<void> {
    await this.projects.get(projectId);
    if (!(await this.repository.workflowRun(projectId, workflowRunId)))
      throw notFound('效果类工作流运行不存在');
  }

  private async artifactInput(
    resultRecord: Awaited<ReturnType<EffectPromptRepository['result']>>,
    draft: EffectPromptBatchResult,
  ): Promise<WorkingArtifactUpsertInput | null> {
    if (!resultRecord) return null;
    const run = await this.repository.run(resultRecord.projectId, resultRecord.runId);
    if (!run) return null;
    const snapshot = run.inputSnapshot as EffectPromptInputSnapshot;
    return {
      kind: 'STRUCTURED',
      name: `${promptArtifactProductName(snapshot)} 差异化 Prompt 批次`,
      directory: 'PROMPTS',
      type: 'PROMPT',
      tags: ['效果类', '差异化Prompt'],
      payload: draft,
      metadata: {
        schemaVersion: EFFECT_PROMPT_SCHEMA_VERSION,
        productId: resultRecord.productId,
        qualityStatus: draft.qualityStatus,
      },
      sourceRunId: run.id,
      sourceArtifactId: resultRecord.id,
      dependencies: [
        {
          sourceType: 'WORKING_ARTIFACT',
          sourceNodeId: 'INFORMATION_EXTRACTION',
          sourceArtifactId: snapshot.insightArtifact.id,
          sourceKey: `marketing-insight:${resultRecord.productId}`,
          sourceRevision: snapshot.insightArtifact.revision,
          sourceHash: snapshot.insightArtifact.contentHash,
        },
        {
          sourceType: 'EXECUTION_INPUT',
          sourceNodeId: effectPromptSettingsNodeId(resultRecord.productId),
          sourceKey: effectPromptSettingsNodeId(resultRecord.productId),
          sourceRevision: null,
          sourceHash: run.settingsHash,
        },
      ],
    };
  }

  async workspace(projectId: string, workflowRunId: string): Promise<GetEffectPromptWorkspaceData> {
    await this.requireWorkflow(projectId, workflowRunId);
    const products = await this.repository.products(projectId, workflowRunId);
    const states: EffectPromptProductState[] = await Promise.all(
      products.map(async (product) => {
        const runRecord = product.promptRuns[0]
          ? await this.repository.run(projectId, product.promptRuns[0].id)
          : null;
        const resultRecord =
          runRecord?.result ??
          (await this.repository.latestResult(projectId, workflowRunId, product.id));
        const resultRun =
          resultRecord && resultRecord.runId !== runRecord?.id
            ? await this.repository.run(projectId, resultRecord.runId)
            : runRecord;
        const draft = resultRecord
          ? (parseEffectPromptBatchResult(resultRecord.draftResult) ??
            parseLegacyV4EffectPromptBatchResultForRead(resultRecord.draftResult))
          : null;
        const settingsNode = await this.repository.settingsNode(
          projectId,
          workflowRunId,
          product.id,
        );
        const settings = isEffectPromptSettings(settingsNode?.state)
          ? normalizeEffectPromptSettings(settingsNode.state)
          : migrateEffectPromptSettings(settingsNode?.state, settingsNode?.schemaVersion ?? 1);
        const legacyResult = Boolean(
          resultRecord && resultRecord.schemaVersion !== EFFECT_PROMPT_SCHEMA_VERSION,
        );
        const insight = await this.repository.insightArtifact(projectId, workflowRunId, product.id);
        const snapshot = resultRun?.inputSnapshot as EffectPromptInputSnapshot | undefined;
        const stale = Boolean(
          resultRecord &&
          (!insight ||
            legacyResult ||
            insight.freshness !== 'CURRENT' ||
            insight.availability !== 'AVAILABLE' ||
            snapshot?.insightArtifact.id !== insight.id ||
            snapshot.insightArtifact.revision !== insight.revision ||
            snapshot.insightArtifact.contentHash !== insight.contentHash ||
            resultRecord.settingsHash !== workflowStateHash(settings)),
        );
        const artifact = await this.repository.promptArtifact(projectId, workflowRunId, product.id);
        const artifactInput =
          resultRecord && draft ? await this.artifactInput(resultRecord, draft) : null;
        const commitStatus = !artifact
          ? 'UNVALIDATED'
          : stale || artifact.freshness !== 'CURRENT' || artifact.availability !== 'AVAILABLE'
            ? 'STALE'
            : artifactInput && artifact.contentHash === workingArtifactContentHash(artifactInput)
              ? 'COMMITTED'
              : 'DRAFT_CHANGED';
        const status = !runRecord
          ? 'NOT_GENERATED'
          : runRecord.status === 'QUEUED'
            ? 'QUEUED'
            : runRecord.status === 'RUNNING'
              ? 'PROCESSING'
              : stale
                ? 'STALE'
                : runRecord.status;
        return {
          projectId,
          workflowRunId,
          productId: product.id,
          status,
          graphVersion: runRecord ? graphVersionOf(runRecord) : CURRENT_EFFECT_PROMPT_GRAPH_VERSION,
          runId: runRecord?.id ?? null,
          resultId: draft ? (resultRecord?.id ?? null) : null,
          resultRevision: draft ? (resultRecord?.revision ?? null) : null,
          settings,
          settingsRevision: settingsNode?.revision ?? null,
          metrics: draft?.metrics ?? null,
          qualityStatus: draft?.qualityStatus ?? null,
          commitStatus,
          workingArtifactRevision: artifact?.revision ?? null,
          progress: runRecord?.progress ?? 0,
          currentNode: runRecord?.currentNode ?? null,
          errorCode: runRecord?.errorCode ?? null,
          errorMessage: legacyResult
            ? 'Prompt 生成规则已升级；旧的 3 秒设置会在重新生成时调整为当前模型允许的 4 秒'
            : (runRecord?.errorMessage ?? null),
          updatedAt: (runRecord?.updatedAt ?? product.updatedAt).toISOString(),
        };
      }),
    );
    return { projectId, workflowRunId, products: states };
  }

  async saveSettings(
    projectId: string,
    productId: string,
    workflowRunId: string,
    expectedRevision: number | null,
    settings: unknown,
  ) {
    await this.requireWorkflow(projectId, workflowRunId);
    if (!isEffectPromptSettings(settings)) throw badRequest('Prompt 批次设置不符合允许范围');
    const product = (await this.repository.products(projectId, workflowRunId)).find(
      ({ id }) => id === productId,
    );
    if (!product) throw notFound('产品不存在');
    const normalized = normalizeEffectPromptSettings(settings);
    const hash = workflowStateHash(normalized);
    const result = await this.workingRepository.saveNodeState(
      projectId,
      workflowRunId,
      effectPromptSettingsNodeId(productId),
      hash,
      normalized,
      expectedRevision,
      EFFECT_PROMPT_SCHEMA_VERSION,
      hash,
      EFFECT_PROMPT_SCHEMA_VERSION,
    );
    if (result.conflict) throw conflict('Prompt 批次设置已在其他页面更新，请刷新后重试');
    return {
      productId,
      settings: normalized,
      settingsRevision: result.record.revision,
      unchanged: result.unchanged,
      savedAt: result.record.savedAt.toISOString(),
    };
  }

  async start(
    projectId: string,
    productId: string,
    input: {
      workflowRunId: string;
      operation: 'BATCH_GENERATE' | 'ITEM_REGENERATE';
      targetItemId?: string;
      regenerationInstruction?: string;
      replacementDimensions?: EffectPromptDimensions;
      expectedSettingsRevision: number;
      expectedResultRevision?: number;
      idempotencyKey: string;
    },
  ): Promise<StartEffectPromptRunData> {
    await this.requireWorkflow(projectId, input.workflowRunId);
    const idempotencyKey = input.idempotencyKey.trim();
    if (!idempotencyKey) throw badRequest('幂等键不能为空');
    if (
      input.operation === 'BATCH_GENERATE' &&
      (input.regenerationInstruction !== undefined || input.replacementDimensions !== undefined)
    )
      throw badRequest('批量生成不能携带单条重生成设置');
    if (input.operation === 'ITEM_REGENERATE' && !input.targetItemId)
      throw badRequest('单条重新生成必须指定 Prompt');
    if ((input.regenerationInstruction?.trim().length ?? 0) > 500)
      throw badRequest('修改意见不能超过 500 字');
    if (input.replacementDimensions && !validateDimensions(input.replacementDimensions))
      throw badRequest('六维设置必须完整填写且不能超过长度限制');
    const replacementDimensions = input.replacementDimensions
      ? (Object.fromEntries(
          EFFECT_PROMPT_DIMENSIONS.map(({ key }) => [
            key,
            input.replacementDimensions![key].trim(),
          ]),
        ) as EffectPromptDimensions)
      : null;
    const regenerationInstruction = input.regenerationInstruction?.trim() || null;
    const result = await this.repository.startRun(projectId, input.workflowRunId, productId, {
      operation: input.operation,
      targetItemId: input.targetItemId ?? null,
      regenerationInstruction,
      replacementDimensions,
      expectedSettingsRevision: input.expectedSettingsRevision,
      expectedResultRevision: input.expectedResultRevision ?? null,
      idempotencyKey,
    });
    if (result.kind === 'NOT_FOUND') throw notFound('工作流或产品不存在');
    if (result.kind === 'SETTINGS_CONFLICT') throw conflict('Prompt 设置已更新，请刷新后重试');
    if (result.kind === 'INSIGHT_NOT_READY') throw conflict('产品信息卡尚未完成校验');
    if (result.kind === 'RESULT_CONFLICT') throw conflict('Prompt 结果已更新，请刷新后重试');
    if (result.kind === 'ITEM_NOT_FOUND') throw notFound('Prompt 不存在');
    if (result.kind === 'INVALID_SELLING_POINT')
      throw badRequest('所选卖点不是当前信息卡已确认且适用于该片段类型的卖点');
    if (result.kind === 'MANUAL_COUNT_EXCEEDED')
      throw conflict('人工保留 Prompt 数量已超过目标数量，请先提高生成数量');
    if (result.kind === 'ACTIVE_CONFLICT') throw conflict('当前产品已有进行中的 Prompt 任务');
    if (result.kind === 'KEY_CONFLICT') throw conflict('幂等键已用于其他 Prompt 请求');
    const record = await this.repository.run(projectId, result.run.id);
    if (!record) throw notFound('Prompt 任务不存在');
    return { run: presentRun(record) };
  }

  async run(projectId: string, runId: string): Promise<GetEffectPromptRunData> {
    await this.projects.get(projectId);
    const record = await this.repository.run(projectId, runId);
    if (!record) throw notFound('Prompt 任务不存在');
    return { run: presentRun(record) };
  }

  async nodeDetail(
    projectId: string,
    runId: string,
    rawNodeId: string,
  ): Promise<GetEffectPromptNodeDetailData> {
    await this.projects.get(projectId);
    const definition = EFFECT_PROMPT_GRAPH_NODES.find(({ id }) => id === rawNodeId);
    if (!definition) throw badRequest('未知的 Prompt 子工作流节点');
    const record = await this.repository.runForNodeDetail(projectId, runId);
    if (!record) throw notFound('Prompt 任务不存在');
    if (!effectPromptGraphNodeIds(graphVersionOf(record)).includes(definition.id))
      throw badRequest('该节点不属于当前 Prompt 工作流版本');
    return { detail: presentEffectPromptNodeDetail(record, definition.id) };
  }

  async result(
    projectId: string,
    workflowRunId: string,
    productId: string,
    page: number,
    pageSize: number,
    query = '',
    fragmentType?: EffectPromptFragmentType,
  ): Promise<GetEffectPromptResultData> {
    await this.requireWorkflow(projectId, workflowRunId);
    const record = await this.repository.latestResult(projectId, workflowRunId, productId);
    if (!record) {
      const failedRun = await this.repository.latestFailedRunForPreview(
        projectId,
        workflowRunId,
        productId,
      );
      if (!failedRun) throw notFound('Prompt 结果不存在');
      const snapshot = failedRun.inputSnapshot as Partial<EffectPromptInputSnapshot> | null;
      if (!snapshot?.settings || !isEffectPromptSettings(snapshot.settings))
        throw notFound('Prompt 结果不存在');
      const items = promptPreviewItems(failedRun);
      const renderProfile = previewRenderProfile(snapshot as EffectPromptInputSnapshot);
      const sharedPrompt =
        snapshot.sharedPrompt ??
        compileEffectPromptSharedPrompt(renderProfile.sharedConstraints.disabledElements);
      const preview = recomputePromptQuality(
        items,
        snapshot.settings,
        {
          generatedCandidateCount: failedRun.shards.reduce(
            (count, shard) => count + (Array.isArray(shard.items) ? shard.items.length : 0),
            0,
          ),
        },
        renderProfile,
        sharedPrompt,
      );
      const filtered = preview.items
        .filter(
          (item) =>
            (!fragmentType || item.fragmentType === fragmentType) && searchable(item, query),
        )
        .sort(comparePromptItemsForDisplay);
      const offset = (page - 1) * pageSize;
      return {
        projectId,
        productId,
        resultId: null,
        revision: null,
        isPartialPreview: true,
        previewRunId: failedRun.id,
        result: {
          schemaVersion: preview.schemaVersion,
          settings: preview.settings,
          renderProfile: preview.renderProfile,
          ...(preview.sharedPrompt ? { sharedPrompt: preview.sharedPrompt } : {}),
          metrics: preview.metrics,
          qualityStatus: 'NEEDS_REVIEW',
        },
        items: filtered.slice(offset, offset + pageSize),
        total: filtered.length,
        page,
        pageSize,
      };
    }
    const draft =
      parseEffectPromptBatchResult(record.draftResult) ??
      parseLegacyV4EffectPromptBatchResultForRead(record.draftResult);
    if (!draft) throw conflict('Prompt 结果结构无效，请重新生成');
    const filtered = draft.items
      .filter(
        (item) => (!fragmentType || item.fragmentType === fragmentType) && searchable(item, query),
      )
      .sort(comparePromptItemsForDisplay);
    const offset = (page - 1) * pageSize;
    const summary = {
      schemaVersion: draft.schemaVersion,
      settings: draft.settings,
      renderProfile: draft.renderProfile,
      ...(draft.sharedPrompt ? { sharedPrompt: draft.sharedPrompt } : {}),
      metrics: draft.metrics,
      qualityStatus: draft.qualityStatus,
    };
    return {
      projectId,
      productId,
      resultId: record.id,
      revision: record.revision,
      isPartialPreview: false,
      previewRunId: null,
      result: summary,
      items: filtered.slice(offset, offset + pageSize),
      total: filtered.length,
      page,
      pageSize,
    };
  }

  private validItemInput(input: {
    content: string;
    fragmentType: EffectPromptFragmentType;
    materialTags: string[];
    dimensions: EffectPromptDimensions;
  }): boolean {
    return (
      input.content.trim().length > 0 &&
      input.content.length <= 12_000 &&
      EFFECT_PROMPT_FRAGMENT_TYPES.includes(input.fragmentType) &&
      Array.isArray(input.materialTags) &&
      input.materialTags.length > 0 &&
      input.materialTags.length <= EFFECT_PROMPT_LIMITS.maxMaterialTags &&
      input.materialTags.every(
        (tag) => typeof tag === 'string' && tag.trim().length > 0 && tag.length <= 120,
      ) &&
      new Set(
        input.materialTags.map((tag) => tag.normalize('NFC').trim().toLocaleLowerCase('zh-CN')),
      ).size === input.materialTags.length &&
      validateDimensions(input.dimensions)
    );
  }

  private presentMutation(
    output: Awaited<ReturnType<EffectPromptRepository['mutateResult']>>,
  ): UpdateEffectPromptResultData {
    if (output.kind === 'NOT_FOUND') throw notFound('Prompt 结果不存在');
    if (output.kind === 'REVISION_CONFLICT')
      throw conflict('Prompt 结果已被其他操作更新，请刷新后重试');
    if (output.kind === 'ITEM_NOT_FOUND') throw notFound('Prompt 不存在');
    if (output.kind === 'ITEM_CONFLICT') throw conflict('Prompt 标识冲突');
    if (output.kind === 'INVALID_RESULT') throw conflict('Prompt 结果结构无效，请重新生成');
    return {
      resultId: output.result.id,
      productId: output.result.productId,
      revision: output.result.revision,
      result: output.draft,
      savedAt: (output.result.savedAt ?? output.result.updatedAt).toISOString(),
      unchanged: output.kind === 'UNCHANGED',
    };
  }

  async addItem(
    projectId: string,
    resultId: string,
    expectedRevision: number,
    input: {
      content: string;
      fragmentType: EffectPromptFragmentType;
      materialTags: string[];
      dimensions: EffectPromptDimensions;
    },
  ): Promise<UpdateEffectPromptResultData> {
    await this.projects.get(projectId);
    if (!this.validItemInput(input)) throw badRequest('Prompt 内容或六维标签不完整');
    const current = await this.repository.result(projectId, resultId);
    if (!current) throw notFound('Prompt 结果不存在');
    if (current.schemaVersion !== EFFECT_PROMPT_SCHEMA_VERSION)
      throw conflict('旧版 Prompt 结果不能编辑，请执行全量重新生成');
    const rawDraft =
      current.draftResult &&
      typeof current.draftResult === 'object' &&
      !Array.isArray(current.draftResult)
        ? (current.draftResult as Record<string, unknown>)
        : null;
    if (Array.isArray(rawDraft?.items) && rawDraft.items.length >= EFFECT_PROMPT_LIMITS.maxCount)
      throw badRequest(`Prompt 数量已达到 ${EFFECT_PROMPT_LIMITS.maxCount} 条上限`);
    const parsed = parseEffectPromptBatchResult(current.draftResult);
    if (!parsed) throw conflict('Prompt 结果结构无效，请重新生成');
    const maxCode = parsed.items.reduce((maximum, item) => {
      const number = Number(item.code.replace(/\D+/gu, ''));
      return Number.isFinite(number) ? Math.max(maximum, number) : maximum;
    }, 0);
    const now = new Date().toISOString();
    const item: EffectPromptItem = {
      id: randomUUID(),
      code: `P${String(maxCode + 1).padStart(3, '0')}`,
      origin: 'MANUAL',
      fragmentType: input.fragmentType,
      materialTags: input.materialTags.map((tag) => tag.normalize('NFC').trim()),
      targetDurationSeconds: parsed.settings.fragmentConfigs[input.fragmentType].durationSeconds,
      dimensions: Object.fromEntries(
        EFFECT_PROMPT_DIMENSIONS.map(({ key }) => [key, input.dimensions[key].trim()]),
      ) as EffectPromptDimensions,
      content: input.content.trim(),
      insightBindings: [],
      manualEdited: true,
      createdAt: now,
      updatedAt: now,
    };
    return this.presentMutation(
      await this.repository.mutateResult(projectId, resultId, expectedRevision, {
        kind: 'ADD',
        item,
      }),
    );
  }

  async updateItem(
    projectId: string,
    resultId: string,
    itemId: string,
    expectedRevision: number,
    input: {
      content: string;
      fragmentType: EffectPromptFragmentType;
      materialTags: string[];
      dimensions: EffectPromptDimensions;
    },
  ): Promise<UpdateEffectPromptResultData> {
    await this.projects.get(projectId);
    if (!this.validItemInput(input)) throw badRequest('Prompt 内容或六维标签不完整');
    const current = await this.repository.result(projectId, resultId);
    if (!current) throw notFound('Prompt 结果不存在');
    if (current.schemaVersion !== EFFECT_PROMPT_SCHEMA_VERSION)
      throw conflict('旧版 Prompt 结果不能编辑，请执行全量重新生成');
    const parsed = parseEffectPromptBatchResult(current.draftResult);
    if (!parsed) throw conflict('Prompt 结果结构无效，请重新生成');
    return this.presentMutation(
      await this.repository.mutateResult(projectId, resultId, expectedRevision, {
        kind: 'UPDATE',
        itemId,
        item: {
          content: input.content.trim(),
          fragmentType: input.fragmentType,
          materialTags: input.materialTags.map((tag) => tag.normalize('NFC').trim()),
          targetDurationSeconds:
            parsed.settings.fragmentConfigs[input.fragmentType].durationSeconds,
          dimensions: Object.fromEntries(
            EFFECT_PROMPT_DIMENSIONS.map(({ key }) => [key, input.dimensions[key].trim()]),
          ) as EffectPromptDimensions,
        },
      }),
    );
  }

  async deleteItem(
    projectId: string,
    resultId: string,
    itemId: string,
    expectedRevision: number,
  ): Promise<UpdateEffectPromptResultData> {
    await this.projects.get(projectId);
    return this.presentMutation(
      await this.repository.mutateResult(projectId, resultId, expectedRevision, {
        kind: 'DELETE',
        itemId,
      }),
    );
  }

  async updateSharedPrompt(
    projectId: string,
    resultId: string,
    expectedRevision: number,
    content: string,
  ): Promise<UpdateEffectPromptResultData> {
    await this.projects.get(projectId);
    const current = await this.repository.result(projectId, resultId);
    if (!current) throw notFound('Prompt 结果不存在');
    if (current.schemaVersion !== EFFECT_PROMPT_SCHEMA_VERSION)
      throw conflict('旧版 Prompt 结果不能编辑，请执行全量重新生成');
    const parsed = parseEffectPromptBatchResult(current.draftResult);
    if (!parsed) throw conflict('Prompt 结果结构无效，请重新生成');
    const compiledContent = content.trim();
    if (compiledContent.length > 60_000) throw badRequest('共用提示词不能超过 60000 字');
    const fixedContent =
      parsed.sharedPrompt?.sections
        .filter(({ key }) => key !== 'USER_ADDITIONAL')
        .map(({ content: sectionContent }) => sectionContent.trim())
        .filter(Boolean)
        .join('\n') ??
      compileEffectPromptSharedPrompt(parsed.renderProfile.sharedConstraints.disabledElements)
        .sections[0]?.content ??
      '';
    const additionalContent = fixedContent
      ? compiledContent === fixedContent
        ? ''
        : compiledContent.startsWith(`${fixedContent}\n`)
          ? compiledContent.slice(fixedContent.length + 1).trim()
          : null
      : compiledContent;
    if (additionalContent === null)
      throw badRequest('共用提示词中的系统内容不能删除或修改，请返回资料导入节点调整');
    if (additionalContent.length > 30_000)
      throw badRequest('共用提示词中的补充内容不能超过 30000 字');
    const sharedPrompt: EffectPromptSharedPrompt = compileEffectPromptSharedPrompt(
      parsed.renderProfile.sharedConstraints.disabledElements,
      additionalContent,
      parsed.sharedPrompt?.sections,
    );
    return this.presentMutation(
      await this.repository.mutateResult(projectId, resultId, expectedRevision, {
        kind: 'SHARED_PROMPT',
        sharedPrompt,
      }),
    );
  }

  async validateResult(
    projectId: string,
    resultId: string,
    expectedRevision: number,
  ): Promise<ValidateEffectPromptResultData> {
    await this.projects.get(projectId);
    const record = await this.repository.result(projectId, resultId);
    if (!record) throw notFound('Prompt 结果不存在');
    if (record.revision !== expectedRevision)
      throw conflict('Prompt 结果已被其他操作更新，请刷新后重试');
    if (record.schemaVersion !== EFFECT_PROMPT_SCHEMA_VERSION)
      return {
        valid: false,
        issues: [
          {
            code: 'LEGACY_SCHEMA',
            message: '旧版 Prompt 不是片段素材指令，必须执行全量重新生成',
          },
        ],
        productId: record.productId,
        artifacts: [],
        allProductsValidated: false,
        validatedAt: new Date().toISOString(),
      };
    const draft = parseEffectPromptBatchResult(record.draftResult);
    if (!draft)
      return {
        valid: false,
        issues: [{ code: 'INVALID_RESULT', message: 'Prompt 结果结构无效' }],
        productId: record.productId,
        artifacts: [],
        allProductsValidated: false,
        validatedAt: new Date().toISOString(),
      };
    const verified = recomputePromptQuality(
      draft.items,
      draft.settings,
      draft.metrics,
      draft.renderProfile,
      draft.sharedPrompt,
    );
    const issues: Array<{ code: string; message: string }> = [];
    const warnings: Array<{ code: string; message: string }> = [];
    if (verified.items.length !== effectPromptTargetCount(verified.settings))
      issues.push({ code: 'COUNT_MISMATCH', message: 'Prompt 数量尚未达到目标数量' });
    if (effectPromptExactDuplicatePairs(verified.items) > 0)
      issues.push({ code: 'EXACT_DUPLICATE', message: '存在正文完全重复的 Prompt' });
    if (verified.metrics.semanticDuplicateRate > verified.settings.semanticLimit)
      issues.push({ code: 'SEMANTIC_DUPLICATE', message: '语义重复度超过设置上限' });
    if (verified.metrics.visualOverlapRate > verified.settings.visualLimit)
      issues.push({ code: 'VISUAL_OVERLAP', message: '视觉重合度超过设置上限' });
    if (
      verified.metrics.fragmentTypeDistribution.some(
        ({ targetCount, actualCount }) => targetCount !== actualCount,
      )
    )
      issues.push({ code: 'FRAGMENT_TYPE_DISTRIBUTION', message: '片段标签数量未达到设置权重' });
    if (verified.metrics.sellingPointCoverage.missing.length)
      issues.push({ code: 'SELLING_POINT_COVERAGE', message: '仍有必需卖点未被片段覆盖' });
    if (verified.metrics.insightCoverage.missing.length)
      issues.push({ code: 'INSIGHT_COVERAGE', message: '仍有必须利用的提炼信息未被片段覆盖' });
    if (
      verified.items.some(
        (item) =>
          item.targetDurationSeconds !==
            verified.settings.fragmentConfigs[item.fragmentType].durationSeconds ||
          effectPromptHardExecutionIssues(effectPromptExecutionIssues(item)).length > 0,
      )
    )
      issues.push({ code: 'EXECUTION_GATE', message: '存在不能直接用于片段渲染的 Prompt' });
    let dimensionConflictCount = 0;
    for (let left = 0; left < verified.items.length; left += 1)
      for (let right = left + 1; right < verified.items.length; right += 1)
        if (dimensionDistance(verified.items[left]!, verified.items[right]!) < 3)
          dimensionConflictCount += 1;
    if (dimensionConflictCount > 0)
      warnings.push({
        code: 'DIMENSION_DISTANCE',
        message: `${dimensionConflictCount} 组 Prompt 的六维差异不足三项，已作为质量建议保留`,
      });
    const softWarningCodes = new Set(
      verified.items.flatMap((item) =>
        effectPromptSoftQualityWarnings(effectPromptExecutionIssues(item)),
      ),
    );
    if (softWarningCodes.size > 0)
      warnings.push({
        code: 'SOFT_QUALITY_WARNING',
        message: `存在 ${softWarningCodes.size} 类非阻塞质量建议，可在后续人工调整`,
      });
    if (
      verified.metrics.semanticDuplicateRate > 0 &&
      verified.metrics.semanticDuplicateRate <= verified.settings.semanticLimit
    )
      warnings.push({ code: 'SEMANTIC_SIMILARITY', message: '存在阈值内的语义相似 Prompt' });
    if (
      verified.metrics.visualOverlapRate > 0 &&
      verified.metrics.visualOverlapRate <= verified.settings.visualLimit
    )
      warnings.push({ code: 'VISUAL_SIMILARITY', message: '存在阈值内的画面要素重合' });
    const run = await this.repository.run(projectId, record.runId);
    const snapshot = run?.inputSnapshot as EffectPromptInputSnapshot | undefined;
    const insight = await this.repository.insightArtifact(
      projectId,
      record.workflowRunId,
      record.productId,
    );
    const settingsNode = await this.repository.settingsNode(
      projectId,
      record.workflowRunId,
      record.productId,
    );
    if (
      !run ||
      run.status !== 'COMPLETED' ||
      !snapshot ||
      !insight ||
      insight.freshness !== 'CURRENT' ||
      insight.availability !== 'AVAILABLE' ||
      insight.id !== snapshot.insightArtifact.id ||
      insight.revision !== snapshot.insightArtifact.revision ||
      insight.contentHash !== snapshot.insightArtifact.contentHash ||
      settingsNode?.executionInputHash !== record.settingsHash
    )
      issues.push({ code: 'STALE_RESULT', message: '上游信息卡或 Prompt 设置已经变化' });
    if (verified.qualityStatus !== 'PASS' && issues.length === 0)
      issues.push({ code: 'QUALITY_REVIEW', message: 'Prompt 批次仍需人工调整' });
    if (issues.length)
      return {
        valid: false,
        issues,
        warnings,
        productId: record.productId,
        artifacts: [],
        allProductsValidated: false,
        validatedAt: new Date().toISOString(),
      };
    const input = await this.artifactInput(record, verified);
    if (!input) throw conflict('Prompt 依赖快照不完整，请重新生成');
    let committed;
    try {
      committed = await this.repository.commitValidatedResult(
        projectId,
        resultId,
        expectedRevision,
        input,
      );
    } catch (error) {
      if (
        error instanceof Error &&
        [
          'WORKING_ARTIFACT_DEPENDENCY_CONFLICT',
          'WORKFLOW_EXECUTION_INPUT_DEPENDENCY_CONFLICT',
          'WORKFLOW_NODE_STATE_DEPENDENCY_CONFLICT',
        ].includes(error.message)
      )
        throw conflict('上游信息卡或 Prompt 设置已经变化，请重新生成');
      throw error;
    }
    if (committed.kind === 'NOT_FOUND') throw notFound('Prompt 结果不存在');
    if (committed.kind === 'REVISION_CONFLICT')
      throw conflict('Prompt 结果已被其他操作更新，请刷新后重试');
    if (committed.kind === 'DEPENDENCY_CONFLICT')
      throw conflict('上游信息卡或 Prompt 设置已经变化，请重新生成');
    if (committed.kind !== 'COMMITTED') throw conflict('当前结果不是最新已完成 Prompt 结果');
    const workspace = await this.workspace(projectId, record.workflowRunId);
    const hasActiveRuns =
      (await this.repository.activeRunCount(projectId, record.workflowRunId)) > 0;
    return {
      valid: true,
      issues: [],
      warnings,
      productId: record.productId,
      artifacts: [committed.artifact],
      allProductsValidated:
        !hasActiveRuns &&
        workspace.products.every((product) => product.commitStatus === 'COMMITTED'),
      validatedAt: new Date().toISOString(),
    };
  }

  async exportResult(projectId: string, resultId: string) {
    await this.projects.get(projectId);
    const record = await this.repository.result(projectId, resultId);
    if (!record) throw notFound('Prompt 结果不存在');
    if (record.schemaVersion !== EFFECT_PROMPT_SCHEMA_VERSION)
      throw conflict('旧版 Prompt 结果不能导出，请执行全量重新生成');
    const draft = parseEffectPromptBatchResult(record.draftResult);
    if (!draft) throw conflict('Prompt 结果结构无效，请重新生成');
    return {
      schemaVersion: EFFECT_PROMPT_SCHEMA_VERSION,
      productId: record.productId,
      resultId: record.id,
      revision: record.revision,
      exportedAt: new Date().toISOString(),
      result: draft,
    };
  }

  async claim(projectId: string, runId: string) {
    const result = await this.repository.claim(projectId, runId);
    if (result.kind === 'NOT_FOUND') throw notFound('Prompt 任务不存在');
    if (result.kind === 'BUSY') throw conflict('Prompt 任务已被其他 Worker 认领');
    if (result.kind === 'TERMINAL' || result.kind === 'ATTEMPTS_EXHAUSTED')
      return { terminal: true as const, runId };
    const checkpoints = result.checkpointStages.flatMap(({ nodeId, metadata }) => {
      if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return [];
      const checkpoint = (metadata as Record<string, unknown>).checkpoint;
      if (!checkpoint || typeof checkpoint !== 'object' || Array.isArray(checkpoint)) return [];
      const value = checkpoint as Record<string, unknown>;
      return value.nodeId === nodeId && typeof value.sourceFingerprint === 'string'
        ? [checkpoint]
        : [];
    });
    return {
      terminal: false as const,
      runId,
      sourceFingerprint: result.run.sourceFingerprint,
      attemptToken: result.attemptToken,
      input: result.input,
      strategyCheckpoints: checkpoints.filter((checkpoint) => {
        const nodeId = (checkpoint as Record<string, unknown>).nodeId;
        return typeof nodeId === 'string' && nodeId.endsWith('_STRATEGY');
      }),
      stageCheckpoints: checkpoints,
    };
  }

  async heartbeat(projectId: string, runId: string, attemptToken: string) {
    if ((await this.repository.heartbeat(projectId, runId, attemptToken)).count !== 1)
      throw conflict('Worker 租约已失效');
    return { accepted: true as const };
  }

  async saveStage(
    projectId: string,
    runId: string,
    attemptToken: string,
    rawNodeId: string,
    input: EffectPromptStageInput,
  ) {
    const node = EFFECT_PROMPT_GRAPH_NODES.find(({ id }) => id === rawNodeId);
    if (!node) throw badRequest('未知的 Prompt 子工作流节点');
    const graphVersion = await this.stageGraphVersion(projectId, runId);
    if (!effectPromptGraphNodeIds(graphVersion).includes(node.id))
      throw badRequest('该节点不属于当前 Prompt 工作流版本');
    if (
      !(await this.repository.saveStage(
        projectId,
        runId,
        attemptToken,
        node.id,
        input,
        stageProgress(node.id, input.status, graphVersion),
      ))
    )
      throw conflict('Worker 租约已失效');
    return { accepted: true as const };
  }

  private async stageGraphVersion(
    projectId: string,
    runId: string,
  ): Promise<EffectPromptGraphVersion> {
    const run = await this.repository.run(projectId, runId);
    if (!run) throw notFound('Prompt 任务不存在');
    return graphVersionOf(run);
  }

  async saveShard(
    projectId: string,
    runId: string,
    attemptToken: string,
    round: number,
    shardIndex: number,
    phase: EffectPromptShardPhase,
    input: EffectPromptShardInput,
  ) {
    if (!EFFECT_PROMPT_SHARD_PHASES.includes(phase)) throw badRequest('分片阶段无效');
    const graphVersion = await this.stageGraphVersion(projectId, runId);
    if (phase === 'BLUEPRINT' && graphVersion !== 'V10_RELATION_COORDINATE_BLUEPRINT')
      throw badRequest('蓝图分片不属于当前 Prompt 工作流版本');
    if (round < 0 || round > EFFECT_PROMPT_LIMITS.maxReplenishmentRounds || shardIndex < 0)
      throw badRequest('分片标识无效');
    if (
      !(await this.repository.saveShard(
        projectId,
        runId,
        attemptToken,
        round,
        shardIndex,
        phase,
        input,
      ))
    )
      throw conflict('Worker 租约已失效');
    return { accepted: true as const };
  }

  async shards(
    projectId: string,
    runId: string,
    attemptToken: string,
    phase?: EffectPromptShardPhase,
  ) {
    if (phase && !EFFECT_PROMPT_SHARD_PHASES.includes(phase)) throw badRequest('分片阶段无效');
    if (phase === 'BLUEPRINT') {
      const graphVersion = await this.stageGraphVersion(projectId, runId);
      if (graphVersion !== 'V10_RELATION_COORDINATE_BLUEPRINT')
        throw badRequest('蓝图分片不属于当前 Prompt 工作流版本');
    }
    const records = await this.repository.shards(projectId, runId, attemptToken, phase);
    if (!records) throw conflict('Worker 租约已失效');
    return {
      runId,
      shards: records.map((record) => ({
        phase: record.phase,
        round: record.round,
        shardIndex: record.shardIndex,
        status: record.status,
        combinationPlan: record.phase === 'PROMPT' ? record.combinationPlan : [],
        items: record.phase === 'PROMPT' ? record.items : [],
        blueprintPlan: record.phase === 'BLUEPRINT' ? record.combinationPlan : [],
        blueprints: record.phase === 'BLUEPRINT' ? record.items : [],
        warnings: publicWarnings(record.warnings),
        errorCode: record.errorCode,
        errorMessage: record.errorMessage,
        updatedAt: record.updatedAt.toISOString(),
      })),
    };
  }

  async complete(
    projectId: string,
    runId: string,
    attemptToken: string,
    input: EffectPromptCompleteInput,
  ) {
    const parsed = parseEffectPromptBatchResult(input.result);
    if (!parsed) throw badRequest('Prompt 批次结果不符合统一结构');
    const result = await this.repository.complete(projectId, runId, attemptToken, parsed);
    if (result.kind === 'NOT_FOUND') throw notFound('Prompt 任务不存在');
    if (result.kind === 'LEASE_CONFLICT') throw conflict('Worker 租约已失效');
    return { promptResultId: result.result.id };
  }

  async fail(
    projectId: string,
    runId: string,
    attemptToken: string,
    input: {
      errorCode: string;
      errorMessage: string;
      retryable: boolean;
      warnings: string[];
      currentNode?: string | null;
    },
  ) {
    const status = await this.repository.fail(projectId, runId, attemptToken, {
      ...input,
      warnings: publicWarnings(input.warnings),
    });
    if (status === 'NOT_FOUND') throw notFound('Prompt 任务不存在');
    if (status === 'LEASE_CONFLICT') throw conflict('Worker 租约已失效');
    return { status };
  }
}
