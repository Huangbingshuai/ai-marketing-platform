import { createHash, randomUUID } from 'node:crypto';

import type {
  EffectPromptDimensions,
  EffectPromptFragmentType,
  EffectPromptInsightField,
  EffectPromptItem,
  EffectPromptOperation,
  EffectPromptPurposeMatchMode,
  EffectPromptRegenerationMode,
  EffectPromptRegenerationReason,
  EffectPromptDimensionKey,
  EffectPromptBatchResult,
  EffectPromptRenderProfile,
  EffectPromptNodeExecution,
  EffectPromptNodeId,
  EffectPromptProductState,
  EffectPromptRun,
  EffectPromptRegenerationPreview,
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
  EFFECT_PROMPT_FRAGMENT_TYPE_LABELS,
  EFFECT_PROMPT_FRAGMENT_TYPES,
  EFFECT_PROMPT_GRAPH_NODES,
  EFFECT_PROMPT_LIMITS,
  EFFECT_PROMPT_MAX_RUN_ATTEMPTS,
  EFFECT_PROMPT_RENDER_CAPABILITIES,
  EFFECT_PROMPT_SEMANTIC_DUPLICATE_RATE_LIMIT,
  EFFECT_PROMPT_SHARD_PHASES,
  effectPromptSettingsNodeId,
  readEffectPromptSettings,
  normalizeEffectPromptSettings,
  effectPromptRunGraphNodeIds,
} from '@ai-marketing/contracts';
import { HttpStatus, Inject, Injectable, Optional } from '@nestjs/common';

import { ApiHttpException } from '../../../common/api-http-exception';
import { STORAGE_PORT, type StoragePort } from '../../../platform/file/storage.port';
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
  defaultEffectPromptRenderProfile,
  effectPromptExactDuplicatePairs,
  effectPromptHardExecutionIssues,
  isEffectPromptItem,
  isEffectPromptSettings,
  parseEffectPromptBatchResult,
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

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

const normalizedSettingsHash = (state: unknown): string | null => {
  const settings = readEffectPromptSettings(state);
  return settings ? workflowStateHash(settings) : null;
};

const isValidVisualStrategyCheckpoint = (
  checkpoint: unknown,
  insightContentHash: string,
): boolean => {
  if (!checkpoint || typeof checkpoint !== 'object' || Array.isArray(checkpoint)) return false;
  const value = checkpoint as Record<string, unknown>;
  if (
    value.nodeId !== 'FACT_VISUAL_STRATEGY_COMPILATION' ||
    value.sourceFingerprint !== insightContentHash ||
    typeof value.allocationHash !== 'string' ||
    !SHA256_PATTERN.test(value.allocationHash) ||
    typeof value.templateHash !== 'string' ||
    !SHA256_PATTERN.test(value.templateHash)
  ) {
    return false;
  }
  if (!value.plan || typeof value.plan !== 'object' || Array.isArray(value.plan)) return false;
  const plan = value.plan as Record<string, unknown>;
  return (
    plan.sourceContentHash === insightContentHash &&
    plan.templateHash === value.templateHash &&
    typeof plan.strategyHash === 'string' &&
    SHA256_PATTERN.test(plan.strategyHash) &&
    Array.isArray(plan.policies) &&
    plan.policies.length > 0
  );
};

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

const currentSnapshot = (record: EffectPromptRunRecord): EffectPromptInputSnapshot | null => {
  const snapshot = record.inputSnapshot as Partial<EffectPromptInputSnapshot> | null;
  return snapshot?.selectionPolicy === 'MMR_CONTENT' && isEffectPromptSettings(snapshot.settings)
    ? (snapshot as EffectPromptInputSnapshot)
    : null;
};

const operationOf = (record: EffectPromptRunRecord): EffectPromptOperation => {
  const snapshot = record.inputSnapshot as Partial<EffectPromptInputSnapshot> | null;
  return snapshot?.operation ?? record.operation;
};

const stageProgress = (
  nodeId: EffectPromptNodeId,
  status: string,
  operation: EffectPromptRun['operation'],
): number => {
  const nodeIds = effectPromptRunGraphNodeIds(operation);
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
  effectPromptRunGraphNodeIds(operationOf(record)).map((id) => {
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

const presentRegenerationPreview = (
  record: EffectPromptRunRecord,
): EffectPromptRegenerationPreview | null => {
  const snapshot = currentSnapshot(record);
  if (snapshot?.operation !== 'ITEM_REGENERATE' || !snapshot.targetItem || !snapshot.baseResultId)
    return null;
  const resultStage = record.stages.find(({ nodeId }) => nodeId === 'RESULT_SAVE');
  const metadata =
    resultStage?.metadata &&
    typeof resultStage.metadata === 'object' &&
    !Array.isArray(resultStage.metadata)
      ? (resultStage.metadata as Record<string, unknown>)
      : null;
  const preview = parseEffectPromptBatchResult(metadata?.regenerationPreviewResult);
  if (!preview || preview.items.length === 0) return null;
  const dimensionLabels = new Map(EFFECT_PROMPT_DIMENSIONS.map(({ key, label }) => [key, label]));
  const candidates = preview.items.slice(0, 3).map((item, index) => {
    const changed = EFFECT_PROMPT_DIMENSIONS.filter(
      ({ key }) => item.dimensions[key].trim() !== snapshot.targetItem!.dimensions[key].trim(),
    ).map(({ key }) => dimensionLabels.get(key) ?? key);
    const highlights = [
      ...(item.productRelevance >= 80 ? ['产品关联清晰'] : []),
      ...(changed.length > 0 ? [`调整了${changed.slice(0, 3).join('、')}`] : []),
      ...(item.primaryPurpose !== snapshot.targetItem!.primaryPurpose
        ? ['推荐用途已重新判断']
        : []),
    ];
    return {
      candidateId: item.id,
      item,
      recommended: index === 0,
      highlights: highlights.length > 0 ? highlights : ['保留原意并优化表达'],
      warnings: item.productRelevance < 65 ? ['产品关联仍需人工确认'] : [],
    };
  });
  const appliedCandidateId =
    typeof metadata?.appliedCandidateId === 'string' ? metadata.appliedCandidateId : null;
  return {
    targetItemId: snapshot.targetItem.id,
    baseResultId: snapshot.baseResultId,
    baseResultRevision: snapshot.baseResultRevision ?? 1,
    candidates,
    canApply:
      record.status === 'COMPLETED' &&
      !record.result &&
      !appliedCandidateId &&
      metadata?.regenerationUndone !== true,
    appliedCandidateId,
  };
};

const presentRun = (record: EffectPromptRunRecord): EffectPromptRun => ({
  id: record.id,
  projectId: record.projectId,
  workflowRunId: record.workflowRunId,
  productId: record.productId,
  operation: operationOf(record),
  targetItemId: record.targetItemId,
  status: record.status,
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
  regenerationPreview: presentRegenerationPreview(record),
  nodes: presentNodes(record),
  createdAt: record.createdAt.toISOString(),
  updatedAt: record.updatedAt.toISOString(),
});

const PROMPT_INSIGHT_FIELD_LABELS: Record<EffectPromptInsightField, string> = {
  PRODUCT_NAME: '产品名称',
  PRODUCT_CATEGORY: '产品品类',
  CORE_SPECIFICATION: '核心规格',
  PRICE_RANGE: '确认价格',
  VISUAL_FEATURES: '视觉特征',
  CORE_SELLING_POINT: '核心卖点',
  SECONDARY_SELLING_POINT: '次要卖点',
  TRUST_BACKING: '信任背书',
  TARGET_AUDIENCE: '目标受众',
  CORE_PAIN_POINT: '核心痛点',
  DECISION_DRIVER: '决策动机',
  MARKETING_GOAL: '营销目标',
  USAGE_SCENARIO: '使用场景',
  PURCHASE_SCENARIO: '购买场景',
  EMOTIONAL_SCENARIO: '情绪场景',
  SOURCE_DURATION: '上游时长',
  ASPECT_RATIO: '画幅',
  RESOLUTION: '分辨率',
  DELIVERY_CHANNELS: '投放渠道',
  DISABLED_ELEMENT: '禁用元素',
  VISUAL_STYLE_BASELINE: '视觉基线',
};

const normalizeSearchText = (value: string): string =>
  value.normalize('NFKC').trim().toLocaleLowerCase('zh-CN');

const searchTokens = (query: string): string[] => [
  ...new Set(
    normalizeSearchText(query)
      .split(/[\s,，、;；/|｜]+/u)
      .filter(Boolean),
  ),
];

const searchable = (item: EffectPromptItem, query: string): boolean => {
  const tokens = searchTokens(query);
  if (!tokens.length) return true;
  const searchableText = normalizeSearchText(
    [
      item.code,
      item.content,
      item.creativeCore,
      item.fragmentType,
      EFFECT_PROMPT_FRAGMENT_TYPE_LABELS[item.fragmentType],
      item.primaryPurpose,
      EFFECT_PROMPT_FRAGMENT_TYPE_LABELS[item.primaryPurpose],
      ...item.compatiblePurposes.flatMap((purpose) => [
        purpose,
        EFFECT_PROMPT_FRAGMENT_TYPE_LABELS[purpose],
      ]),
      `${item.targetDurationSeconds}秒`,
      `${item.targetDurationSeconds} 秒`,
      ...EFFECT_PROMPT_DIMENSIONS.flatMap(({ key, label }) => [label, item.dimensions[key]]),
      ...item.insightBindings.flatMap(({ field, value }) => [
        PROMPT_INSIGHT_FIELD_LABELS[field],
        value,
      ]),
    ].join('\n'),
  );
  return tokens.every((token) => searchableText.includes(token));
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

const itemMatchesPurpose = (
  item: EffectPromptItem,
  purpose?: EffectPromptFragmentType,
  purposeMatch: EffectPromptPurposeMatchMode = 'PRIMARY',
): boolean =>
  !purpose ||
  (item.classificationStatus === 'VERIFIED' &&
    (item.primaryPurpose === purpose ||
      (purposeMatch === 'PRIMARY_OR_COMPATIBLE' && item.compatiblePurposes.includes(purpose))));

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
      if (isEffectPromptItem(value)) {
        unique.set(value.id, value);
        continue;
      }
      const item = unknownRecord(value);
      if (!item) continue;
      const invalidReasons = Array.isArray(item.executionInvalidReasons)
        ? item.executionInvalidReasons.filter(
            (reason): reason is string => typeof reason === 'string',
          )
        : [];
      if (effectPromptHardExecutionIssues(invalidReasons).length > 0) continue;
      const slotId = typeof item.slotId === 'string' ? item.slotId : '';
      const ordinal = typeof item.ordinal === 'number' ? item.ordinal : 0;
      const generatedAt = typeof item.generatedAt === 'string' ? item.generatedAt : '';
      if (!slotId || !Number.isSafeInteger(ordinal) || ordinal < 1 || !generatedAt) continue;
      const dimensions = unknownRecord(item.dimensions);
      const creativeCore =
        typeof item.creativeCore === 'string'
          ? item.creativeCore.trim()
          : typeof dimensions?.narrative === 'string'
            ? dimensions.narrative.trim()
            : '';
      const candidate = {
        id: previewItemId(run.sourceFingerprint, slotId),
        code: `P${String(ordinal).padStart(3, '0')}`,
        origin: 'AI',
        fragmentType: item.fragmentType,
        primaryPurpose: item.fragmentType,
        compatiblePurposes: [item.fragmentType],
        classificationStatus: 'VERIFIED',
        productRelevance: 0,
        targetDurationSeconds: item.targetDurationSeconds,
        creativeCore,
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
  const disabledElements = snapshot.settings.disabledElements ?? [];
  return {
    ...profile,
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
        productRelation: 240,
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

const pendingItemDimensions = (): EffectPromptDimensions => ({
  narrative: '等待 AI 自动补齐',
  scene: '等待 AI 自动补齐',
  persona: '等待 AI 自动补齐',
  productRelation: '等待 AI 自动补齐',
  camera: '等待 AI 自动补齐',
  emotion: '等待 AI 自动补齐',
});

const hasCompleteCreativeStructure = (input: PromptItemMutationInput): boolean =>
  typeof input.creativeCore === 'string' &&
  input.creativeCore.trim().length > 0 &&
  input.dimensions !== undefined &&
  validateDimensions(input.dimensions);

type PromptItemMutationInput = {
  content: string;
  primaryPurpose?: EffectPromptFragmentType;
  creativeCore?: string;
  dimensions?: EffectPromptDimensions;
  targetDurationSeconds: number;
  evaluateAfterSave?: boolean;
  expectedSettingsRevision?: number;
  idempotencyKey?: string;
};

@Injectable()
export class EffectPromptService {
  constructor(
    @Inject(EffectPromptRepository) private readonly repository: EffectPromptRepository,
    @Inject(ProjectService) private readonly projects: ProjectService,
    @Inject(WorkflowWorkingRepository)
    private readonly workingRepository: WorkflowWorkingRepository,
    @Optional() @Inject(STORAGE_PORT) private readonly storage?: StoragePort,
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
          sourceHash: resultRecord.settingsHash,
        },
      ],
    };
  }

  async workspace(projectId: string, workflowRunId: string): Promise<GetEffectPromptWorkspaceData> {
    await this.requireWorkflow(projectId, workflowRunId);
    const products = await this.repository.products(projectId, workflowRunId);
    const states: EffectPromptProductState[] = await Promise.all(
      products.map(async (product) => {
        const latestRunRecord = product.promptRuns[0]
          ? await this.repository.run(projectId, product.promptRuns[0].id)
          : null;
        const runRecord =
          latestRunRecord && currentSnapshot(latestRunRecord) ? latestRunRecord : null;
        const resultRecord =
          latestRunRecord?.result ??
          (await this.repository.latestResult(projectId, workflowRunId, product.id));
        const resultRun =
          resultRecord && resultRecord.runId !== latestRunRecord?.id
            ? await this.repository.run(projectId, resultRecord.runId)
            : latestRunRecord;
        const draft = resultRecord ? parseEffectPromptBatchResult(resultRecord.draftResult) : null;
        const settingsNode = await this.repository.settingsNode(
          projectId,
          workflowRunId,
          product.id,
        );
        const insight = await this.repository.insightArtifact(projectId, workflowRunId, product.id);
        const legacyInsight = unknownRecord(insight?.payload);
        const legacyStyle =
          typeof legacyInsight?.visualStyleBaseline === 'string'
            ? legacyInsight.visualStyleBaseline.trim()
            : '';
        const legacyChannel =
          typeof legacyInsight?.deliveryChannels === 'string'
            ? legacyInsight.deliveryChannels.trim()
            : '';
        const legacyDisabled = Array.isArray(legacyInsight?.disabledElements)
          ? legacyInsight.disabledElements.filter(
              (item): item is string => typeof item === 'string' && item.trim().length > 0,
            )
          : (draft?.renderProfile.sharedConstraints.disabledElements ?? []);
        const settings =
          readEffectPromptSettings(settingsNode?.state) ??
          normalizeEffectPromptSettings({
            targetCount: draft?.settings.targetCount ?? EFFECT_PROMPT_LIMITS.defaultCount,
            defaultDurationSeconds:
              draft?.settings.defaultDurationSeconds ?? EFFECT_PROMPT_LIMITS.defaultDurationSeconds,
            styleMode: legacyStyle ? 'FIXED' : 'AI_AUTO',
            styleTone: legacyStyle || null,
            deliveryChannel: legacyChannel || '抖音',
            disabledElements: legacyDisabled,
          });
        const snapshot = resultRun?.inputSnapshot as EffectPromptInputSnapshot | undefined;
        const stale = Boolean(
          resultRecord &&
          (!insight ||
            insight.freshness !== 'CURRENT' ||
            insight.availability !== 'AVAILABLE' ||
            snapshot?.insightArtifact.id !== insight.id ||
            snapshot.insightArtifact.revision !== insight.revision ||
            snapshot.insightArtifact.contentHash !== insight.contentHash ||
            normalizedSettingsHash(settingsNode?.state) !== resultRecord.settingsHash),
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
          errorMessage:
            resultRecord && !draft
              ? '当前结果结构已停用，请重新生成'
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
      1,
      hash,
      1,
    );
    if (result.conflict) throw conflict('Prompt 批次设置已在其他页面更新，请刷新后重试');
    const latestResult = await this.repository.latestResult(projectId, workflowRunId, productId);
    const currentDraft = latestResult
      ? parseEffectPromptBatchResult(latestResult.draftResult)
      : null;
    if (
      latestResult &&
      currentDraft &&
      currentDraft.settings.targetCount === normalized.targetCount &&
      currentDraft.settings.defaultDurationSeconds === normalized.defaultDurationSeconds &&
      currentDraft.settings.styleMode === normalized.styleMode &&
      currentDraft.settings.styleTone === normalized.styleTone &&
      currentDraft.settings.deliveryChannel === normalized.deliveryChannel &&
      workflowStateHash(currentDraft.settings.disabledElements) !==
        workflowStateHash(normalized.disabledElements)
    ) {
      await this.repository.mutateResult(projectId, latestResult.id, latestResult.revision, {
        kind: 'SETTINGS',
        settings: normalized,
        sharedPrompt: compileEffectPromptSharedPrompt(normalized.disabledElements ?? []),
        settingsHash: hash,
      });
    }
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
      operation: EffectPromptOperation;
      targetItemId?: string;
      targetDurationSeconds?: number;
      regenerationInstruction?: string;
      replacementDimensions?: EffectPromptDimensions;
      regenerationMode?: EffectPromptRegenerationMode;
      regenerationReasons?: EffectPromptRegenerationReason[];
      preservedDimensions?: EffectPromptDimensionKey[];
      expectedSettingsRevision: number;
      expectedResultRevision?: number;
      idempotencyKey: string;
    },
  ): Promise<StartEffectPromptRunData> {
    await this.requireWorkflow(projectId, input.workflowRunId);
    const idempotencyKey = input.idempotencyKey.trim();
    if (!idempotencyKey) throw badRequest('幂等键不能为空');
    if (
      (input.operation === 'BATCH_GENERATE' || input.operation === 'ITEM_EVALUATE') &&
      (input.regenerationInstruction !== undefined ||
        input.targetDurationSeconds !== undefined ||
        input.replacementDimensions !== undefined ||
        input.regenerationMode !== undefined ||
        input.regenerationReasons !== undefined ||
        input.preservedDimensions !== undefined)
    )
      throw badRequest(
        input.operation === 'BATCH_GENERATE'
          ? '批量生成不能携带单条重生成设置'
          : 'AI 自动补齐不能携带内容重生成设置',
      );
    if (
      (input.operation === 'ITEM_REGENERATE' || input.operation === 'ITEM_EVALUATE') &&
      !input.targetItemId
    )
      throw badRequest(
        input.operation === 'ITEM_EVALUATE'
          ? 'AI 自动补齐必须指定 Prompt'
          : '单条重新生成必须指定 Prompt',
      );
    if ((input.regenerationInstruction?.trim().length ?? 0) > 500)
      throw badRequest('修改意见不能超过 500 字');
    if (
      input.targetDurationSeconds !== undefined &&
      (!Number.isInteger(input.targetDurationSeconds) ||
        input.targetDurationSeconds < EFFECT_PROMPT_LIMITS.minDurationSeconds ||
        input.targetDurationSeconds > EFFECT_PROMPT_LIMITS.maxDurationSeconds)
    )
      throw badRequest(
        `片段时长需在 ${EFFECT_PROMPT_LIMITS.minDurationSeconds}～${EFFECT_PROMPT_LIMITS.maxDurationSeconds} 秒之间`,
      );
    if (
      input.operation === 'ITEM_REGENERATE' &&
      input.regenerationMode === 'CUSTOM' &&
      !input.regenerationInstruction?.trim()
    )
      throw badRequest('按修改意见重做时必须填写修改意见');
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
      targetDurationSeconds: input.targetDurationSeconds ?? null,
      regenerationInstruction,
      replacementDimensions,
      regenerationMode:
        input.operation === 'ITEM_REGENERATE'
          ? (input.regenerationMode ?? 'FULL_REGENERATE')
          : null,
      regenerationReasons: [...new Set(input.regenerationReasons ?? [])],
      preservedDimensions: [
        ...new Set(
          input.preservedDimensions ??
            (input.operation === 'ITEM_REGENERATE' &&
            input.regenerationMode &&
            !['FULL_REGENERATE', 'AUTO_DIVERSE', 'NEW_CREATIVE'].includes(input.regenerationMode)
              ? ['productRelation' as const]
              : []),
        ),
      ],
      expectedSettingsRevision: input.expectedSettingsRevision,
      expectedResultRevision: input.expectedResultRevision ?? null,
      idempotencyKey,
    });
    if (result.kind === 'NOT_FOUND') throw notFound('工作流或产品不存在');
    if (result.kind === 'SETTINGS_CONFLICT') throw conflict('Prompt 设置已更新，请刷新后重试');
    if (result.kind === 'INSIGHT_NOT_READY') throw conflict('产品信息卡尚未完成校验');
    if (result.kind === 'RESULT_CONFLICT') throw conflict('Prompt 结果已更新，请刷新后重试');
    if (result.kind === 'ITEM_NOT_FOUND') throw notFound('Prompt 不存在');
    if (result.kind === 'INVALID_DURATION')
      throw badRequest(
        `当前视频模型支持 ${result.minDurationSeconds}～${result.maxDurationSeconds} 秒的片段时长`,
      );
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
    if (!currentSnapshot(record)) throw conflict('Prompt 任务结构已停用，请重新生成');
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
    if (!currentSnapshot(record)) throw conflict('Prompt 任务结构已停用，请重新生成');
    if (!effectPromptRunGraphNodeIds(operationOf(record)).includes(definition.id))
      throw badRequest('该节点不属于 Prompt 工作流');
    return { detail: presentEffectPromptNodeDetail(record, definition.id) };
  }

  async result(
    projectId: string,
    workflowRunId: string,
    productId: string,
    page: number,
    pageSize: number,
    query = '',
    purpose?: EffectPromptFragmentType,
    purposeMatch: EffectPromptPurposeMatchMode = 'PRIMARY',
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
      const sharedPrompt = compileEffectPromptSharedPrompt(
        snapshot.settings.disabledElements ?? [],
      );
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
          (item) => itemMatchesPurpose(item, purpose, purposeMatch) && searchable(item, query),
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
    const draft = parseEffectPromptBatchResult(record.draftResult);
    if (!draft) throw conflict('Prompt 结果结构无效，请重新生成');
    const filtered = draft.items
      .filter((item) => itemMatchesPurpose(item, purpose, purposeMatch) && searchable(item, query))
      .sort(comparePromptItemsForDisplay);
    const offset = (page - 1) * pageSize;
    const summary = {
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
    primaryPurpose?: EffectPromptFragmentType;
    creativeCore?: string;
    dimensions?: EffectPromptDimensions;
    targetDurationSeconds: number;
  }): boolean {
    const hasCreativeCore = input.creativeCore !== undefined;
    const hasDimensions = input.dimensions !== undefined;
    return (
      input.content.trim().length > 0 &&
      input.content.length <= 12_000 &&
      (input.primaryPurpose === undefined ||
        EFFECT_PROMPT_FRAGMENT_TYPES.includes(input.primaryPurpose)) &&
      hasCreativeCore === hasDimensions &&
      (!hasCreativeCore ||
        (input.creativeCore!.trim().length > 0 && input.creativeCore!.length <= 160)) &&
      Number.isInteger(input.targetDurationSeconds) &&
      input.targetDurationSeconds >= EFFECT_PROMPT_LIMITS.minDurationSeconds &&
      input.targetDurationSeconds <= EFFECT_PROMPT_LIMITS.maxDurationSeconds &&
      (!hasDimensions || validateDimensions(input.dimensions!))
    );
  }

  private validatePromptDurationRange(targetDurationSeconds: number): void {
    if (
      !Number.isInteger(targetDurationSeconds) ||
      targetDurationSeconds < EFFECT_PROMPT_LIMITS.minDurationSeconds ||
      targetDurationSeconds > EFFECT_PROMPT_LIMITS.maxDurationSeconds
    )
      throw badRequest(
        `片段时长需在 ${EFFECT_PROMPT_LIMITS.minDurationSeconds}～${EFFECT_PROMPT_LIMITS.maxDurationSeconds} 秒之间`,
      );
  }

  private validateItemDuration(
    result: EffectPromptBatchResult,
    targetDurationSeconds: number,
  ): void {
    const capability = EFFECT_PROMPT_RENDER_CAPABILITIES[result.renderProfile.capabilityKey];
    if (
      targetDurationSeconds < capability.minDurationSeconds ||
      targetDurationSeconds > capability.maxDurationSeconds
    )
      throw badRequest(
        `当前视频模型支持 ${capability.minDurationSeconds}～${capability.maxDurationSeconds} 秒的片段时长`,
      );
  }

  private presentMutation(
    output: Awaited<ReturnType<EffectPromptRepository['mutateResult']>>,
    affectedItemId?: string,
  ): UpdateEffectPromptResultData {
    if (output.kind === 'NOT_FOUND') throw notFound('Prompt 结果不存在');
    if (output.kind === 'REVISION_CONFLICT')
      throw conflict('Prompt 结果已被其他操作更新，请刷新后重试');
    if (output.kind === 'ITEM_NOT_FOUND') throw notFound('Prompt 不存在');
    if (output.kind === 'ITEM_CONFLICT') throw conflict('Prompt 标识冲突');
    if (output.kind === 'INVALID_RESULT') throw conflict('Prompt 结果结构无效，请重新生成');
    const affectedItemIndex = affectedItemId
      ? [...output.draft.items]
          .sort(comparePromptItemsForDisplay)
          .findIndex(({ id }) => id === affectedItemId)
      : -1;
    return {
      resultId: output.result.id,
      productId: output.result.productId,
      revision: output.result.revision,
      result: output.draft,
      savedAt: (output.result.savedAt ?? output.result.updatedAt).toISOString(),
      unchanged: output.kind === 'UNCHANGED',
      ...(affectedItemId ? { affectedItemId } : {}),
      ...(affectedItemIndex >= 0 ? { affectedItemIndex } : {}),
    };
  }

  private async queueSavedItemEvaluation(
    projectId: string,
    workflowRunId: string,
    saved: UpdateEffectPromptResultData,
    itemId: string,
    input: PromptItemMutationInput,
  ): Promise<UpdateEffectPromptResultData> {
    if (!input.evaluateAfterSave) return saved;
    if (!input.expectedSettingsRevision || !input.idempotencyKey?.trim())
      throw badRequest('AI 自动补齐需要当前设置版本和幂等键');
    try {
      const started = await this.start(projectId, saved.productId, {
        workflowRunId,
        operation: 'ITEM_EVALUATE',
        targetItemId: itemId,
        expectedSettingsRevision: input.expectedSettingsRevision,
        expectedResultRevision: saved.revision,
        idempotencyKey: input.idempotencyKey.trim(),
      });
      return { ...saved, evaluationRun: started.run };
    } catch (error) {
      if (!(error instanceof ApiHttpException)) throw error;
      return {
        ...saved,
        evaluationStartError: 'Prompt 已保存，但 AI 自动补齐未能启动，请稍后重试',
      };
    }
  }

  private presentRegenerationMutation(
    output:
      | Awaited<ReturnType<EffectPromptRepository['applyRegenerationCandidate']>>
      | Awaited<ReturnType<EffectPromptRepository['undoRegenerationCandidate']>>,
  ): UpdateEffectPromptResultData {
    if (output.kind === 'NOT_FOUND') throw notFound('Prompt 结果或重新生成任务不存在');
    if (output.kind === 'REVISION_CONFLICT')
      throw conflict('Prompt 结果已被其他操作更新，请刷新后重试');
    if (output.kind === 'PREVIEW_CONFLICT')
      throw conflict('这组备选已经失效，请基于当前 Prompt 重新生成');
    if (output.kind === 'CANDIDATE_NOT_FOUND') throw notFound('重新生成备选不存在');
    if (output.kind === 'ITEM_NOT_FOUND') throw notFound('原 Prompt 不存在');
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

  async applyRegenerationCandidate(
    projectId: string,
    resultId: string,
    runId: string,
    candidateId: string,
    expectedRevision: number,
    idempotencyKey: string,
  ): Promise<UpdateEffectPromptResultData> {
    await this.projects.get(projectId);
    if (!idempotencyKey.trim()) throw badRequest('幂等键不能为空');
    return this.presentRegenerationMutation(
      await this.repository.applyRegenerationCandidate(
        projectId,
        resultId,
        runId,
        candidateId,
        expectedRevision,
        idempotencyKey.trim(),
      ),
    );
  }

  async undoRegenerationCandidate(
    projectId: string,
    resultId: string,
    runId: string,
    expectedRevision: number,
    idempotencyKey: string,
  ): Promise<UpdateEffectPromptResultData> {
    await this.projects.get(projectId);
    if (!idempotencyKey.trim()) throw badRequest('幂等键不能为空');
    return this.presentRegenerationMutation(
      await this.repository.undoRegenerationCandidate(
        projectId,
        resultId,
        runId,
        expectedRevision,
        idempotencyKey.trim(),
      ),
    );
  }

  async addItem(
    projectId: string,
    resultId: string,
    expectedRevision: number,
    input: PromptItemMutationInput,
  ): Promise<UpdateEffectPromptResultData> {
    await this.projects.get(projectId);
    this.validatePromptDurationRange(input.targetDurationSeconds);
    if (!this.validItemInput(input)) throw badRequest('Prompt 正文、片段时长或创意结构不符合要求');
    if (
      input.evaluateAfterSave &&
      (!input.expectedSettingsRevision || !input.idempotencyKey?.trim())
    )
      throw badRequest('AI 自动补齐需要当前设置版本和幂等键');
    const current = await this.repository.result(projectId, resultId);
    if (!current) throw notFound('Prompt 结果不存在');
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
    this.validateItemDuration(parsed, input.targetDurationSeconds);
    const maxCode = parsed.items.reduce((maximum, item) => {
      const number = Number(item.code.replace(/\D+/gu, ''));
      return Number.isFinite(number) ? Math.max(maximum, number) : maximum;
    }, 0);
    const now = new Date().toISOString();
    const dimensions = input.evaluateAfterSave
      ? pendingItemDimensions()
      : input.dimensions
      ? (Object.fromEntries(
          EFFECT_PROMPT_DIMENSIONS.map(({ key }) => [key, input.dimensions![key].trim()]),
        ) as EffectPromptDimensions)
      : pendingItemDimensions();
    const primaryPurpose = input.primaryPurpose ?? 'PRODUCT_DISPLAY';
    const creativeStructureReady = hasCompleteCreativeStructure(input);
    const item: EffectPromptItem = {
      id: randomUUID(),
      code: `P${String(maxCode + 1).padStart(3, '0')}`,
      origin: 'MANUAL',
      fragmentType: primaryPurpose,
      primaryPurpose,
      compatiblePurposes: [primaryPurpose],
      classificationStatus: creativeStructureReady ? 'VERIFIED' : 'PENDING',
      productRelevance: 0,
      targetDurationSeconds: input.targetDurationSeconds,
      creativeCore:
        input.evaluateAfterSave
          ? '等待 AI 自动补齐'
          : input.creativeCore?.trim() || '等待 AI 自动补齐',
      dimensions,
      content: input.content.trim(),
      insightBindings: [],
      reviewIssues: [],
      manualEdited: true,
      createdAt: now,
      updatedAt: now,
    };
    const saved = this.presentMutation(
      await this.repository.mutateResult(projectId, resultId, expectedRevision, {
        kind: 'ADD',
        item,
      }),
      item.id,
    );
    return this.queueSavedItemEvaluation(projectId, current.workflowRunId, saved, item.id, input);
  }

  async updateItem(
    projectId: string,
    resultId: string,
    itemId: string,
    expectedRevision: number,
    input: PromptItemMutationInput,
  ): Promise<UpdateEffectPromptResultData> {
    await this.projects.get(projectId);
    this.validatePromptDurationRange(input.targetDurationSeconds);
    if (!this.validItemInput(input)) throw badRequest('Prompt 正文、片段时长或创意结构不符合要求');
    if (
      input.evaluateAfterSave &&
      (!input.expectedSettingsRevision || !input.idempotencyKey?.trim())
    )
      throw badRequest('AI 自动补齐需要当前设置版本和幂等键');
    const current = await this.repository.result(projectId, resultId);
    if (!current) throw notFound('Prompt 结果不存在');
    const parsed = parseEffectPromptBatchResult(current.draftResult);
    if (!parsed) throw conflict('Prompt 结果结构无效，请重新生成');
    this.validateItemDuration(parsed, input.targetDurationSeconds);
    const currentItem = parsed.items.find((item) => item.id === itemId);
    if (!currentItem) throw notFound('Prompt 不存在');
    const primaryPurpose = input.primaryPurpose ?? currentItem.primaryPurpose;
    const compatiblePurposes = [
      primaryPurpose,
      ...currentItem.compatiblePurposes.filter((purpose) => purpose !== primaryPurpose),
    ];
    const dimensions = input.evaluateAfterSave
      ? pendingItemDimensions()
      : input.dimensions
      ? (Object.fromEntries(
          EFFECT_PROMPT_DIMENSIONS.map(({ key }) => [key, input.dimensions![key].trim()]),
        ) as EffectPromptDimensions)
      : currentItem.dimensions;
    const creativeStructureReady = hasCompleteCreativeStructure(input);
    const saved = this.presentMutation(
      await this.repository.mutateResult(projectId, resultId, expectedRevision, {
        kind: 'UPDATE',
        itemId,
        item: {
          content: input.content.trim(),
          fragmentType: primaryPurpose,
          primaryPurpose,
          compatiblePurposes,
          classificationStatus:
            input.evaluateAfterSave
              ? 'PENDING'
              : creativeStructureReady
                ? 'VERIFIED'
                : currentItem.classificationStatus,
          productRelevance: 0,
          targetDurationSeconds: input.targetDurationSeconds,
          creativeCore:
            input.evaluateAfterSave
              ? '等待 AI 自动补齐'
              : input.creativeCore?.trim() || currentItem.creativeCore,
          dimensions,
          reviewIssues: [],
        },
      }),
      itemId,
    );
    return this.queueSavedItemEvaluation(projectId, current.workflowRunId, saved, itemId, input);
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
    if (verified.items.length !== verified.settings.targetCount)
      issues.push({ code: 'COUNT_MISMATCH', message: 'Prompt 数量尚未达到目标数量' });
    if (effectPromptExactDuplicatePairs(verified.items) > 0)
      issues.push({ code: 'EXACT_DUPLICATE', message: '存在正文完全重复的 Prompt' });
    if (verified.items.some((item) => item.classificationStatus === 'PENDING'))
      issues.push({ code: 'CLASSIFICATION_PENDING', message: '仍有 Prompt 尚未补齐创意信息' });
    if (verified.items.some((item) => item.classificationStatus === 'NEEDS_REVISION'))
      issues.push({
        code: 'ITEM_NEEDS_REVISION',
        message: '仍有 Prompt 存在事实或结构问题，请修改后重新生成创意信息',
      });
    if (
      verified.metrics.semanticEvaluation.status === 'VERIFIED' &&
      verified.metrics.semanticEvaluation.duplicateRate !== null &&
      verified.metrics.semanticEvaluation.duplicateRate >=
        EFFECT_PROMPT_SEMANTIC_DUPLICATE_RATE_LIMIT
    )
      warnings.push({
        code: 'SEMANTIC_DIVERSITY_CAN_BE_IMPROVED',
        message: `语义近似内容达到 ${verified.metrics.semanticEvaluation.duplicateRate}%，可继续优化但不阻止提交`,
      });
    if (
      verified.items.some(
        (item) => item.targetDurationSeconds !== verified.settings.defaultDurationSeconds,
      )
    )
      issues.push({ code: 'DURATION_MISMATCH', message: '存在未使用当前统一时长的 Prompt' });
    for (const issue of verified.metrics.hardIssueCounts.filter(({ count }) => count > 0))
      if (!issues.some(({ code }) => code === issue.code))
        issues.push({ code: issue.code, message: `仍有 ${issue.count} 条 Prompt 未满足提交条件` });
    if (verified.metrics.insightCoverage.missing.length > 0)
      warnings.push({
        code: 'INSIGHT_COVERAGE_INCOMPLETE',
        message: `仍有 ${verified.metrics.insightCoverage.missing.length} 项提炼信息未覆盖，可继续优化但不阻止提交`,
      });
    for (const warning of verified.metrics.warningCounts.filter(({ count }) => count > 0))
      warnings.push({
        code: warning.code,
        message: `${warning.count} 条 Prompt 存在可继续优化的质量建议`,
      });
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
      normalizedSettingsHash(settingsNode?.state) !== record.settingsHash
    )
      issues.push({ code: 'STALE_RESULT', message: '上游信息卡或 Prompt 设置已经变化' });
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
    const draft = parseEffectPromptBatchResult(record.draftResult);
    if (!draft) throw conflict('Prompt 结果结构无效，请重新生成');
    return {
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
    const checkpointCandidates = result.checkpointStages.flatMap(({ nodeId, metadata }) => {
      if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return [];
      const checkpoint = (metadata as Record<string, unknown>).checkpoint;
      if (!checkpoint || typeof checkpoint !== 'object' || Array.isArray(checkpoint)) return [];
      const value = checkpoint as Record<string, unknown>;
      return value.nodeId === nodeId && typeof value.sourceFingerprint === 'string'
        ? [checkpoint]
        : [];
    });
    const insightContentHash = result.input?.insightArtifact?.contentHash ?? '';
    const visualStrategySourceHash =
      result.input?.factVisualStrategySourceHash ?? insightContentHash;
    const currentRunVisualStrategy = checkpointCandidates.find((checkpoint) =>
      isValidVisualStrategyCheckpoint(checkpoint, visualStrategySourceHash),
    );
    const checkpoints = [
      ...checkpointCandidates.filter(
        (checkpoint) =>
          (checkpoint as Record<string, unknown>).nodeId !== 'FACT_VISUAL_STRATEGY_COMPILATION',
      ),
      ...(currentRunVisualStrategy ? [currentRunVisualStrategy] : []),
    ];
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
    await this.stageOperation(projectId, runId);
    if ((await this.repository.heartbeat(projectId, runId, attemptToken)).count !== 1)
      throw conflict('Worker 租约已失效');
    return { accepted: true as const };
  }

  async productImageSource(
    projectId: string,
    runId: string,
    fileObjectId: string,
    attemptToken: string,
  ) {
    const source = await this.repository.productImageSource(
      projectId,
      runId,
      fileObjectId,
      attemptToken,
    );
    if (!source || !this.storage) throw notFound('Prompt 商品图片不存在或 Worker 租约已失效');
    return {
      reference: source.reference,
      ...(await this.storage.open(source.fileObject.storageKey)),
    };
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
    const operation = await this.stageOperation(projectId, runId);
    if (!effectPromptRunGraphNodeIds(operation).includes(node.id))
      throw badRequest('该节点不属于 Prompt 工作流');
    if (
      !(await this.repository.saveStage(
        projectId,
        runId,
        attemptToken,
        node.id,
        input,
        stageProgress(node.id, input.status, operation),
      ))
    )
      throw conflict('Worker 租约已失效');
    return { accepted: true as const };
  }

  private async stageOperation(
    projectId: string,
    runId: string,
  ): Promise<EffectPromptRun['operation']> {
    const run = await this.repository.run(projectId, runId);
    if (!run) throw notFound('Prompt 任务不存在');
    if (!currentSnapshot(run)) throw conflict('Prompt 任务结构已停用，请重新生成');
    return operationOf(run);
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
    await this.stageOperation(projectId, runId);
    const maxRound = 4;
    if (round < 0 || round > maxRound || shardIndex < 0) throw badRequest('分片标识无效');
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
    await this.stageOperation(projectId, runId);
    const records = await this.repository.shards(projectId, runId, attemptToken, phase);
    if (!records) throw conflict('Worker 租约已失效');
    return {
      runId,
      shards: records.map((record) => {
        const publicPhase: EffectPromptShardPhase =
          record.phase === 'BLUEPRINT' ? 'CREATIVE' : 'CLASSIFICATION';
        return {
          phase: publicPhase,
          round: record.round,
          shardIndex: record.shardIndex,
          status: record.status,
          creativePlan: publicPhase === 'CREATIVE' ? record.combinationPlan : [],
          creativeItems: publicPhase === 'CREATIVE' ? record.items : [],
          classificationPlan: publicPhase === 'CLASSIFICATION' ? record.combinationPlan : [],
          evaluations: publicPhase === 'CLASSIFICATION' ? record.items : [],
          warnings: publicWarnings(record.warnings),
          errorCode: record.errorCode,
          errorMessage: record.errorMessage,
          updatedAt: record.updatedAt.toISOString(),
        };
      }),
    };
  }

  async complete(
    projectId: string,
    runId: string,
    attemptToken: string,
    input: EffectPromptCompleteInput,
  ) {
    if (
      input.executionMode === 'MOCK' &&
      process.env.EFFECT_PROMPT_ALLOW_MOCK_COMPLETION?.trim().toLocaleLowerCase('en-US') !== 'true'
    )
      throw badRequest('Mock Prompt 结果不能写入普通任务');
    const parsed = parseEffectPromptBatchResult(input.result);
    if (!parsed) throw badRequest('Prompt 批次结果不符合统一结构');
    // Worker completion persists a domain draft rather than confirming the
    // WorkingArtifact. An exhausted supplement run may legitimately keep a
    // shorter NEEDS_REVIEW result for inspection; explicit validation still
    // enforces exact count, structural safety and freshness before commit.
    if (parsed.items.some((item) => item.classificationStatus !== 'VERIFIED'))
      throw badRequest('Prompt 批次仍有内容尚未补齐创意信息');
    await this.stageOperation(projectId, runId);
    const result = await this.repository.complete(projectId, runId, attemptToken, parsed);
    if (result.kind === 'NOT_FOUND') throw notFound('Prompt 任务不存在');
    if (result.kind === 'LEASE_CONFLICT') throw conflict('Worker 租约已失效');
    if (result.kind === 'INVALID_SEMANTIC_AUDIT')
      throw badRequest('Prompt 语义评估与当前正文不一致，请重新执行评估');
    if (result.kind === 'INVALID_REGENERATION_PREVIEW')
      throw badRequest('单条 Prompt 备选结果必须正好包含 3 个已评估方案');
    return { promptResultId: result.result?.id ?? null };
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
