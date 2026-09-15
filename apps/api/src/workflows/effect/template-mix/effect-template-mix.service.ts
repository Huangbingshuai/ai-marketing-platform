import type {
  EffectTemplateMixAiClassification,
  EffectTemplateMixClassificationPool,
  EffectTemplateMixAiRun,
  EffectTemplateMixAiSelection,
  EffectTemplateMixAiTrim,
  EffectTemplateMixDraft,
  EffectTemplateMixMaterial,
  EffectTemplateMixRole,
  EffectTemplateMixSlot,
  EffectTemplateMixVariant,
  EffectTemplateMixWorkspace,
  EffectTemplateMixWorkspaceData,
  ValidateEffectTemplateMixData,
  WorkingArtifact,
} from '@ai-marketing/contracts';
import { HttpStatus, Inject, Injectable, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import { ApiHttpException } from '../../../common/api-http-exception';
import { WorkflowWorkingService } from '../../../platform/workflow/workflow-working.service';
import { workflowStateHash } from '../../../platform/workflow/workflow-state-hash';
import { STORAGE_PORT, type StoragePort } from '../../../platform/file/storage.port';
import type { WorkingArtifactUpsertInput } from '../../../platform/workflow/workflow-working.repository';
import {
  applyVariantToTemplate,
  composeAlgorithmicVariants,
  createVariant,
  fillVariant,
  maximumWeightedAiSelection,
  maximumWeightedAiSelectionBatch,
} from './effect-template-mix.domain';
import { EffectTemplateMixAiRepository } from './effect-template-mix-ai.repository';
import type { EffectTemplateMixAiSnapshot } from './effect-template-mix-ai.types';

const object = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const draftOf = (value: unknown): EffectTemplateMixDraft => {
  const draft = object(value);
  const templates = Array.isArray(draft?.templates) ? draft.templates : null;
  const valid =
    draft?.schemaVersion === 1 &&
    typeof draft.activeTemplateId === 'string' &&
    templates !== null &&
    templates.length <= 50 &&
    new Set(templates.map((entry) => object(entry)?.id)).size === templates.length &&
    templates.every((rawEntry) => {
      const entry = object(rawEntry);
      const workspace = object(entry?.workspace);
      const template = object(workspace?.template);
      return (
        typeof entry?.id === 'string' &&
        entry.id.length > 0 &&
        Number.isInteger(workspace?.editVersion) &&
        typeof template?.name === 'string' &&
        Number.isInteger(template.editVersion) &&
        Array.isArray(template.slots) &&
        Array.isArray(workspace?.variants) &&
        workspace.variants.length <= 100 &&
        workspace.variants.every((rawVariant) => {
          const variant = object(rawVariant);
          return (
            typeof variant?.id === 'string' &&
            Array.isArray(variant.slots) &&
            object(variant.bindings) !== null &&
            object(variant.bindingRevisions) !== null &&
            object(variant.offsets) !== null &&
            Array.isArray(variant.manualSlotIds) &&
            Array.isArray(variant.conflictSlotIds) &&
            Array.isArray(variant.captions)
          );
        })
      );
    });
  if (!valid) {
    throw new ApiHttpException(
      '混剪草稿版本无效，请刷新后重试',
      HttpStatus.BAD_REQUEST,
      'VALIDATION_ERROR',
    );
  }
  return value as EffectTemplateMixDraft;
};

const emptyDraft = (): EffectTemplateMixDraft => ({
  schemaVersion: 1,
  templates: [],
  activeTemplateId: '',
});

const slotsValid = (slots: EffectTemplateMixSlot[]): boolean =>
  slots.length > 0 &&
  slots.length <= 30 &&
  new Set(slots.map(({ id }) => id)).size === slots.length &&
  slots.every(
    ({ id, label, duration }) =>
      typeof id === 'string' &&
      typeof label === 'string' &&
      label.trim().length > 0 &&
      label.length <= 80 &&
      Number.isFinite(duration) &&
      duration >= 0.1 &&
      duration <= 120,
  );

const AI_MIX_ROLES = [
  'HOOK',
  'PAIN_POINT',
  'PRODUCT',
  'SELLING_POINT',
  'TRANSFORMATION',
  'END',
] as const;

const classificationsValid = (
  snapshot: EffectTemplateMixAiSnapshot,
  classifications: EffectTemplateMixAiClassification[],
  requireComplete: boolean,
): boolean => {
  const expectedIds = new Set(snapshot.materials.map(({ id }) => id));
  const actualIds = classifications.map(({ materialId }) => materialId);
  return (
    classifications.length > 0 &&
    (!requireComplete || classifications.length === expectedIds.size) &&
    new Set(actualIds).size === classifications.length &&
    classifications.every(
      (item) =>
        expectedIds.has(item.materialId) &&
        AI_MIX_ROLES.every((role) => {
          const score = item.scores?.[role];
          const reason = item.reasons?.[role];
          return (
            Number.isFinite(score) &&
            score >= 0 &&
            score <= 1 &&
            (reason === undefined ||
              (typeof reason === 'string' && reason.trim().length > 0 && reason.length <= 500))
          );
        }),
    )
  );
};

const aiResultKey = (value: { variantIndex?: number; slotId: string }): string =>
  `${value.variantIndex ?? 0}:${value.slotId}`;

const classificationSlotSignature = (
  slots: Array<{ role: EffectTemplateMixRole; label: string }>,
): string => workflowStateHash(slots.map(({ role, label }) => ({ role, label })));

const trimsValid = (
  snapshot: EffectTemplateMixAiSnapshot,
  selections: EffectTemplateMixAiSelection[],
  trims: EffectTemplateMixAiTrim[],
  requireComplete: boolean,
): boolean => {
  const selectionByKey = new Map(selections.map((item) => [aiResultKey(item), item]));
  const keys = trims.map(aiResultKey);
  return (
    trims.length > 0 &&
    (!requireComplete || trims.length === selections.length) &&
    new Set(keys).size === trims.length &&
    trims.every((trim) => {
      const selection = selectionByKey.get(aiResultKey(trim));
      const material = snapshot.materials.find(({ id }) => id === selection?.materialId);
      return Boolean(
        selection &&
        material &&
        trim.materialId === selection.materialId &&
        Number.isFinite(trim.trimStartSeconds) &&
        trim.trimStartSeconds >= 0 &&
        trim.trimStartSeconds + selection.duration <= material.duration + 0.001 &&
        trim.trimReason?.trim(),
      );
    })
  );
};

const payload = (artifact: WorkingArtifact): Record<string, unknown> =>
  object(artifact.payload) ?? {};
const clipDuration = (artifact: WorkingArtifact): number =>
  Number(payload(artifact).durationSeconds ?? 0);
const clipHash = (artifact: WorkingArtifact): string => String(payload(artifact).contentHash ?? '');
const materialPurpose = (value: unknown): EffectTemplateMixMaterial['purpose'] | null => {
  if (
    value === 'HOOK' ||
    value === 'EFFECT' ||
    value === 'PRODUCT_DISPLAY' ||
    value === 'END_CONVERSION'
  ) {
    return value;
  }
  return null;
};

const materialFrom = (artifact: WorkingArtifact): EffectTemplateMixMaterial | null => {
  if (
    artifact.nodeId !== 'SEGMENT_RENDER' ||
    !artifact.artifactKey.startsWith('render-clip:') ||
    artifact.kind !== 'FILE' ||
    !artifact.contentUrl
  ) {
    return null;
  }
  const data = payload(artifact);
  const duration = Number(data.durationSeconds);
  if (!Number.isFinite(duration) || duration <= 0) return null;
  const primaryPurpose = materialPurpose(data.primaryPurpose);
  if (!primaryPurpose) return null;
  const compatiblePurposes = Array.isArray(data.compatiblePurposes)
    ? [
        ...new Set(
          data.compatiblePurposes
            .map(materialPurpose)
            .filter((item): item is EffectTemplateMixMaterial['purpose'] => Boolean(item)),
        ),
      ]
    : [];
  return {
    id: artifact.id,
    artifactId: artifact.id,
    artifactKey: artifact.artifactKey,
    artifactRevision: artifact.revision,
    fileObjectId: typeof data.fileObjectId === 'string' ? data.fileObjectId : '',
    contentHash: typeof data.contentHash === 'string' ? data.contentHash : '',
    contentUrl: artifact.contentUrl,
    code: typeof data.renderCode === 'string' ? data.renderCode : artifact.name,
    name: artifact.name.replace(/\s+视频片段$/u, ''),
    duration,
    purpose: primaryPurpose,
    compatiblePurposes,
    ratio: typeof data.ratio === 'string' ? data.ratio : '',
    resolution: typeof data.resolution === 'string' ? data.resolution : '',
    available: artifact.availability === 'AVAILABLE' && artifact.freshness === 'CURRENT',
  };
};

const toAiRun = (run: {
  id: string;
  templateId: string;
  targetVariantId: string | null;
  outputVariantId: string | null;
  status: EffectTemplateMixAiRun['status'];
  stage: EffectTemplateMixAiRun['stage'];
  progress: number;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
}): EffectTemplateMixAiRun => ({
  id: run.id,
  templateId: run.templateId,
  targetVariantId: run.targetVariantId,
  outputVariantId: run.outputVariantId,
  status: run.status,
  stage: run.stage,
  progress: run.progress,
  errorCode: run.errorCode,
  errorMessage: run.errorMessage,
  createdAt: run.createdAt.toISOString(),
  updatedAt: run.updatedAt.toISOString(),
});

type EffectTemplateMixAiRunRecord = Parameters<typeof toAiRun>[0] & {
  templateEditVersion: number;
  inputSnapshot: unknown;
  classificationResult: unknown;
};
type EffectTemplateMixClassificationSource = {
  id: string;
  revision: number;
  contentHash: string;
};

@Injectable()
export class EffectTemplateMixService {
  constructor(
    @Inject(WorkflowWorkingService)
    private readonly working: WorkflowWorkingService,
    @Optional()
    @Inject(EffectTemplateMixAiRepository)
    private readonly aiRuns?: EffectTemplateMixAiRepository,
    @Optional() @Inject(STORAGE_PORT) private readonly storage?: StoragePort,
  ) {}

  async workspace(
    projectId: string,
    workflowRunId: string,
  ): Promise<EffectTemplateMixWorkspaceData> {
    const [nodeState, artifactData, aiRuns, classificationSources] = await Promise.all([
      this.working.getNodeStateOrNull(projectId, workflowRunId, 'TEMPLATE_MIX'),
      this.working.listArtifacts(projectId, { workflowRunId }),
      this.aiRuns?.listRecent(projectId, workflowRunId) ?? Promise.resolve([]),
      this.aiRuns?.sourceArtifacts(projectId, workflowRunId) ?? Promise.resolve([]),
    ]);
    return this.toWorkspaceData(
      nodeState ? draftOf(nodeState.state) : emptyDraft(),
      nodeState?.revision ?? null,
      artifactData.items,
      aiRuns,
      classificationSources,
    );
  }

  async saveDraft(
    projectId: string,
    workflowRunId: string,
    expectedRevision: number | null,
    value: unknown,
  ): Promise<EffectTemplateMixWorkspaceData> {
    const draft = draftOf(value);
    const result = await this.working.putNodeState(projectId, workflowRunId, 'TEMPLATE_MIX', {
      expectedRevision,
      schemaVersion: 1,
      state: draft,
    });
    const [artifacts, aiRuns, classificationSources] = await Promise.all([
      this.working.listArtifacts(projectId, { workflowRunId }),
      this.aiRuns?.listRecent(projectId, workflowRunId) ?? Promise.resolve([]),
      this.aiRuns?.sourceArtifacts(projectId, workflowRunId) ?? Promise.resolve([]),
    ]);
    return this.toWorkspaceData(
      draft,
      result.nodeState.revision,
      artifacts.items,
      aiRuns,
      classificationSources,
    );
  }

  async createAiRun(
    projectId: string,
    workflowRunId: string,
    templateId: string,
    expectedRevision: number,
    idempotencyKey: string,
    targetVariantId?: string,
  ): Promise<EffectTemplateMixAiRun> {
    const [nodeState, artifacts, previousRuns] = await Promise.all([
      this.working.getNodeState(projectId, workflowRunId, 'TEMPLATE_MIX'),
      this.aiRuns!.sourceArtifacts(projectId, workflowRunId),
      this.aiRuns!.listRecent(projectId, workflowRunId),
    ]);
    if (nodeState.revision !== expectedRevision)
      throw new ApiHttpException(
        '混剪草稿已更新，请刷新后重新发起智能填充',
        HttpStatus.CONFLICT,
        'CONFLICT',
      );
    const draft = draftOf(nodeState.state);
    const entry = draft.templates.find(({ id }) => id === templateId);
    if (!entry) this.notFound('当前混剪模板不存在');
    const target = targetVariantId
      ? entry!.workspace.variants.find(({ id }) => id === targetVariantId)
      : undefined;
    if (targetVariantId && !target) this.notFound('当前成片工程不存在');
    if (!target && entry!.workspace.variants.length >= 100)
      throw new ApiHttpException(
        '当前模板已达 100 条成片工程上限',
        HttpStatus.BAD_REQUEST,
        'VALIDATION_ERROR',
      );
    const slots = target?.slots ?? entry!.workspace.template.slots;
    const requiredRoles = [
      'HOOK',
      'PAIN_POINT',
      'PRODUCT',
      'SELLING_POINT',
      'TRANSFORMATION',
      'END',
    ];
    if (
      slots.length !== 6 ||
      !slotsValid(slots) ||
      new Set(slots.map(({ role }) => role)).size !== 6 ||
      !requiredRoles.every((role) => slots.some((slot) => slot.role === role))
    )
      throw new ApiHttpException(
        '智能填充第一版要求模板包含完整的六个槽位',
        HttpStatus.BAD_REQUEST,
        'VALIDATION_ERROR',
      );

    const promptArtifacts = artifacts.filter(
      (artifact) =>
        artifact.nodeId === 'PROMPT_GENERATION' && artifact.artifactKey.startsWith('prompt-batch:'),
    );
    const promptById = new Map<
      string,
      { prompt: string; artifact: (typeof promptArtifacts)[number] }
    >();
    for (const artifact of promptArtifacts) {
      const items = object(artifact.payload)?.items;
      if (!Array.isArray(items)) continue;
      for (const raw of items) {
        const item = object(raw);
        if (typeof item?.id === 'string' && typeof item.content === 'string' && item.content.trim())
          promptById.set(item.id, { prompt: item.content, artifact });
      }
    }
    const renderArtifacts = artifacts.filter(
      (artifact) =>
        artifact.nodeId === 'SEGMENT_RENDER' && artifact.artifactKey.startsWith('render-clip:'),
    );
    const materials: EffectTemplateMixAiSnapshot['materials'] = [];
    const promptDependencies = new Map<
      string,
      EffectTemplateMixAiSnapshot['promptArtifacts'][number]
    >();
    for (const artifact of renderArtifacts) {
      const data = object(artifact.payload);
      const promptId = typeof data?.promptId === 'string' ? data.promptId : '';
      const prompt = promptById.get(promptId);
      const duration = Number(data?.durationSeconds);
      if (
        !prompt ||
        !Number.isFinite(duration) ||
        duration <= 0 ||
        !artifact.storageKey ||
        typeof data?.contentHash !== 'string'
      )
        continue;
      promptDependencies.set(prompt.artifact.id, {
        id: prompt.artifact.id,
        artifactKey: prompt.artifact.artifactKey,
        revision: prompt.artifact.revision,
        contentHash: prompt.artifact.contentHash,
      });
      materials.push({
        id: artifact.id,
        code: typeof data.renderCode === 'string' ? data.renderCode : artifact.name,
        name: artifact.name.replace(/\s+视频片段$/u, ''),
        duration,
        promptId,
        prompt: prompt.prompt,
        artifactId: artifact.id,
        artifactKey: artifact.artifactKey,
        artifactRevision: artifact.revision,
        contentHash: artifact.contentHash,
        fileObjectId: typeof data.fileObjectId === 'string' ? data.fileObjectId : '',
      });
    }
    if (materials.length !== renderArtifacts.length)
      throw new ApiHttpException(
        '部分视频片段无法精确回连原始 Prompt 或缺少可用视频文件，请先返回视频渲染节点检查',
        HttpStatus.BAD_REQUEST,
        'VALIDATION_ERROR',
      );
    const materialById = new Map(materials.map((item) => [item.id, item]));
    const lockedBindings = (target?.manualSlotIds ?? []).flatMap((slotId) => {
      const slot = slots.find(({ id }) => id === slotId);
      const materialId = target?.bindings[slotId];
      const material = materialId ? materialById.get(materialId) : undefined;
      const offset = target?.offsets[slotId] ?? 0;
      return slot && material && offset >= 0 && offset + slot.duration <= material.duration + 0.001
        ? [
            {
              slotId,
              materialId: material.id,
              artifactRevision: material.artifactRevision,
              offset,
            },
          ]
        : [];
    });
    const unlockedSlots = slots.filter(
      (slot) => !lockedBindings.some((binding) => binding.slotId === slot.id),
    );
    const lockedIds = new Set(lockedBindings.map(({ materialId }) => materialId));
    if (!target) {
      entry!.workspace.variants.forEach((variant) =>
        Object.values(variant.bindings).forEach((materialId) => lockedIds.add(materialId)),
      );
    }
    const durationFeasible = maximumWeightedAiSelection(
      unlockedSlots.map((slot) => ({ ...slot, purpose: 'HOOK', transition: '硬切' })),
      materials.map(({ id, duration }) => ({ id, duration, available: true })),
      materials.map(({ id }) => ({
        materialId: id,
        scores: {
          HOOK: 1,
          PAIN_POINT: 1,
          PRODUCT: 1,
          SELLING_POINT: 1,
          TRANSFORMATION: 1,
          END: 1,
        },
        reasons: {},
      })),
      lockedIds,
    );
    if (!durationFeasible)
      throw new ApiHttpException(
        target
          ? '可用且时长足够的视频片段不足，六个槽位必须使用不同素材'
          : '剩余未使用素材不足以再生成一条完整成片',
        HttpStatus.BAD_REQUEST,
        'VALIDATION_ERROR',
      );
    const snapshot: EffectTemplateMixAiSnapshot = {
      schemaVersion: 1,
      template: {
        id: templateId,
        name: entry!.workspace.template.name,
        editVersion: entry!.workspace.template.editVersion,
        slots: slots.map(({ id, role, label, duration }) => ({ id, role, label, duration })),
      },
      draftRevision: expectedRevision,
      targetVariantId: targetVariantId ?? null,
      maxOutputVariants: target ? 1 : Math.min(20, 100 - entry!.workspace.variants.length),
      lockedBindings,
      reuseCounts: Object.fromEntries(
        materials.map((material) => [
          material.id,
          entry!.workspace.variants.filter(
            (variant) =>
              variant.id !== targetVariantId &&
              Object.values(variant.bindings).includes(material.id),
          ).length,
        ]),
      ),
      promptArtifacts: [...promptDependencies.values()],
      materials,
    };
    const classificationSignature = (value: EffectTemplateMixAiSnapshot): string =>
      workflowStateHash({
        slots: classificationSlotSignature(value.template.slots),
        materials: value.materials.map(({ id, code, prompt }) => ({ id, code, prompt })),
      });
    const reusableClassifications = previousRuns.find((previous) => {
      if (
        previous.status !== 'COMPLETED' ||
        previous.templateId !== templateId ||
        !Array.isArray(previous.classificationResult)
      )
        return false;
      const previousSnapshot = previous.inputSnapshot as unknown as EffectTemplateMixAiSnapshot;
      return (
        classificationSignature(previousSnapshot) === classificationSignature(snapshot) &&
        classificationsValid(
          snapshot,
          previous.classificationResult as unknown as EffectTemplateMixAiClassification[],
          true,
        )
      );
    })?.classificationResult as EffectTemplateMixAiClassification[] | undefined;
    const inputHash = workflowStateHash(snapshot);
    const reusableCheckpoint = previousRuns.find(
      (previous) =>
        previous.status === 'FAILED' &&
        previous.inputHash === inputHash &&
        Array.isArray(previous.classificationResult) &&
        Array.isArray(previous.selectionResult) &&
        Array.isArray(previous.trimResult),
    );
    const requestHash = workflowStateHash({
      workflowRunId,
      templateId,
      targetVariantId: targetVariantId ?? null,
      expectedRevision,
    });
    const created = await this.aiRuns!.create({
      projectId,
      workflowRunId,
      templateId,
      targetVariantId: targetVariantId ?? null,
      expectedDraftRevision: expectedRevision,
      templateEditVersion: snapshot.template.editVersion,
      idempotencyKey,
      requestHash,
      inputHash,
      snapshot,
      ...(reusableClassifications ? { initialClassifications: reusableClassifications } : {}),
      ...(reusableCheckpoint
        ? {
            initialSelections: reusableCheckpoint.selectionResult as unknown[],
            initialTrims: reusableCheckpoint.trimResult as unknown[],
          }
        : {}),
    });
    if (created.kind === 'KEY_CONFLICT')
      throw new ApiHttpException('幂等键已用于不同请求', HttpStatus.CONFLICT, 'CONFLICT');
    if (created.kind === 'STALE_INPUT')
      throw new ApiHttpException(
        '模板、Prompt 或视频片段已变化，请刷新后重试',
        HttpStatus.CONFLICT,
        'CONFLICT',
      );
    if (created.kind === 'ACTIVE_CONFLICT')
      throw new ApiHttpException('当前模板已有智能填充任务运行中', HttpStatus.CONFLICT, 'CONFLICT');
    return toAiRun(created.run);
  }

  async aiRun(projectId: string, runId: string): Promise<EffectTemplateMixAiRun> {
    const run = await this.aiRuns!.find(projectId, runId);
    if (!run) this.notFound('智能填充任务不存在');
    return toAiRun(run!);
  }

  async claimAiRun(projectId: string, runId: string) {
    const result = await this.aiRuns!.claim(projectId, runId);
    if (result.kind === 'NOT_FOUND') this.notFound('智能填充任务不存在');
    if (result.kind === 'BUSY')
      throw new ApiHttpException('智能填充任务已被领取', HttpStatus.CONFLICT, 'CONFLICT');
    if (result.kind === 'ATTEMPTS_EXHAUSTED')
      throw new ApiHttpException('智能填充任务重试次数已耗尽', HttpStatus.CONFLICT, 'CONFLICT');
    if (result.kind === 'TERMINAL') return { terminal: true, run: toAiRun(result.run) };
    return {
      terminal: false,
      attemptToken: result.attemptToken,
      snapshot: result.run.inputSnapshot,
      checkpoint: {
        classifications: result.run.classificationResult,
        selections: result.run.selectionResult,
        trims: result.run.trimResult,
      },
    };
  }

  async updateAiProgress(
    projectId: string,
    runId: string,
    attemptToken: string,
    stage: 'CLASSIFYING' | 'MATCHING' | 'SAMPLING' | 'TRIMMING',
    progress: number,
  ) {
    const result = await this.aiRuns!.progress(projectId, runId, attemptToken, stage, progress);
    if (result.count !== 1)
      throw new ApiHttpException('智能填充任务租约已失效', HttpStatus.CONFLICT, 'CONFLICT');
    return { accepted: true };
  }

  async classifyAiRun(
    projectId: string,
    runId: string,
    attemptToken: string,
    classifications: EffectTemplateMixAiClassification[],
  ): Promise<{ selections: EffectTemplateMixAiSelection[] }> {
    const run = await this.aiRuns!.find(projectId, runId);
    if (!run || run.status !== 'RUNNING' || run.attemptToken !== attemptToken)
      throw new ApiHttpException('智能填充任务租约已失效', HttpStatus.CONFLICT, 'CONFLICT');
    const snapshot = run.inputSnapshot as unknown as EffectTemplateMixAiSnapshot;
    if (!classificationsValid(snapshot, classifications, true))
      throw new ApiHttpException(
        'Prompt 归槽结果结构无效',
        HttpStatus.BAD_REQUEST,
        'VALIDATION_ERROR',
      );
    const lockedSlotIds = new Set(snapshot.lockedBindings.map(({ slotId }) => slotId));
    const lockedMaterialIds = new Set(snapshot.lockedBindings.map(({ materialId }) => materialId));
    const slots = snapshot.template.slots
      .filter(({ id }) => !lockedSlotIds.has(id))
      .map((slot) => ({
        ...slot,
        purpose: 'HOOK' as const,
        transition: '硬切' as const,
      }));
    const materials = snapshot.materials.map(({ id, duration }) => ({
      id,
      duration,
      available: true,
    }));
    const reuseCounts = new Map(Object.entries(snapshot.reuseCounts ?? {}));
    let selections: EffectTemplateMixAiSelection[];
    if (snapshot.targetVariantId) {
      const selected = maximumWeightedAiSelection(
        slots,
        materials,
        classifications,
        lockedMaterialIds,
        reuseCounts,
      );
      selections = selected?.map((item) => ({ ...item, variantIndex: 0 })) ?? [];
    } else {
      const alreadyUsed = new Set(
        Object.entries(snapshot.reuseCounts ?? {})
          .filter(([, count]) => count > 0)
          .map(([materialId]) => materialId),
      );
      selections = maximumWeightedAiSelectionBatch(
        slots,
        materials,
        classifications,
        alreadyUsed,
        reuseCounts,
        snapshot.maxOutputVariants ?? 20,
      ).flat();
    }
    if (!selections.length)
      throw new ApiHttpException(
        snapshot.targetVariantId
          ? '无法为六个槽位选出互不重复且时长足够的素材'
          : '剩余未使用素材不足以再生成一条完整成片',
        HttpStatus.BAD_REQUEST,
        'VALIDATION_ERROR',
      );
    const saved = await this.aiRuns!.saveSelection(
      projectId,
      runId,
      attemptToken,
      classifications,
      selections,
    );
    if (saved.count !== 1)
      throw new ApiHttpException('智能填充任务租约已失效', HttpStatus.CONFLICT, 'CONFLICT');
    return { selections };
  }

  async checkpointAiClassifications(
    projectId: string,
    runId: string,
    attemptToken: string,
    classifications: EffectTemplateMixAiClassification[],
  ): Promise<{ classifications: EffectTemplateMixAiClassification[]; progress: number }> {
    const run = await this.aiRuns!.find(projectId, runId);
    if (!run || run.status !== 'RUNNING' || run.attemptToken !== attemptToken)
      throw new ApiHttpException('智能填充任务租约已失效', HttpStatus.CONFLICT, 'CONFLICT');
    const snapshot = run.inputSnapshot as unknown as EffectTemplateMixAiSnapshot;
    if (!classificationsValid(snapshot, classifications, false))
      throw new ApiHttpException(
        'Prompt 归槽分片结构无效',
        HttpStatus.BAD_REQUEST,
        'VALIDATION_ERROR',
      );
    const saved = await this.aiRuns!.saveClassificationCheckpoint(
      projectId,
      runId,
      attemptToken,
      classifications,
    );
    if (saved.kind !== 'SAVED')
      throw new ApiHttpException('智能填充任务租约已失效', HttpStatus.CONFLICT, 'CONFLICT');
    return {
      classifications: saved.classifications as EffectTemplateMixAiClassification[],
      progress: saved.progress,
    };
  }

  async checkpointAiTrims(
    projectId: string,
    runId: string,
    attemptToken: string,
    trims: EffectTemplateMixAiTrim[],
  ): Promise<{ trims: EffectTemplateMixAiTrim[]; progress: number }> {
    const run = await this.aiRuns!.find(projectId, runId);
    if (!run || run.status !== 'RUNNING' || run.attemptToken !== attemptToken)
      throw new ApiHttpException('智能填充任务租约已失效', HttpStatus.CONFLICT, 'CONFLICT');
    const snapshot = run.inputSnapshot as unknown as EffectTemplateMixAiSnapshot;
    const selections = run.selectionResult as unknown as EffectTemplateMixAiSelection[];
    if (!Array.isArray(selections) || !trimsValid(snapshot, selections, trims, false))
      throw new ApiHttpException('AI 截取分片结构无效', HttpStatus.BAD_REQUEST, 'VALIDATION_ERROR');
    const saved = await this.aiRuns!.saveTrimCheckpoint(projectId, runId, attemptToken, trims);
    if (saved.kind !== 'SAVED')
      throw new ApiHttpException('智能填充任务租约已失效', HttpStatus.CONFLICT, 'CONFLICT');
    return { trims: saved.trims as EffectTemplateMixAiTrim[], progress: saved.progress };
  }

  async aiVideo(projectId: string, runId: string, materialId: string, attemptToken: string) {
    const source = await this.aiRuns!.selectedFile(projectId, runId, materialId, attemptToken);
    if (!source) this.notFound('智能填充选中视频不存在或租约已失效');
    return { ...source!.file, ...(await this.storage!.open(source!.file.storageKey)) };
  }

  async completeAiRun(
    projectId: string,
    runId: string,
    attemptToken: string,
    trims: EffectTemplateMixAiTrim[],
  ): Promise<EffectTemplateMixAiRun> {
    const run = await this.aiRuns!.find(projectId, runId);
    if (!run || run.status !== 'RUNNING' || run.attemptToken !== attemptToken)
      throw new ApiHttpException('智能填充任务租约已失效', HttpStatus.CONFLICT, 'CONFLICT');
    const snapshot = run.inputSnapshot as unknown as EffectTemplateMixAiSnapshot;
    const selections = run.selectionResult as unknown as EffectTemplateMixAiSelection[];
    if (!Array.isArray(selections))
      throw new ApiHttpException('智能填充尚未完成素材匹配', HttpStatus.CONFLICT, 'CONFLICT');
    const trimByKey = new Map(trims.map((item) => [aiResultKey(item), item]));
    if (
      new Set(selections.map(aiResultKey)).size !== selections.length ||
      !trimsValid(snapshot, selections, trims, true)
    )
      throw new ApiHttpException('AI 截取区间无效', HttpStatus.BAD_REQUEST, 'VALIDATION_ERROR');

    const [nodeState, currentSources] = await Promise.all([
      this.working.getNodeState(projectId, run.workflowRunId, 'TEMPLATE_MIX'),
      this.aiRuns!.sourceArtifacts(projectId, run.workflowRunId),
    ]);
    if (nodeState.revision !== snapshot.draftRevision)
      throw new ApiHttpException(
        '混剪草稿已变化，旧任务不会覆盖当前编辑',
        HttpStatus.CONFLICT,
        'CONFLICT',
      );
    const currentById = new Map(currentSources.map((artifact) => [artifact.id, artifact]));
    const sourcesCurrent =
      snapshot.promptArtifacts.every((source) => {
        const current = currentById.get(source.id);
        return current?.revision === source.revision && current.contentHash === source.contentHash;
      }) &&
      snapshot.materials.every((source) => {
        const current = currentById.get(source.artifactId);
        return (
          current?.revision === source.artifactRevision &&
          current.contentHash === source.contentHash
        );
      });
    const currentClipIds = currentSources
      .filter(
        (source) =>
          source.nodeId === 'SEGMENT_RENDER' && source.artifactKey.startsWith('render-clip:'),
      )
      .map(({ id }) => id)
      .sort();
    const snapshotClipIds = snapshot.materials.map(({ artifactId }) => artifactId).sort();
    if (!sourcesCurrent || workflowStateHash(currentClipIds) !== workflowStateHash(snapshotClipIds))
      throw new ApiHttpException(
        'Prompt 或视频片段已变化，旧任务不会覆盖当前编辑',
        HttpStatus.CONFLICT,
        'CONFLICT',
      );
    const draft = draftOf(nodeState.state);
    const entry = draft.templates.find(({ id }) => id === snapshot.template.id);
    if (!entry) this.notFound('当前混剪模板不存在');
    const currentTarget = snapshot.targetVariantId
      ? entry!.workspace.variants.find(({ id }) => id === snapshot.targetVariantId)
      : undefined;
    const currentSlots = currentTarget?.slots ?? entry!.workspace.template.slots;
    if (
      entry!.workspace.template.editVersion !== snapshot.template.editVersion ||
      workflowStateHash(
        currentSlots.map(({ id, role, label, duration }) => ({ id, role, label, duration })),
      ) !== workflowStateHash(snapshot.template.slots)
    )
      throw new ApiHttpException(
        '模板配置已变化，旧任务不会覆盖当前编辑',
        HttpStatus.CONFLICT,
        'CONFLICT',
      );
    if (snapshot.targetVariantId && !currentTarget) this.notFound('当前成片工程不存在');
    const groupedSelections = new Map<number, EffectTemplateMixAiSelection[]>();
    for (const selection of selections) {
      const index = selection.variantIndex ?? 0;
      const group = groupedSelections.get(index) ?? [];
      group.push(selection);
      groupedSelections.set(index, group);
    }
    const orderedGroups = [...groupedSelections.entries()].sort(([left], [right]) => left - right);
    if (
      !orderedGroups.length ||
      orderedGroups.some(([index], position) => index !== position) ||
      orderedGroups.some(([, group]) => {
        const expectedCount = snapshot.targetVariantId
          ? currentSlots.length - snapshot.lockedBindings.length
          : currentSlots.length;
        return (
          group.length !== expectedCount ||
          new Set(group.map(({ slotId }) => slotId)).size !== group.length ||
          new Set(group.map(({ materialId }) => materialId)).size !== group.length
        );
      }) ||
      (snapshot.targetVariantId && orderedGroups.length !== 1) ||
      (!snapshot.targetVariantId && entry!.workspace.variants.length + orderedGroups.length > 100)
    )
      throw new ApiHttpException(
        'AI 成片批次结构无效或超过模板工程上限',
        HttpStatus.BAD_REQUEST,
        'VALIDATION_ERROR',
      );
    const outputVariantIds: string[] = [];
    let draftChanged = false;
    for (const [variantIndex, group] of orderedGroups) {
      let variant = currentTarget;
      const previousVariantHash = variant ? workflowStateHash(variant) : null;
      if (!variant) {
        variant = {
          id: variantIndex === 0 ? run.id : randomUUID(),
          name: entry!.workspace.template.name + ' · ' + (entry!.workspace.variants.length + 1),
          appliedTemplateVersion: entry!.workspace.template.editVersion,
          slots: JSON.parse(
            JSON.stringify(entry!.workspace.template.slots),
          ) as EffectTemplateMixSlot[],
          bindings: {},
          bindingRevisions: {},
          offsets: {},
          bindingMetadata: {},
          manualSlotIds: [],
          conflictSlotIds: [],
          status: 'CURRENT',
          captions: [],
          subtitleStyle: 'standard',
          bgm: null,
          voice: null,
          originalVolume: 1,
        };
        entry!.workspace.variants.push(variant);
      }
      variant.bindingMetadata ??= {};
      const unlockedSlotIds = new Set(group.map(({ slotId }) => slotId));
      for (const slotId of unlockedSlotIds) {
        delete variant.bindings[slotId];
        delete variant.bindingRevisions[slotId];
        delete variant.offsets[slotId];
        delete variant.bindingMetadata[slotId];
      }
      for (const selection of group) {
        const material = snapshot.materials.find(({ id }) => id === selection.materialId)!;
        const trim = trimByKey.get(aiResultKey(selection))!;
        variant.bindings[selection.slotId] = selection.materialId;
        variant.bindingRevisions[selection.slotId] = material.artifactRevision;
        variant.offsets[selection.slotId] = Math.round(trim.trimStartSeconds * 1000) / 1000;
        variant.bindingMetadata[selection.slotId] = {
          source: 'AI',
          matchScore: selection.matchScore,
          matchLevel: selection.matchLevel,
          classificationReason: selection.classificationReason,
          trimReason: trim.trimReason.trim(),
        };
      }
      variant.conflictSlotIds = variant.slots
        .filter(({ id }) => !variant!.bindings[id])
        .map(({ id }) => id);
      draftChanged ||=
        previousVariantHash === null || previousVariantHash !== workflowStateHash(variant);
      outputVariantIds.push(variant.id);
      if (snapshot.targetVariantId) break;
      variant = undefined;
    }
    if (draftChanged) entry!.workspace.editVersion += 1;
    const completed = await this.aiRuns!.completeWithDraft(
      projectId,
      runId,
      attemptToken,
      outputVariantIds[0]!,
      trims,
      draft,
      workflowStateHash(draft),
      snapshot.draftRevision,
    );
    if (completed === 'DRAFT_CONFLICT')
      throw new ApiHttpException(
        '混剪草稿已变化，旧任务不会覆盖当前编辑',
        HttpStatus.CONFLICT,
        'CONFLICT',
      );
    if (completed !== 'COMPLETED')
      throw new ApiHttpException('智能填充任务租约已失效', HttpStatus.CONFLICT, 'CONFLICT');
    return this.aiRun(projectId, runId);
  }

  async failAiRun(
    projectId: string,
    runId: string,
    attemptToken: string,
    errorCode: string,
    errorMessage: string,
    retryable: boolean,
  ) {
    const result = await this.aiRuns!.fail(
      projectId,
      runId,
      attemptToken,
      errorCode.replace(/[^A-Z0-9_]/gu, '').slice(0, 120) || 'AI_TASK_FAILED',
      errorMessage || '智能填充失败，请重试',
      retryable,
    );
    if (result === 'LEASE_CONFLICT')
      throw new ApiHttpException('智能填充任务租约已失效', HttpStatus.CONFLICT, 'CONFLICT');
    return { status: result };
  }

  async createVariant(
    projectId: string,
    workflowRunId: string,
    templateId: string,
    expectedRevision: number,
  ): Promise<EffectTemplateMixWorkspaceData> {
    return this.mutate(projectId, workflowRunId, expectedRevision, templateId, (workspace) => {
      if (workspace.variants.length >= 100) {
        throw new ApiHttpException(
          '单个模板最多保留 100 个成片工程',
          HttpStatus.BAD_REQUEST,
          'VALIDATION_ERROR',
        );
      }
      const variant = createVariant(workspace);
      workspace.variants.push(variant);
      workspace.editVersion += 1;
    });
  }

  async composeVariants(
    projectId: string,
    workflowRunId: string,
    templateId: string,
    expectedRevision: number,
  ): Promise<EffectTemplateMixWorkspaceData> {
    return this.mutate(projectId, workflowRunId, expectedRevision, templateId, (workspace) => {
      if (workspace.variants.length >= 100)
        throw new ApiHttpException(
          '当前模板已达到 100 个成片工程上限',
          HttpStatus.BAD_REQUEST,
          'VALIDATION_ERROR',
        );
      const variants = composeAlgorithmicVariants(workspace);
      if (!variants.length)
        throw new ApiHttpException(
          '尚无可复用的六槽 AI 裁剪素材，请先完成智能填充',
          HttpStatus.BAD_REQUEST,
          'VALIDATION_ERROR',
        );
      workspace.variants.push(...variants);
      workspace.editVersion += 1;
    });
  }

  async refillVariant(
    projectId: string,
    workflowRunId: string,
    templateId: string,
    variantId: string,
    expectedRevision: number,
  ): Promise<EffectTemplateMixWorkspaceData> {
    return this.mutate(projectId, workflowRunId, expectedRevision, templateId, (workspace) => {
      const variant = workspace.variants.find(({ id }) => id === variantId);
      if (!variant) this.notFound('当前成片工程不存在');
      fillVariant(workspace, variant!);
      workspace.editVersion += 1;
    });
  }

  async applyVariant(
    projectId: string,
    workflowRunId: string,
    templateId: string,
    sourceVariantId: string,
    syncOtherVariants: boolean,
    expectedRevision: number,
  ): Promise<EffectTemplateMixWorkspaceData> {
    return this.mutate(projectId, workflowRunId, expectedRevision, templateId, (workspace) => {
      const variant = workspace.variants.find(({ id }) => id === sourceVariantId);
      if (!variant) this.notFound('当前成片工程不存在');
      applyVariantToTemplate(workspace, variant!, syncOtherVariants);
    });
  }

  async validate(
    projectId: string,
    workflowRunId: string,
    expectedRevision: number,
    templateId: string,
  ): Promise<ValidateEffectTemplateMixData> {
    const nodeState = await this.working.getNodeState(projectId, workflowRunId, 'TEMPLATE_MIX');
    if (nodeState.revision !== expectedRevision) {
      throw new ApiHttpException(
        '混剪草稿已在其他页面更新，请刷新后重试',
        HttpStatus.CONFLICT,
        'CONFLICT',
      );
    }
    const draft = draftOf(nodeState.state);
    const entry = draft.templates.find(({ id }) => id === templateId);
    if (!entry) {
      throw new ApiHttpException('当前混剪模板不存在', HttpStatus.NOT_FOUND, 'ASSET_NOT_FOUND');
    }
    const { template, variants } = entry.workspace;
    if (
      !template.name.trim() ||
      template.name.length > 40 ||
      !slotsValid(template.slots) ||
      variants.length < 1 ||
      variants.length > 100
    ) {
      throw new ApiHttpException(
        '请完善模板名称、槽位和成片工程',
        HttpStatus.BAD_REQUEST,
        'VALIDATION_ERROR',
      );
    }

    const sourceData = await this.working.listArtifacts(projectId, {
      workflowRunId,
      nodeId: 'SEGMENT_RENDER',
    });
    const sources = new Map(
      sourceData.items
        .filter(({ artifactKey }) => artifactKey.startsWith('render-clip:'))
        .map((artifact) => [artifact.id, artifact]),
    );
    const inputs: Array<{ artifactKey: string; input: WorkingArtifactUpsertInput }> = [];
    const allSourceIds = new Set<string>();
    for (const variant of variants) {
      this.validateVariant(variant, sources, allSourceIds);
    }
    const dependenciesFor = (sourceIds: Iterable<string>) => {
      const renderDependencies = [...sourceIds].map((artifactId) => {
        const source = sources.get(artifactId)!;
        return {
          sourceType: 'WORKING_ARTIFACT' as const,
          sourceNodeId: 'SEGMENT_RENDER',
          sourceArtifactId: source.id,
          sourceKey: source.artifactKey,
          sourceRevision: source.revision,
          sourceHash: source.contentHash ?? clipHash(source),
        };
      });
      const promptDependencies = [...sourceIds].flatMap((artifactId) =>
        (sources.get(artifactId)?.dependencies ?? [])
          .filter(
            (dependency) =>
              dependency.sourceType === 'WORKING_ARTIFACT' &&
              dependency.sourceNodeId === 'PROMPT_GENERATION' &&
              dependency.sourceArtifactId,
          )
          .map((dependency) => ({
            sourceType: 'WORKING_ARTIFACT' as const,
            sourceNodeId: 'PROMPT_GENERATION',
            sourceArtifactId: dependency.sourceArtifactId,
            sourceKey: dependency.sourceKey,
            sourceRevision: dependency.sourceRevision,
            sourceHash: dependency.sourceHash,
          })),
      );
      return [
        ...new Map(
          [...renderDependencies, ...promptDependencies].map((item) => [
            `${item.sourceNodeId}:${item.sourceKey}:${item.sourceArtifactId}`,
            item,
          ]),
        ).values(),
      ];
    };
    inputs.push({
      artifactKey: 'mix-template:' + templateId,
      input: {
        kind: 'STRUCTURED',
        name: template.name,
        directory: 'EDITING_PROJECTS',
        type: 'MIX_TEMPLATE',
        tags: ['效果类', '混剪模板'],
        payload: {
          schemaVersion: 1,
          templateId,
          workspaceVersion: entry.workspace.editVersion,
          template,
        },
        metadata: { templateId, variantCount: variants.length },
        dependencies: dependenciesFor(allSourceIds),
      },
    });
    for (const variant of variants) {
      inputs.push({
        artifactKey: 'timeline-project:' + templateId + ':' + variant.id,
        input: {
          kind: 'STRUCTURED',
          name: variant.name,
          directory: 'EDITING_PROJECTS',
          type: 'TIMELINE_PROJECT',
          tags: ['效果类', '时间轴工程'],
          payload: { schemaVersion: 1, templateId, templateVersion: template.editVersion, variant },
          metadata: {
            templateId,
            variantId: variant.id,
            durationSeconds: variant.slots.reduce((sum, slot) => sum + slot.duration, 0),
          },
          dependencies: dependenciesFor(new Set(Object.values(variant.bindings))),
        },
      });
    }
    const committed = await this.working.commitValidatedArtifacts(
      projectId,
      workflowRunId,
      'TEMPLATE_MIX',
      inputs,
    );
    return {
      artifacts: committed.map(({ artifact, unchanged }) => ({
        artifactId: artifact.id,
        artifactKey: artifact.artifactKey,
        revision: artifact.revision,
        unchanged,
      })),
    };
  }

  private async mutate(
    projectId: string,
    workflowRunId: string,
    expectedRevision: number,
    templateId: string,
    mutation: (workspace: EffectTemplateMixWorkspace) => void,
  ): Promise<EffectTemplateMixWorkspaceData> {
    const [nodeState, artifactData, aiRuns, classificationSources] = await Promise.all([
      this.working.getNodeState(projectId, workflowRunId, 'TEMPLATE_MIX'),
      this.working.listArtifacts(projectId, { workflowRunId }),
      this.aiRuns?.listRecent(projectId, workflowRunId) ?? Promise.resolve([]),
      this.aiRuns?.sourceArtifacts(projectId, workflowRunId) ?? Promise.resolve([]),
    ]);
    if (nodeState.revision !== expectedRevision) {
      throw new ApiHttpException(
        '混剪草稿已在其他页面更新，请刷新后重试',
        HttpStatus.CONFLICT,
        'CONFLICT',
      );
    }
    const draft = draftOf(nodeState.state);
    const entry = draft.templates.find(({ id }) => id === templateId);
    if (!entry) this.notFound('当前混剪模板不存在');
    const workspace: EffectTemplateMixWorkspace = {
      ...entry!.workspace,
      materials: artifactData.items
        .map(materialFrom)
        .filter((item): item is EffectTemplateMixMaterial => Boolean(item)),
    };
    mutation(workspace);
    entry!.workspace = {
      editVersion: workspace.editVersion,
      template: workspace.template,
      variants: workspace.variants,
    };
    const saved = await this.working.putNodeState(projectId, workflowRunId, 'TEMPLATE_MIX', {
      expectedRevision,
      schemaVersion: 1,
      state: draft,
    });
    return this.toWorkspaceData(
      draft,
      saved.nodeState.revision,
      artifactData.items,
      aiRuns,
      classificationSources,
    );
  }

  private toWorkspaceData(
    draft: EffectTemplateMixDraft,
    draftRevision: number | null,
    artifacts: WorkingArtifact[],
    aiRunRecords: EffectTemplateMixAiRunRecord[] = [],
    classificationSources: EffectTemplateMixClassificationSource[] = [],
  ): EffectTemplateMixWorkspaceData {
    const materials = artifacts
      .map(materialFrom)
      .filter((item): item is EffectTemplateMixMaterial => Boolean(item));
    const commits = artifacts
      .filter(
        ({ nodeId, artifactKey }) =>
          nodeId === 'TEMPLATE_MIX' && artifactKey.startsWith('mix-template:'),
      )
      .map((artifact) => {
        const data = payload(artifact);
        const template = object(data.template);
        return {
          templateId: String(data.templateId ?? artifact.artifactKey.slice('mix-template:'.length)),
          revision: artifact.revision,
          contentHash: artifact.contentHash ?? '',
          stale: artifact.freshness === 'STALE',
          editVersion: Number(data.workspaceVersion ?? template?.editVersion ?? 0),
        };
      });
    const sourceById = new Map(
      [...artifacts, ...classificationSources].map((artifact) => [artifact.id, artifact]),
    );
    const activeMaterials = materials.filter(({ available }) => available);
    const classificationPools: EffectTemplateMixClassificationPool[] = [];
    const pooledTemplates = new Set<string>();
    for (const run of aiRunRecords) {
      if (
        run.status !== 'COMPLETED' ||
        pooledTemplates.has(run.templateId) ||
        !Array.isArray(run.classificationResult)
      )
        continue;
      const entry = draft.templates.find(({ id }) => id === run.templateId);
      const snapshot = run.inputSnapshot as EffectTemplateMixAiSnapshot;
      const classifications = run.classificationResult as EffectTemplateMixAiClassification[];
      if (
        !entry ||
        classificationSlotSignature(entry.workspace.template.slots) !==
          classificationSlotSignature(snapshot.template.slots) ||
        !classificationsValid(snapshot, classifications, true) ||
        snapshot.materials.length !== activeMaterials.length ||
        snapshot.materials.some((frozen) => {
          const active = activeMaterials.some(({ id }) => id === frozen.id);
          const current = sourceById.get(frozen.id);
          return (
            !active ||
            !current ||
            current.revision !== frozen.artifactRevision ||
            current.contentHash !== frozen.contentHash
          );
        }) ||
        snapshot.promptArtifacts.some((frozen) => {
          const current = sourceById.get(frozen.id);
          return (
            current?.revision !== frozen.revision || current.contentHash !== frozen.contentHash
          );
        })
      )
        continue;
      classificationPools.push({
        templateId: run.templateId,
        runId: run.id,
        templateEditVersion: entry.workspace.template.editVersion,
        items: AI_MIX_ROLES.flatMap((role) => {
          const ranked = classifications
            .map((classification) => ({
              materialId: classification.materialId,
              role,
              matchScore: classification.scores[role],
            }))
            .sort(
              (left, right) =>
                right.matchScore - left.matchScore ||
                left.materialId.localeCompare(right.materialId),
            );
          const normal = ranked.filter(({ matchScore }) => matchScore >= 0.6);
          const usedByAi = new Set(
            entry.workspace.variants.flatMap((variant) =>
              variant.slots
                .filter(
                  (slot) =>
                    slot.role === role && variant.bindingMetadata?.[slot.id]?.source === 'AI',
                )
                .map((slot) => ({ id: variant.bindings[slot.id], slotId: slot.id }))
                .filter(({ id, slotId }) =>
                  Boolean(
                    id &&
                    activeMaterials.some(
                      (material) =>
                        material.id === id &&
                        material.artifactRevision === variant.bindingRevisions[slotId],
                    ),
                  ),
                )
                .map(({ id }) => id!),
            ),
          );
          const base = normal.length ? normal : ranked.slice(0, Math.min(6, ranked.length));
          const baseIds = new Set(base.map(({ materialId }) => materialId));
          return [
            ...base,
            ...ranked.filter(
              ({ materialId }) => usedByAi.has(materialId) && !baseIds.has(materialId),
            ),
          ];
        }),
      });
      pooledTemplates.add(run.templateId);
    }
    return {
      draft,
      draftRevision,
      materials,
      commits,
      aiRuns: aiRunRecords.map(toAiRun),
      classificationPools,
    };
  }

  private notFound(message: string): never {
    throw new ApiHttpException(message, HttpStatus.NOT_FOUND, 'ASSET_NOT_FOUND');
  }

  private validateVariant(
    variant: EffectTemplateMixVariant,
    sources: Map<string, WorkingArtifact>,
    allSourceIds: Set<string>,
  ): void {
    if (!variant.name.trim() || !slotsValid(variant.slots) || variant.conflictSlotIds.length) {
      throw new ApiHttpException(
        '成片工程仍有素材缺口或槽位配置无效',
        HttpStatus.BAD_REQUEST,
        'VALIDATION_ERROR',
      );
    }
    const used = new Set<string>();
    const slotIds = new Set(variant.slots.map(({ id }) => id));
    if (Object.keys(variant.bindings).some((slotId) => !slotIds.has(slotId))) {
      throw new ApiHttpException(
        '成片工程包含已移除槽位的素材引用',
        HttpStatus.BAD_REQUEST,
        'VALIDATION_ERROR',
      );
    }
    for (const slot of variant.slots) {
      const artifactId = variant.bindings[slot.id];
      const source = artifactId ? sources.get(artifactId) : undefined;
      const offset = variant.offsets[slot.id] ?? 0;
      if (
        !source ||
        source.availability !== 'AVAILABLE' ||
        source.freshness !== 'CURRENT' ||
        variant.bindingRevisions[slot.id] !== source.revision ||
        used.has(source.id) ||
        !Number.isFinite(offset) ||
        offset < 0 ||
        offset + slot.duration > clipDuration(source) + 0.001
      ) {
        throw new ApiHttpException(
          '成片工程引用了缺失、过期、重复或时长不足的素材',
          HttpStatus.CONFLICT,
          'CONFLICT',
        );
      }
      used.add(source.id);
      allSourceIds.add(source.id);
    }
    const totalDuration = variant.slots.reduce((sum, slot) => sum + slot.duration, 0);
    for (const caption of variant.captions) {
      if (
        !caption.text.trim() ||
        caption.start < 0 ||
        caption.end <= caption.start ||
        caption.end > totalDuration + 0.001
      ) {
        throw new ApiHttpException(
          '字幕内容或时间范围无效',
          HttpStatus.BAD_REQUEST,
          'VALIDATION_ERROR',
        );
      }
    }
  }
}
