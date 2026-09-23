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
import { packagingTimelineDuration, packagingVisualVariant } from '@ai-marketing/contracts';

import { ApiHttpException } from '../../../common/api-http-exception';
import { WorkflowWorkingService } from '../../../platform/workflow/workflow-working.service';
import { workflowStateHash } from '../../../platform/workflow/workflow-state-hash';
import { STORAGE_PORT, type StoragePort } from '../../../platform/file/storage.port';
import type { WorkingArtifactUpsertInput } from '../../../platform/workflow/workflow-working.repository';
import {
  applyVariantToTemplate,
  balancedSlotAssignment,
  buildAssignedPools,
  createEmptyVariant,
  createVariant,
  enumerateAssignedVariants,
  fillVariant,
  maximumWeightedAiSelection,
  selectAssignedVariant,
} from './effect-template-mix.domain';
import { EffectTemplateMixAiRepository } from './effect-template-mix-ai.repository';
import type { EffectTemplateMixAiSnapshot } from './effect-template-mix-ai.types';
import { EffectPackagingRepository } from './effect-packaging.repository';
import { visualHash } from './effect-packaging.domain';

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
        (template.voiceProfileId === undefined ||
          (typeof template.voiceProfileId === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(template.voiceProfileId))) &&
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
            Array.isArray(variant.captions) &&
            (variant.detachedAudios === undefined ||
              (Array.isArray(variant.detachedAudios) &&
                variant.detachedAudios.length <= variant.slots.length &&
                variant.detachedAudios.every((rawAudio) => {
                  const audio = object(rawAudio);
                  return Boolean(
                    audio &&
                      typeof audio.id === 'string' &&
                      typeof audio.sourceSlotId === 'string' &&
                      typeof audio.fileObjectId === 'string' &&
                      typeof audio.name === 'string' &&
                      Number.isFinite(audio.start) &&
                      Number.isFinite(audio.duration) &&
                      Number.isFinite(audio.offset) &&
                      Number.isFinite(audio.volume),
                  );
                })))
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

const slotsValid = (slots: EffectTemplateMixSlot[], minimumDuration = 3): boolean =>
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
      duration >= minimumDuration &&
      duration <= 15,
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

const aiResultKey = (value: { materialId: string }): string => value.materialId;

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

type MaterialPromptSource = {
  code: string;
  content: string;
  creativeCore?: string;
};

const promptSourcesFromArtifacts = (
  artifacts: readonly WorkingArtifact[],
): Map<string, MaterialPromptSource> => {
  const sources = new Map<string, MaterialPromptSource>();
  for (const artifact of artifacts) {
    if (
      artifact.nodeId !== 'PROMPT_GENERATION' ||
      !artifact.artifactKey.startsWith('prompt-batch:')
    )
      continue;
    const items = payload(artifact).items;
    if (!Array.isArray(items)) continue;
    for (const raw of items) {
      const item = object(raw);
      const id = typeof item?.id === 'string' ? item.id : '';
      const content = typeof item?.content === 'string' ? item.content.trim() : '';
      if (!id || !content) continue;
      const code = typeof item?.code === 'string' ? item.code : '';
      const creativeCore =
        typeof item?.creativeCore === 'string' && item.creativeCore.trim()
          ? item.creativeCore.trim()
          : undefined;
      const source: MaterialPromptSource = { code, content };
      if (creativeCore) source.creativeCore = creativeCore;
      sources.set(id, source);
    }
  }
  return sources;
};

const materialFrom = (
  artifact: WorkingArtifact,
  promptSources: ReadonlyMap<string, MaterialPromptSource> = new Map(),
): EffectTemplateMixMaterial | null => {
  if (
    artifact.nodeId !== 'SEGMENT_RENDER' ||
    !artifact.artifactKey.startsWith('render-clip:') ||
    artifact.kind !== 'FILE'
  ) {
    return null;
  }
  const data = payload(artifact);
  const duration = Number(data.durationSeconds);
  if (!Number.isFinite(duration) || duration <= 0) return null;
  const primaryPurpose = materialPurpose(data.primaryPurpose);
  if (!primaryPurpose) return null;
  const promptId = typeof data.promptId === 'string' ? data.promptId : '';
  const prompt = promptId ? promptSources.get(promptId) : undefined;
  const fileObjectId = typeof data.fileObjectId === 'string' ? data.fileObjectId : '';
  // Render artifacts keep the same output in their FileObject relation. Prefer that
  // stable file endpoint over the artifact aggregate endpoint so old artifacts remain
  // playable after their working-artifact freshness changes.
  const fileContentUrl = (artifact.files ?? []).find(
    (file) => file.fileObjectId === fileObjectId || file.id === fileObjectId,
  )?.contentUrl;
  const contentUrl = fileContentUrl ?? artifact.contentUrl;
  if (!contentUrl) return null;
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
    fileObjectId,
    contentHash: typeof data.contentHash === 'string' ? data.contentHash : '',
    contentUrl,
    code: typeof data.renderCode === 'string' ? data.renderCode : artifact.name,
    name: artifact.name.replace(/\s+视频片段$/u, ''),
    duration,
    purpose: primaryPurpose,
    compatiblePurposes,
    ratio: typeof data.ratio === 'string' ? data.ratio : '',
    resolution: typeof data.resolution === 'string' ? data.resolution : '',
    available: artifact.availability === 'AVAILABLE' && artifact.freshness === 'CURRENT',
    ...(prompt?.code ? { promptCode: prompt.code } : {}),
    ...(prompt?.content ? { promptText: prompt.content } : {}),
    ...(prompt?.creativeCore ? { promptCreativeCore: prompt.creativeCore } : {}),
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
  inputSnapshot?: unknown;
  classificationResult?: unknown;
  selectionResult?: unknown;
  samplingResult?: unknown;
  trimResult?: unknown;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
}): EffectTemplateMixAiRun => {
  const snapshot = object(run.inputSnapshot) as {
    materials?: Array<{ id?: string; code?: string; name?: string }>;
    template?: { slots?: Array<{ id?: string; label?: string }> };
  } | null;
  const materials = Array.isArray(snapshot?.materials) ? snapshot.materials : [];
  const materialById = new Map(materials.map((item) => [item.id ?? '', item]));
  const slots = Array.isArray(snapshot?.template?.slots) ? snapshot.template.slots : [];
  const slotById = new Map(slots.map((item) => [item.id ?? '', item]));
  const classifications = Array.isArray(run.classificationResult)
    ? (run.classificationResult as Array<{ materialId?: string }>)
    : [];
  const selections = Array.isArray(run.selectionResult)
    ? (run.selectionResult as Array<{ materialId?: string; slotId?: string }>)
    : [];
  const sampledMaterialIds = Array.isArray(run.samplingResult)
    ? run.samplingResult.filter((id): id is string => typeof id === 'string')
    : [];
  const trims = Array.isArray(run.trimResult)
    ? (run.trimResult as Array<{ materialId?: string; trimStartSeconds?: number }>)
    : [];
  const limit = 4;
  const materialLabel = (id?: string): string => {
    const item = materialById.get(id ?? '');
    return item ? [item.code, item.name].filter(Boolean).join(' · ') : '素材';
  };
  const stageDetails: NonNullable<EffectTemplateMixAiRun['stageDetails']> = {
    CLASSIFYING: {
      completed: Math.min(classifications.length, materials.length),
      total: materials.length,
      inputSamples: materials
        .slice(0, limit)
        .map((item) => [item.code, item.name].filter(Boolean).join(' · ')),
      outputSamples: classifications
        .slice(0, limit)
        .map((item) => `${materialLabel(item.materialId)} · 已完成归槽评分`),
    },
    MATCHING: {
      completed: selections.length ? 1 : 0,
      total: 1,
      inputSamples: classifications.slice(0, limit).map((item) => materialLabel(item.materialId)),
      outputSamples: selections.slice(0, limit).map((item) => {
        const slot = slotById.get(item.slotId ?? '');
        return `${materialLabel(item.materialId)} → ${slot?.label ?? '目标槽位'}`;
      }),
    },
    SAMPLING: {
      completed: Math.min(sampledMaterialIds.length, selections.length),
      total: selections.length,
      inputSamples: selections.slice(0, limit).map((item) => materialLabel(item.materialId)),
      outputSamples: sampledMaterialIds
        .slice(0, limit)
        .map((id) => `${materialLabel(id)} · 关键帧已抽取`),
    },
    TRIMMING: {
      completed: Math.min(trims.length, selections.length),
      total: selections.length,
      inputSamples: selections.slice(0, limit).map((item) => {
        const slot = slotById.get(item.slotId ?? '');
        return `${materialLabel(item.materialId)} · ${slot?.label ?? '目标槽位'}`;
      }),
      outputSamples: trims.slice(0, limit).map((item) =>
        `${materialLabel(item.materialId)} · 从 ${Number(item.trimStartSeconds ?? 0).toFixed(1)} 秒截取`,
      ),
    },
    COMPLETED: {
      completed: run.status === 'COMPLETED' ? 1 : 0,
      total: 1,
      inputSamples: trims.slice(0, limit).map((item) => materialLabel(item.materialId)),
      outputSamples: run.status === 'COMPLETED' ? ['时间轴工程草稿已生成'] : [],
    },
  };
  return {
    id: run.id,
    templateId: run.templateId,
    targetVariantId: run.targetVariantId,
    outputVariantId: run.outputVariantId,
    status: run.status,
    stage: run.stage,
    progress: run.progress,
    stageDetails,
    errorCode: run.errorCode,
    errorMessage: run.errorMessage,
    createdAt: run.createdAt.toISOString(),
    updatedAt: run.updatedAt.toISOString(),
  };
};

type EffectTemplateMixAiRunRecord = Parameters<typeof toAiRun>[0] & {
  templateEditVersion: number;
  inputSnapshot: unknown;
  classificationResult: unknown;
  selectionResult: unknown;
  samplingResult: unknown;
  trimResult: unknown;
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
    @Optional()
    @Inject(EffectPackagingRepository)
    private readonly packaging?: EffectPackagingRepository,
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
    const previousState = await this.working.getNodeStateOrNull(projectId, workflowRunId, 'TEMPLATE_MIX');
    const previous = previousState ? draftOf(previousState.state) : emptyDraft();
    const currentSlotsValid = (slots: EffectTemplateMixSlot[], before: EffectTemplateMixSlot[] | undefined) =>
      slotsValid(slots) && slots.every((slot) => slot.duration >= 4 ||
        before?.some((old) => old.id === slot.id && JSON.stringify(old) === JSON.stringify(slot)));
    if (draft.templates.some(({ id, workspace }) => {
      const old = previous.templates.find((entry) => entry.id === id)?.workspace;
      return !currentSlotsValid(workspace.template.slots, old?.template.slots) ||
        workspace.variants.some((variant) => !currentSlotsValid(variant.slots,
          old?.variants.find((candidate) => candidate.id === variant.id)?.slots));
    }))
      throw new ApiHttpException('新增或修改的槽位时长必须为 4–15 秒，且槽位编号不可重复',
        HttpStatus.BAD_REQUEST, 'VALIDATION_ERROR');
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
      !slotsValid(slots, 4) ||
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
    const existingVariantBindings = entry!.workspace.variants
      .filter((variant) => variant.id !== targetVariantId)
      .map((variant) =>
        slots
          .map((slot) => ({ slotId: slot.id, materialId: variant.bindings[slot.id] ?? '' }))
          .filter(({ materialId }) => Boolean(materialId) && materialById.has(materialId)),
      );
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
      maxOutputVariants: target ? 1 : 100 - entry!.workspace.variants.length,
      lockedBindings,
      existingVariantBindings,
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
    const promptSignature = (value: EffectTemplateMixAiSnapshot): string =>
      workflowStateHash(
        [...value.promptArtifacts].sort((left, right) => left.id.localeCompare(right.id)),
      );
    const cachedClassifications = new Map<string, EffectTemplateMixAiClassification>();
    for (const previous of previousRuns) {
      if (
        previous.status !== 'COMPLETED' ||
        previous.templateId !== templateId ||
        !Array.isArray(previous.classificationResult)
      )
        continue;
      const previousSnapshot = previous.inputSnapshot as unknown as EffectTemplateMixAiSnapshot;
      const rows = previous.classificationResult as unknown as EffectTemplateMixAiClassification[];
      if (
        !Array.isArray(previousSnapshot.template?.slots) ||
        !Array.isArray(previousSnapshot.materials) ||
        !Array.isArray(previousSnapshot.promptArtifacts) ||
        classificationSlotSignature(previousSnapshot.template.slots) !==
          classificationSlotSignature(snapshot.template.slots) ||
        promptSignature(previousSnapshot) !== promptSignature(snapshot) ||
        !classificationsValid(previousSnapshot, rows, true)
      )
        continue;
      const oldMaterials = new Map(
        previousSnapshot.materials.map((material) => [material.id, material]),
      );
      const oldRows = new Map(rows.map((row) => [row.materialId, row]));
      for (const material of snapshot.materials) {
        if (cachedClassifications.has(material.id)) continue;
        const oldMaterial = oldMaterials.get(material.id);
        const row = oldRows.get(material.id);
        if (
          oldMaterial &&
          row &&
          workflowStateHash(oldMaterial) === workflowStateHash(material) &&
          classificationsValid({ ...snapshot, materials: [material] }, [row], true)
        )
          cachedClassifications.set(material.id, row);
      }
    }
    const reusableClassifications = snapshot.materials.flatMap((material) => {
      const cached = cachedClassifications.get(material.id);
      return cached ? [cached] : [];
    });
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
      ...(reusableClassifications.length
        ? { initialClassifications: reusableClassifications }
        : {}),
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
        sampledMaterialIds: result.run.samplingResult,
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
    const slots = snapshot.template.slots.filter(({ id }) => !lockedSlotIds.has(id));
    const materials = snapshot.materials.map(({ id, duration }) => ({
      id,
      duration,
      available: true,
    }));
    const reuseCounts = new Map(Object.entries(snapshot.reuseCounts ?? {}));
    let selections: EffectTemplateMixAiSelection[];
    if (snapshot.targetVariantId) {
      selections = selectAssignedVariant(
        slots,
        materials,
        classifications,
        lockedMaterialIds,
        reuseCounts,
      );
      if (selections.length !== slots.length)
        throw new ApiHttpException(
          '部分槽位归槽素材不足，无法完成重新智能填充',
          HttpStatus.BAD_REQUEST,
          'VALIDATION_ERROR',
        );
    } else {
      const pools = buildAssignedPools(slots, materials, classifications);
      const bottleneck = slots.find((slot) => !pools.get(slot.role)?.length);
      if (bottleneck)
        throw new ApiHttpException(
          `「${bottleneck.label}」槽位归槽素材不足，无法生成完整成片，请补充该槽位方向的素材`,
          HttpStatus.BAD_REQUEST,
          'VALIDATION_ERROR',
        );
      const variants = enumerateAssignedVariants(
        slots,
        materials,
        classifications,
        snapshot.existingVariantBindings ?? [],
        snapshot.maxOutputVariants ?? 0,
      );
      const trimPlan = new Map<string, EffectTemplateMixAiSelection>();
      for (const variant of variants) {
        for (const selection of variant) trimPlan.set(selection.materialId, selection);
      }
      selections = [...trimPlan.values()];
      if (!selections.length)
        throw new ApiHttpException(
          '剩余素材不足以再生成一条完整成片',
          HttpStatus.BAD_REQUEST,
          'VALIDATION_ERROR',
        );
    }
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

  async checkpointAiSampling(
    projectId: string,
    runId: string,
    attemptToken: string,
    materialIds: string[],
  ): Promise<{ materialIds: string[] }> {
    const run = await this.aiRuns!.find(projectId, runId);
    if (!run || run.status !== 'RUNNING' || run.attemptToken !== attemptToken)
      throw new ApiHttpException('智能填充任务租约已失效', HttpStatus.CONFLICT, 'CONFLICT');
    const selections = Array.isArray(run.selectionResult)
      ? (run.selectionResult as EffectTemplateMixAiSelection[])
      : [];
    const selectedIds = new Set(selections.map(({ materialId }) => materialId));
    if (
      !Array.isArray(materialIds) ||
      materialIds.length < 1 ||
      materialIds.length > selections.length ||
      new Set(materialIds).size !== materialIds.length ||
      materialIds.some((id) => !selectedIds.has(id))
    )
      throw new ApiHttpException('关键帧进度分片无效', HttpStatus.BAD_REQUEST, 'VALIDATION_ERROR');
    const saved = await this.aiRuns!.saveSamplingCheckpoint(
      projectId,
      runId,
      attemptToken,
      materialIds,
    );
    if (saved.kind === 'LEASE_CONFLICT')
      throw new ApiHttpException('智能填充任务租约已失效', HttpStatus.CONFLICT, 'CONFLICT');
    if (saved.kind === 'INVALID_MATERIAL')
      throw new ApiHttpException('关键帧素材不属于本次匹配结果', HttpStatus.BAD_REQUEST, 'VALIDATION_ERROR');
    return { materialIds: saved.materialIds };
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
    const classifications =
      run.classificationResult as unknown as EffectTemplateMixAiClassification[];
    if (!Array.isArray(selections))
      throw new ApiHttpException('智能填充尚未完成素材匹配', HttpStatus.CONFLICT, 'CONFLICT');
    if (!Array.isArray(classifications) || !classificationsValid(snapshot, classifications, true))
      throw new ApiHttpException('Prompt 归槽结果缺失或无效', HttpStatus.CONFLICT, 'CONFLICT');
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
    const materials = snapshot.materials.map(({ id, duration }) => ({
      id,
      duration,
      available: true,
    }));
    const lockedSlotIds = new Set(snapshot.lockedBindings.map(({ slotId }) => slotId));
    const unlockedSlots = currentSlots.filter(({ id }) => !lockedSlotIds.has(id));
    const variantSelections: EffectTemplateMixAiSelection[][] = snapshot.targetVariantId
      ? [
          selectAssignedVariant(
            unlockedSlots,
            materials,
            classifications,
            new Set(snapshot.lockedBindings.map(({ materialId }) => materialId)),
            new Map(Object.entries(snapshot.reuseCounts ?? {})),
          ),
        ]
      : enumerateAssignedVariants(
          unlockedSlots,
          materials,
          classifications,
          snapshot.existingVariantBindings ?? [],
          snapshot.maxOutputVariants ?? 0,
        );
    if (
      !variantSelections.length ||
      (snapshot.targetVariantId && variantSelections[0]!.length !== unlockedSlots.length) ||
      (!snapshot.targetVariantId &&
        entry!.workspace.variants.length + variantSelections.length > 100)
    )
      throw new ApiHttpException(
        'AI 成片批次结构无效或超过模板工程上限',
        HttpStatus.BAD_REQUEST,
        'VALIDATION_ERROR',
      );
    const outputVariantIds: string[] = [];
    let draftChanged = false;
    for (const group of variantSelections) {
      let variant = currentTarget;
      const previousVariantHash = variant ? workflowStateHash(variant) : null;
      if (!variant) {
        variant = {
          id: outputVariantIds.length === 0 ? run.id : randomUUID(),
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
      const slotIdsToSet = new Set(group.map(({ slotId }) => slotId));
      for (const slotId of slotIdsToSet) {
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
      if (!slotsValid(workspace.template.slots, 4))
        throw new ApiHttpException('新成片槽位时长必须为 4–15 秒', HttpStatus.BAD_REQUEST, 'VALIDATION_ERROR');
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

  async createEmptyVariant(
    projectId: string,
    workflowRunId: string,
    templateId: string,
    expectedRevision: number,
  ): Promise<EffectTemplateMixWorkspaceData> {
    return this.mutate(projectId, workflowRunId, expectedRevision, templateId, (workspace) => {
      if (!slotsValid(workspace.template.slots, 4))
        throw new ApiHttpException('新成片槽位时长必须为 4–15 秒', HttpStatus.BAD_REQUEST, 'VALIDATION_ERROR');
      if (workspace.variants.length >= 100) {
        throw new ApiHttpException(
          '单个模板最多保留 100 个成片工程',
          HttpStatus.BAD_REQUEST,
          'VALIDATION_ERROR',
        );
      }
      workspace.variants.push(createEmptyVariant(workspace));
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
      if (!slotsValid(workspace.template.slots, 4))
        throw new ApiHttpException('智能填充槽位时长必须为 4–15 秒', HttpStatus.BAD_REQUEST, 'VALIDATION_ERROR');
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
      if (!slotsValid(variant!.slots, 4))
        throw new ApiHttpException('同步模板的槽位时长必须为 4–15 秒', HttpStatus.BAD_REQUEST, 'VALIDATION_ERROR');
      applyVariantToTemplate(workspace, variant!, syncOtherVariants);
    });
  }

  async prepareValidation(
    projectId: string,
    workflowRunId: string,
    expectedRevision: number,
    templateId: string,
  ) {
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
      !slotsValid(template.slots, 4) ||
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
          payload: {
            schemaVersion: 1,
            templateId,
            templateVersion: template.editVersion,
            variant: packagingVisualVariant(variant),
          },
          metadata: {
            templateId,
            variantId: variant.id,
            durationSeconds: packagingTimelineDuration(variant),
          },
          dependencies: dependenciesFor(new Set(Object.values(variant.bindings))),
        },
      });
    }
    return { inputs, variants };
  }

  async validate(projectId: string, workflowRunId: string, expectedRevision: number,
    templateId: string): Promise<ValidateEffectTemplateMixData> {
    const { inputs, variants } = await this.prepareValidation(projectId, workflowRunId, expectedRevision, templateId);
    const committed = await this.working.commitValidatedArtifacts(
      projectId,
      workflowRunId,
      'TEMPLATE_MIX',
      inputs,
    );
    // Preserve historical manual audio/subtitles at the same explicit confirmation boundary.
    // Never overwrite a generated package with legacy editor fields.
    const legacy = variants.filter((v) => v.voice || v.bgm || v.captions.length);
    if (legacy.length && this.packaging) {
      const existing = (
        await this.working.listArtifacts(projectId, { workflowRunId, nodeId: 'TEMPLATE_MIX' })
      ).items;
      for (const variant of legacy) {
        const key = `timeline-package:${templateId}:${variant.id}`;
        const previous = existing.find((a) => a.artifactKey === key);
        if (previous && object(previous.payload)?.legacy !== true) continue;
        const visual = committed.find(
          (c) => c.artifact.artifactKey === `timeline-project:${templateId}:${variant.id}`,
        )?.artifact;
        if (!visual) continue;
        const ids = [variant.voice?.fileObjectId, variant.bgm?.fileObjectId].filter(
          (id): id is string => Boolean(id),
        );
        const files = await this.packaging.db.fileObject.findMany({
          where: { projectId, workflowRunId, id: { in: ids }, status: 'AVAILABLE' },
        });
        if (files.length !== new Set(ids).size)
          throw new ApiHttpException(
            '历史包装音频不存在，请检查后重新校验',
            HttpStatus.CONFLICT,
            'CONFLICT',
          );
        const migrated = await this.working.commitValidatedArtifacts(
          projectId,
          workflowRunId,
          'TEMPLATE_MIX',
          [
            {
              artifactKey: key,
              input: {
                kind: 'STRUCTURED',
                name: `${variant.name} · 人工包装`,
                directory: 'EDITING_PROJECTS',
                type: 'TIMELINE_PROJECT',
                payload: {
                  schemaVersion: 1,
                  legacy: true,
                  templateId,
                  variantId: variant.id,
                  sourceTimelineHash: visualHash(variant),
                  visualArtifactId: visual.id,
                  visualRevision: visual.revision,
                  captions: variant.captions,
                  subtitleStyle: variant.subtitleStyle,
                  voice: variant.voice,
                  bgm: variant.bgm,
                  originalVolume: variant.originalVolume,
                },
                files: files.map((f, sortOrder) => ({
                  fileObjectId: f.id,
                  role: f.id === variant.bgm?.fileObjectId ? 'BGM' : 'VOICE',
                  sortOrder,
                  originalFileName: f.originalFileName,
                  mimeType: f.mimeType,
                  sha256: f.sha256,
                })),
                dependencies: [
                  {
                    sourceType: 'WORKING_ARTIFACT',
                    sourceNodeId: 'TEMPLATE_MIX',
                    sourceArtifactId: visual.id,
                    sourceKey: visual.artifactKey,
                    sourceRevision: visual.revision,
                    sourceHash: visual.contentHash ?? null,
                  },
                ],
              },
            },
          ],
        );
        committed.push(...migrated);
      }
    }
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
    const promptSources = promptSourcesFromArtifacts(artifactData.items);
    const workspace: EffectTemplateMixWorkspace = {
      ...entry!.workspace,
      materials: artifactData.items
        .map((artifact) => materialFrom(artifact, promptSources))
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
    const promptSources = promptSourcesFromArtifacts(artifacts);
    const materials = artifacts
      .map((artifact) => materialFrom(artifact, promptSources))
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
      const assignment = balancedSlotAssignment(AI_MIX_ROLES, classifications);
      classificationPools.push({
        templateId: run.templateId,
        runId: run.id,
        templateEditVersion: entry.workspace.template.editVersion,
        items: AI_MIX_ROLES.flatMap((role) =>
          classifications
            .filter(({ materialId }) => assignment.get(materialId) === role)
            .map((classification) => ({
              materialId: classification.materialId,
              role,
              matchScore: classification.scores[role],
            }))
            .sort(
              (left, right) =>
                right.matchScore - left.matchScore ||
                left.materialId.localeCompare(right.materialId),
            ),
        ),
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
    if (!variant.name.trim() || !slotsValid(variant.slots, 4) || variant.conflictSlotIds.length) {
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
