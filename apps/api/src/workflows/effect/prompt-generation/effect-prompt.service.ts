import { randomUUID } from 'node:crypto';

import type {
  EffectPromptBatchResult,
  EffectPromptDimensions,
  EffectPromptFragmentType,
  EffectPromptItem,
  EffectPromptNodeExecution,
  EffectPromptNodeId,
  EffectPromptProductState,
  EffectPromptRun,
  GetEffectPromptNodeDetailData,
  GetEffectPromptResultData,
  GetEffectPromptRunData,
  GetEffectPromptWorkspaceData,
  StartEffectPromptRunData,
  UpdateEffectPromptResultData,
  ValidateEffectPromptResultData,
} from '@ai-marketing/contracts';
import {
  DEFAULT_EFFECT_PROMPT_SETTINGS,
  EFFECT_PROMPT_DIMENSIONS,
  EFFECT_PROMPT_FRAGMENT_TYPES,
  EFFECT_PROMPT_GRAPH_NODES,
  EFFECT_PROMPT_LIMITS,
  EFFECT_PROMPT_SCHEMA_VERSION,
  effectPromptSettingsNodeId,
  normalizeEffectPromptSettings,
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
import { EffectPromptRepository, type EffectPromptRunRecord } from './effect-prompt.repository';
import {
  dimensionDistance,
  effectPromptExecutionIssues,
  isEffectPromptSettings,
  parseEffectPromptBatchResult,
  recomputePromptQuality,
} from './effect-prompt.quality';
import type {
  EffectPromptCompleteInput,
  EffectPromptShardInput,
  EffectPromptStageInput,
  EffectPromptInputSnapshot,
} from './effect-prompt.types';
import { projectEffectPromptNodeMetadata } from './effect-prompt-node-detail';

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

const stageProgress = (nodeId: EffectPromptNodeId, status: string): number => {
  const index = EFFECT_PROMPT_GRAPH_NODES.findIndex(({ id }) => id === nodeId);
  const base = Math.round((Math.max(0, index) / EFFECT_PROMPT_GRAPH_NODES.length) * 95);
  return status === 'SUCCEEDED' || status === 'PARTIAL' || status === 'SKIPPED'
    ? Math.min(99, base + Math.round(95 / EFFECT_PROMPT_GRAPH_NODES.length))
    : Math.max(1, base);
};

const presentNodes = (record: EffectPromptRunRecord): EffectPromptNodeExecution[] =>
  EFFECT_PROMPT_GRAPH_NODES.map(({ id }) => {
    const stage = record.stages.find(({ nodeId }) => nodeId === id);
    return {
      nodeId: id,
      status: stage?.status ?? 'PENDING',
      summary: stage?.summary ?? '',
      warnings: publicWarnings(stage?.warnings),
      errorMessage: stage?.errorMessage ?? null,
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
  progress: record.progress,
  currentNode:
    record.currentNode === 'COMPLETED'
      ? 'COMPLETED'
      : (EFFECT_PROMPT_GRAPH_NODES.find(({ id }) => id === record.currentNode)?.id ?? null),
  warnings: publicWarnings(record.warnings),
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
      name: `产品 ${resultRecord.productId} 差异化 Prompt 批次`,
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
        const draft = resultRecord ? parseEffectPromptBatchResult(resultRecord.draftResult) : null;
        const settingsNode = await this.repository.settingsNode(
          projectId,
          workflowRunId,
          product.id,
        );
        const settings = isEffectPromptSettings(settingsNode?.state)
          ? normalizeEffectPromptSettings(settingsNode.state)
          : DEFAULT_EFFECT_PROMPT_SETTINGS;
        const insight = await this.repository.insightArtifact(projectId, workflowRunId, product.id);
        const snapshot = resultRun?.inputSnapshot as EffectPromptInputSnapshot | undefined;
        const stale = Boolean(
          resultRecord &&
          (!insight ||
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
          : stale
            ? 'STALE'
            : runRecord.status === 'RUNNING'
              ? 'PROCESSING'
              : runRecord.status;
        return {
          projectId,
          workflowRunId,
          productId: product.id,
          status,
          runId: runRecord?.id ?? null,
          resultId: resultRecord?.id ?? null,
          resultRevision: resultRecord?.revision ?? null,
          settings,
          settingsRevision: settingsNode?.revision ?? null,
          metrics: draft?.metrics ?? null,
          qualityStatus: draft?.qualityStatus ?? null,
          commitStatus,
          workingArtifactRevision: artifact?.revision ?? null,
          progress: runRecord?.progress ?? 0,
          currentNode: runRecord?.currentNode ?? null,
          errorMessage: runRecord?.errorMessage ?? null,
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
      expectedSettingsRevision: number;
      expectedResultRevision?: number;
      idempotencyKey: string;
    },
  ): Promise<StartEffectPromptRunData> {
    await this.requireWorkflow(projectId, input.workflowRunId);
    const idempotencyKey = input.idempotencyKey.trim();
    if (!idempotencyKey) throw badRequest('幂等键不能为空');
    if (input.operation === 'ITEM_REGENERATE' && !input.targetItemId)
      throw badRequest('单条重新生成必须指定 Prompt');
    const result = await this.repository.startRun(projectId, input.workflowRunId, productId, {
      operation: input.operation,
      targetItemId: input.targetItemId ?? null,
      expectedSettingsRevision: input.expectedSettingsRevision,
      expectedResultRevision: input.expectedResultRevision ?? null,
      idempotencyKey,
    });
    if (result.kind === 'NOT_FOUND') throw notFound('工作流或产品不存在');
    if (result.kind === 'SETTINGS_CONFLICT') throw conflict('Prompt 设置已更新，请刷新后重试');
    if (result.kind === 'INSIGHT_NOT_READY') throw conflict('产品信息卡尚未完成校验');
    if (result.kind === 'RESULT_CONFLICT') throw conflict('Prompt 结果已更新，请刷新后重试');
    if (result.kind === 'ITEM_NOT_FOUND') throw notFound('Prompt 不存在');
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
    const record = await this.repository.run(projectId, runId);
    if (!record) throw notFound('Prompt 任务不存在');
    const stage = record.stages.find(({ nodeId }) => nodeId === definition.id);
    const fields = projectEffectPromptNodeMetadata(definition.id, stage?.metadata);
    return {
      detail: {
        nodeId: definition.id,
        status: stage?.status ?? 'PENDING',
        summary: stage?.summary ?? '',
        fields,
        warnings: publicWarnings(stage?.warnings),
        errorMessage: stage?.errorMessage ?? null,
        updatedAt: stage?.updatedAt.toISOString() ?? null,
      },
    };
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
    if (!record) throw notFound('Prompt 结果不存在');
    if (record.schemaVersion !== EFFECT_PROMPT_SCHEMA_VERSION)
      throw conflict('旧版 Prompt 结果不能继续使用，请执行全量重新生成');
    const draft = parseEffectPromptBatchResult(record.draftResult);
    if (!draft) throw conflict('Prompt 结果结构无效，请重新生成');
    const filtered = draft.items.filter(
      (item) => (!fragmentType || item.fragmentType === fragmentType) && searchable(item, query),
    );
    const offset = (page - 1) * pageSize;
    const summary = {
      schemaVersion: draft.schemaVersion,
      settings: draft.settings,
      metrics: draft.metrics,
      qualityStatus: draft.qualityStatus,
    };
    return {
      projectId,
      productId,
      resultId: record.id,
      revision: record.revision,
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
    targetDurationSeconds: number;
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
      Number.isInteger(input.targetDurationSeconds) &&
      input.targetDurationSeconds >= EFFECT_PROMPT_LIMITS.minDurationSeconds &&
      input.targetDurationSeconds <= EFFECT_PROMPT_LIMITS.maxDurationSeconds &&
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
      targetDurationSeconds: number;
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
      targetDurationSeconds: input.targetDurationSeconds,
      dimensions: Object.fromEntries(
        EFFECT_PROMPT_DIMENSIONS.map(({ key }) => [key, input.dimensions[key].trim()]),
      ) as EffectPromptDimensions,
      content: input.content.trim(),
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
      targetDurationSeconds: number;
      dimensions: EffectPromptDimensions;
    },
  ): Promise<UpdateEffectPromptResultData> {
    await this.projects.get(projectId);
    if (!this.validItemInput(input)) throw badRequest('Prompt 内容或六维标签不完整');
    const current = await this.repository.result(projectId, resultId);
    if (!current) throw notFound('Prompt 结果不存在');
    if (current.schemaVersion !== EFFECT_PROMPT_SCHEMA_VERSION)
      throw conflict('旧版 Prompt 结果不能编辑，请执行全量重新生成');
    return this.presentMutation(
      await this.repository.mutateResult(projectId, resultId, expectedRevision, {
        kind: 'UPDATE',
        itemId,
        item: {
          content: input.content.trim(),
          fragmentType: input.fragmentType,
          materialTags: input.materialTags.map((tag) => tag.normalize('NFC').trim()),
          targetDurationSeconds: input.targetDurationSeconds,
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
    const verified = recomputePromptQuality(draft.items, draft.settings, draft.metrics);
    const issues: Array<{ code: string; message: string }> = [];
    if (verified.items.length !== verified.settings.count)
      issues.push({ code: 'COUNT_MISMATCH', message: 'Prompt 数量尚未达到目标数量' });
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
    if (
      verified.items.some(
        (item) =>
          item.targetDurationSeconds !== verified.settings.durationSeconds ||
          effectPromptExecutionIssues(item).length > 0,
      )
    )
      issues.push({ code: 'EXECUTION_GATE', message: '存在不能直接用于片段渲染的 Prompt' });
    outer: for (let left = 0; left < verified.items.length; left += 1)
      for (let right = left + 1; right < verified.items.length; right += 1)
        if (dimensionDistance(verified.items[left]!, verified.items[right]!) < 3) {
          issues.push({ code: 'DIMENSION_DISTANCE', message: '存在六维差异不足三项的 Prompt' });
          break outer;
        }
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
    return {
      terminal: false as const,
      runId,
      sourceFingerprint: result.run.sourceFingerprint,
      attemptToken: result.attemptToken,
      input: result.input,
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
    if (
      !(await this.repository.saveStage(
        projectId,
        runId,
        attemptToken,
        node.id,
        input,
        stageProgress(node.id, input.status),
      ))
    )
      throw conflict('Worker 租约已失效');
    return { accepted: true as const };
  }

  async saveShard(
    projectId: string,
    runId: string,
    attemptToken: string,
    round: number,
    shardIndex: number,
    input: EffectPromptShardInput,
  ) {
    if (round < 0 || round > EFFECT_PROMPT_LIMITS.maxReplenishmentRounds || shardIndex < 0)
      throw badRequest('分片标识无效');
    if (
      !(await this.repository.saveShard(projectId, runId, attemptToken, round, shardIndex, input))
    )
      throw conflict('Worker 租约已失效');
    return { accepted: true as const };
  }

  async shards(projectId: string, runId: string, attemptToken: string) {
    const records = await this.repository.shards(projectId, runId, attemptToken);
    if (!records) throw conflict('Worker 租约已失效');
    return {
      runId,
      shards: records.map((record) => ({
        round: record.round,
        shardIndex: record.shardIndex,
        status: record.status,
        combinationPlan: record.combinationPlan,
        items: record.items,
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
    input: { errorCode: string; errorMessage: string; retryable: boolean; warnings: string[] },
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
