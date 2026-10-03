import type {
  EffectTemplateMixAiClassification,
  EffectTemplateMixClassificationPool,
  EffectTemplateMixAiRun,
  EffectTemplateMixAiSelection,
  EffectTemplateMixSampledMaterial,
  EffectTemplateMixAiTrim,
  EffectTemplateMixDraft,
  EffectTemplateMixMaterial,
  EffectTemplateMixRole,
  EffectTemplateMixSlot,
  EffectTemplateMixTemplate,
  EffectTemplateMixVariant,
  EffectTemplateMixWorkspace,
  EffectTemplateMixWorkspaceData,
  ValidateEffectTemplateMixData,
  WorkingArtifact,
} from '@ai-marketing/contracts';
import { HttpStatus, Inject, Injectable, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { packagingTimelineDuration, packagingVisualVariant, resolveEffectTemplateMixMaterialRoles } from '@ai-marketing/contracts';

import { ApiHttpException } from '../../../common/api-http-exception';
import { WorkflowWorkingService } from '../../../platform/workflow/workflow-working.service';
import { workflowStateHash } from '../../../platform/workflow/workflow-state-hash';
import { STORAGE_PORT, type StoragePort } from '../../../platform/file/storage.port';
import type { WorkingArtifactUpsertInput } from '../../../platform/workflow/workflow-working.repository';
import {
  applyVariantToTemplate,
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
import { templateConfigurationHash } from './template-mix-lifecycle';

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
        (entry.materialRoleOverrides === undefined ||
          (object(entry.materialRoleOverrides) !== null &&
            Object.entries(entry.materialRoleOverrides as Record<string, unknown>).length <= 1000 &&
            Object.entries(entry.materialRoleOverrides as Record<string, unknown>).every(
              ([id, role]) =>
                id.length > 0 &&
                id.length <= 200 &&
                (role === null || AI_MIX_ROLES.includes(role as EffectTemplateMixRole)),
            ))) &&
        (entry.createdAt === undefined ||
          (typeof entry.createdAt === 'string' &&
            !Number.isNaN(Date.parse(entry.createdAt)) &&
            new Date(entry.createdAt).toISOString() === entry.createdAt)) &&
        (entry.aiFillLocked === undefined || typeof entry.aiFillLocked === 'boolean') &&
        (entry.filledTemplateHash === undefined || typeof entry.filledTemplateHash === 'string') &&
        (entry.packagingLocked === undefined || typeof entry.packagingLocked === 'boolean') &&
        (entry.needsAiFill === undefined || typeof entry.needsAiFill === 'boolean') &&
        Number.isInteger(workspace?.editVersion) &&
        typeof template?.name === 'string' &&
        Number.isInteger(template.editVersion) &&
        (template.voiceProfileId === undefined ||
          (typeof template.voiceProfileId === 'string' &&
            /^[a-zA-Z0-9_-]{1,80}$/.test(template.voiceProfileId))) &&
        Array.isArray(template.slots) &&
        Array.isArray(workspace?.variants) &&
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
                variant.detachedAudios.length <= 100 &&
                variant.detachedAudios.every((rawAudio) => {
                  const audio = object(rawAudio);
                  const hasVideoSource = typeof audio?.sourceSlotId === 'string';
                  const hasMusicSource = typeof audio?.sourceAssetId === 'string';
                  const isFileSource = audio?.sourceType === 'FILE';
                  const validSource = isFileSource
                    ? !hasVideoSource && !hasMusicSource
                    : hasVideoSource !== hasMusicSource && audio?.sourceType === undefined;
                  const duration = Number(audio?.duration);
                  const fadeIn = Number(audio?.fadeIn ?? 0);
                  const fadeOut = Number(audio?.fadeOut ?? 0);
                  return Boolean(
                    audio &&
                    typeof audio.id === 'string' &&
                    validSource &&
                    (audio.audioKind === undefined ||
                      ['VOICE', 'MUSIC', 'DETACHED'].includes(String(audio.audioKind))) &&
                    (audio.loopSource === undefined ||
                      (typeof audio.loopSource === 'boolean' &&
                        (audio.loopSource !== true || audio.audioKind === 'MUSIC'))) &&
                    typeof audio.fileObjectId === 'string' &&
                    typeof audio.name === 'string' &&
                    Number.isFinite(audio.start) &&
                    Number.isFinite(duration) &&
                    duration > 0 &&
                    Number.isFinite(audio.offset) &&
                    Number.isFinite(audio.volume) &&
                    (audio.sourceDuration === undefined ||
                      (Number.isFinite(audio.sourceDuration) &&
                        Number(audio.offset) + duration <= Number(audio.sourceDuration) + 0.05)) &&
                    Number.isFinite(fadeIn) &&
                    fadeIn >= 0 &&
                    Number.isFinite(fadeOut) &&
                    fadeOut >= 0 &&
                    fadeIn + fadeOut <= duration + 0.05,
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

const templateNameKey = (name: string): string => name.normalize('NFKC').trim().toLowerCase();

const introducesDuplicateTemplateName = (
  draft: EffectTemplateMixDraft,
  previous: EffectTemplateMixDraft,
): boolean => {
  const previousById = new Map(previous.templates.map((entry) => [entry.id, entry]));
  const byName = new Map<string, EffectTemplateMixDraft['templates'][number][]>();
  for (const entry of draft.templates) {
    const key = templateNameKey(entry.workspace.template.name);
    if (!key) continue;
    const group = byName.get(key) ?? [];
    group.push(entry);
    byName.set(key, group);
  }
  for (const [key, group] of byName) {
    if (group.length < 2) continue;
    for (let left = 0; left < group.length; left += 1) {
      for (let right = left + 1; right < group.length; right += 1) {
        const previousLeft = previousById.get(group[left]!.id);
        const previousRight = previousById.get(group[right]!.id);
        if (
          !previousLeft ||
          !previousRight ||
          templateNameKey(previousLeft.workspace.template.name) !== key ||
          templateNameKey(previousRight.workspace.template.name) !== key
        )
          return true;
      }
    }
  }
  return false;
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
        (item.source === undefined || item.source === 'AI' || item.source === 'MANUAL') &&
        (snapshot.manualMaterialRoles?.[item.materialId]
          ? item.source === 'MANUAL' &&
            AI_MIX_ROLES.every(
              (role) =>
                item.scores?.[role] ===
                (role === snapshot.manualMaterialRoles![item.materialId] ? 1 : 0),
            )
          : item.source !== 'MANUAL') &&
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

/**
 * Every material an existing project still points at. A superseded clip stays reachable this way: it
 * is genuinely expired (its Prompt moved on and the refresh flow refuses to rebind it), and dropping
 * it from the pool would blank the slot instead of showing it as expired.
 */
const boundMaterialIds = (variants: Iterable<EffectTemplateMixVariant>): ReadonlySet<string> => {
  const ids = new Set<string>();
  for (const variant of variants)
    for (const materialId of Object.values(variant.bindings)) if (materialId) ids.add(materialId);
  return ids;
};

const renderFileKey = (artifact: { id: string; payload: unknown }): string => {
  const fileObjectId = object(artifact.payload)?.fileObjectId;
  return typeof fileObjectId === 'string' && fileObjectId ? fileObjectId : artifact.id;
};

/** A cloned render artifact is another reference to the same video, not another source clip. */
const distinctRenderFiles = <T extends { id: string; artifactKey: string; payload: unknown }>(
  artifacts: readonly T[],
  preferredIds: ReadonlySet<string> = new Set(),
): { artifacts: T[]; canonicalIdById: Map<string, string> } => {
  const byFile = new Map<string, T>();
  for (const artifact of [...artifacts].sort(
    (left, right) =>
      left.artifactKey.localeCompare(right.artifactKey) || left.id.localeCompare(right.id),
  )) {
    const fileKey = renderFileKey(artifact);
    const previous = byFile.get(fileKey);
    if (!previous || (preferredIds.has(artifact.id) && !preferredIds.has(previous.id)))
      byFile.set(fileKey, artifact);
  }
  const canonicalIdById = new Map(
    artifacts.map((artifact) => [artifact.id, byFile.get(renderFileKey(artifact))!.id]),
  );
  return { artifacts: [...byFile.values()], canonicalIdById };
};

/**
 * A re-render replaces a product's batch wholesale, and nothing ever deletes the superseded batch's
 * clips: their `render-clip:*` rows stay in `working_artifacts` for good. Enumerating that key prefix
 * therefore grew the mix pool by a full batch on every re-render, and the leftovers — stale as soon as
 * the Prompt they came from changed — were counted as "expired materials" the user could never use.
 *
 * Keep what a render node actually offers: the clips its committed `render-batch:*` payloads list,
 * stale ones included, so a Prompt edit still surfaces as expired; plus whatever is still current,
 * which is what smart fill can pick; plus `keepIds`, the clips existing projects are bound to.
 * Returns `null` when no batch payload is readable, so an unexpected shape falls back to the
 * unfiltered set rather than hiding materials.
 */
const currentMaterialKeys = (
  artifacts: readonly WorkingArtifact[],
  keepIds: ReadonlySet<string>,
): ReadonlySet<string> | null => {
  const keys = new Set<string>();
  let sawBatch = false;
  for (const artifact of artifacts) {
    if (artifact.nodeId !== 'SEGMENT_RENDER' || !artifact.artifactKey.startsWith('render-batch:'))
      continue;
    const clips = payload(artifact).clips;
    if (!Array.isArray(clips)) continue;
    sawBatch = true;
    for (const raw of clips) {
      const taskId = object(raw)?.taskId;
      if (typeof taskId === 'string' && taskId) keys.add(`render-clip:${taskId}`);
    }
  }
  if (!sawBatch) return null;
  for (const artifact of artifacts) {
    if (
      artifact.nodeId === 'SEGMENT_RENDER' &&
      artifact.artifactKey.startsWith('render-clip:') &&
      ((artifact.freshness === 'CURRENT' && artifact.availability === 'AVAILABLE') ||
        keepIds.has(artifact.id))
    )
      keys.add(artifact.artifactKey);
  }
  return keys;
};

const materialsFromArtifacts = (
  artifacts: readonly WorkingArtifact[],
  keepIds: ReadonlySet<string> = new Set(),
): EffectTemplateMixMaterial[] => {
  // Prompt sources live on `prompt-batch:*`, so they have to be read from the full list before the
  // pool is narrowed down to render clips.
  const promptSources = promptSourcesFromArtifacts(artifacts);
  const poolKeys = currentMaterialKeys(artifacts, keepIds);
  return artifacts
    .filter((artifact) => poolKeys === null || poolKeys.has(artifact.artifactKey))
    .map((artifact) => materialFrom(artifact, promptSources))
    .filter((item): item is EffectTemplateMixMaterial => Boolean(item));
};

const toAiRun = (run: {
  id: string;
  templateId: string;
  workflowRunId: string;
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
    trimOnly?: boolean;
    materials?: Array<{
      id?: string;
      code?: string;
      name?: string;
      duration?: number;
      promptSummary?: string;
    }>;
    template?: { name?: string; slots?: Array<{ id?: string; label?: string; duration?: number }> };
  } | null;
  const materials = Array.isArray(snapshot?.materials) ? snapshot.materials : [];
  const materialById = new Map(materials.map((item) => [item.id ?? '', item]));
  const slots = Array.isArray(snapshot?.template?.slots) ? snapshot.template.slots : [];
  const slotById = new Map(slots.map((item) => [item.id ?? '', item]));
  const classifications = Array.isArray(run.classificationResult)
    ? (run.classificationResult as Array<{
        materialId?: string;
        scores?: Partial<Record<EffectTemplateMixRole, number>>;
        reasons?: Partial<Record<EffectTemplateMixRole, string>>;
      }>)
    : [];
  const selections = Array.isArray(run.selectionResult)
    ? (run.selectionResult as Array<{
        materialId?: string;
        slotId?: string;
        role?: EffectTemplateMixRole;
        variantIndex?: number;
        matchScore?: number;
        matchLevel?: 'NORMAL' | 'LOW_MATCH';
        classificationReason?: string;
      }>)
    : [];
  const trims = Array.isArray(run.trimResult)
    ? (run.trimResult as Array<{
        materialId?: string;
        slotId?: string;
        variantIndex?: number;
        trimStartSeconds?: number;
        trimReason?: string;
      }>)
    : [];
  const sampledById = new Map<string, { timestamps: number[]; inferredFromTrim: boolean }>();
  const selectedMaterialIds = new Set(selections.map((item) => item.materialId).filter(Boolean));
  for (const entry of Array.isArray(run.samplingResult) ? run.samplingResult : []) {
    if (typeof entry === 'string') {
      if (selectedMaterialIds.has(entry))
        sampledById.set(entry, { timestamps: [], inferredFromTrim: false });
      continue;
    }
    const value = object(entry);
    const materialId = typeof value?.materialId === 'string' ? value.materialId : '';
    const timestamps = Array.isArray(value?.frameTimestampsSeconds)
      ? value.frameTimestampsSeconds.filter(
          (timestamp): timestamp is number =>
            typeof timestamp === 'number' && Number.isFinite(timestamp),
        )
      : [];
    if (materialId && selectedMaterialIds.has(materialId))
      sampledById.set(materialId, { timestamps, inferredFromTrim: false });
  }
  // Older workers persisted trim choices before sampling checkpoints existed. A valid
  // trim could only be produced after keyframes had been extracted, so use it as proof
  // for those historical materials instead of presenting a contradictory 0/N completed run.
  for (const trim of trims) {
    if (
      trim.materialId &&
      selectedMaterialIds.has(trim.materialId) &&
      !sampledById.has(trim.materialId)
    )
      sampledById.set(trim.materialId, { timestamps: [], inferredFromTrim: true });
  }
  const limit = 4;
  const sampleText = (value: unknown, maxLength = 150) => {
    if (typeof value !== 'string') return '';
    const text = value.replace(/\s+/gu, ' ').trim();
    return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
  };
  const materialLabel = (id?: string): string => {
    const item = materialById.get(id ?? '');
    if (!item) return '视频素材';
    const core = sampleText(item.promptSummary, 82);
    return `${[item.code, item.name].filter(Boolean).join(' · ')}${
      typeof item.duration === 'number' ? ` · ${item.duration.toFixed(1)} 秒视频` : ''
    }${core ? ` · 创意主线：${core}` : ''}`;
  };
  const roleLabels: Record<EffectTemplateMixRole, string> = {
    HOOK: '片头钩子',
    PAIN_POINT: '痛点唤醒',
    PRODUCT: '产品展示',
    SELLING_POINT: '卖点讲解',
    TRANSFORMATION: '效果呈现',
    END: '片尾转化',
  };
  const roleLabel = (role?: string) =>
    role && role in roleLabels ? roleLabels[role as EffectTemplateMixRole] : '模板槽位';
  const bestRole = (item: (typeof classifications)[number]) =>
    (Object.entries(item.scores ?? {}) as [EffectTemplateMixRole, number][])
      .filter(([, score]) => typeof score === 'number' && Number.isFinite(score))
      .sort((left, right) => right[1] - left[1])[0];
  const scorePercent = (score?: number) =>
    typeof score === 'number' && Number.isFinite(score) ? `${Math.round(score * 100)}%` : '—';
  const selectedByMaterial = new Map(selections.map((item) => [item.materialId ?? '', item]));
  const selectionKey = (item: { materialId?: string; slotId?: string; variantIndex?: number }) =>
    `${item.variantIndex ?? 0}:${item.materialId ?? ''}:${item.slotId ?? ''}`;
  const trimBySelection = new Map(trims.map((item) => [selectionKey(item), item]));
  const uniqueMaterialSelections = [
    ...new Map(selections.map((item) => [item.materialId ?? '', item])).values(),
  ];
  const timestampSamples = (timestamps: number[]) =>
    timestamps.length
      ? timestamps
          .slice(0, 4)
          .map((value) => `${value.toFixed(1)} 秒`)
          .join('、')
      : '';
  const trimRange = (trim: (typeof trims)[number], selection: (typeof selections)[number]) => {
    const slot = slotById.get(trim.slotId ?? selection.slotId ?? '');
    const start = Number(trim.trimStartSeconds ?? 0);
    const end = start + Number(slot?.duration ?? 0);
    return `${start.toFixed(1)}–${end.toFixed(1)} 秒`;
  };
  const byVariant = new Map<number, typeof selections>();
  for (const selection of selections) {
    const index = selection.variantIndex ?? 0;
    byVariant.set(index, [...(byVariant.get(index) ?? []), selection]);
  }
  const completedInputSamples: string[] = [];
  const completedOutputSamples: string[] = [];
  for (const [index, variantSelections] of byVariant) {
    if (completedInputSamples.length >= limit && completedOutputSamples.length >= limit) break;
    const sorted = [...variantSelections].sort(
      (left, right) =>
        slots.findIndex(({ id }) => id === left.slotId) -
        slots.findIndex(({ id }) => id === right.slotId),
    );
    const clips = sorted.map((selection) => {
      const slot = slotById.get(selection.slotId ?? '');
      const trim = trimBySelection.get(selectionKey(selection));
      return `${slot?.label ?? roleLabel(selection.role)} ${materialById.get(selection.materialId ?? '')?.code ?? '素材'}${
        trim ? `（${trimRange(trim, selection)}）` : ''
      }`;
    });
    const variantName = `第 ${index + 1} 条成片`;
    completedInputSamples.push(`${variantName} · ${clips.join('；')}`);
    if (run.status === 'COMPLETED')
      completedOutputSamples.push(
        `${variantName} · ${clips.length} 个镜头已写入「${snapshot?.template?.name ?? '当前'}」时间轴`,
      );
  }
  const stageDetails: NonNullable<EffectTemplateMixAiRun['stageDetails']> = {
    CLASSIFYING: {
      completed: Math.min(classifications.length, materials.length),
      total: materials.length,
      inputSamples: materials.slice(0, limit).map((item) => {
        const target = slots.map(({ label, duration }) => `${label}（${duration} 秒）`).join('、');
        return `${materialLabel(item.id)} · 对比模板目标：${target}`;
      }),
      outputSamples: classifications.slice(0, limit).map((item) => {
        const top = bestRole(item);
        if (!top) return `${materialLabel(item.materialId)} · 暂无有效匹配评分`;
        const reason = sampleText(item.reasons?.[top[0]], 72);
        return `${materialLabel(item.materialId)} → ${roleLabels[top[0]]} ${scorePercent(top[1])}${reason ? ` · ${reason}` : ''}`;
      }),
    },
    MATCHING: {
      completed: selections.length ? 1 : 0,
      total: 1,
      inputSamples: classifications.slice(0, limit).map((item) => {
        const top = bestRole(item);
        const reason = top ? sampleText(item.reasons?.[top[0]], 72) : '';
        return `${materialLabel(item.materialId)} · 优先考虑 ${roleLabel(top?.[0])} ${scorePercent(top?.[1])}${reason ? `（${reason}）` : ''}`;
      }),
      outputSamples: selections.slice(0, limit).map((item) => {
        const slot = slotById.get(item.slotId ?? '');
        const reason = sampleText(item.classificationReason, 72);
        return `${materialLabel(item.materialId)} → ${slot?.label ?? roleLabel(item.role)} · 匹配度 ${scorePercent(item.matchScore)}${
          item.matchLevel === 'LOW_MATCH' ? ' · 备选补位' : ''
        }${reason ? ` · ${reason}` : ''}`;
      }),
    },
    SAMPLING: {
      completed: Math.min(sampledById.size, uniqueMaterialSelections.length),
      total: uniqueMaterialSelections.length,
      inputSamples: uniqueMaterialSelections.slice(0, limit).map((item) => {
        const slot = slotById.get(item.slotId ?? '');
        return `${materialLabel(item.materialId)} · 候选镜头：${slot?.label ?? roleLabel(item.role)}（${slot?.duration ?? 0} 秒）`;
      }),
      outputSamples: uniqueMaterialSelections.slice(0, limit).flatMap((item) => {
        const id = item.materialId ?? '';
        const sampled = sampledById.get(id);
        if (!sampled) return [];
        const selection = selectedByMaterial.get(id);
        const trim = selection ? trimBySelection.get(selectionKey(selection)) : undefined;
        const frameInfo = sampled.timestamps.length
          ? `抽取 ${sampled.timestamps.length} 张关键帧（${timestampSamples(sampled.timestamps)}${sampled.timestamps.length > 4 ? '…' : ''}）`
          : '已抽取关键帧';
        const visualReason = trim ? sampleText(trim.trimReason, 76) : '';
        return [
          `${materialLabel(id)} · ${frameInfo}${
            sampled.inferredFromTrim ? '，旧任务记录由截取结果确认' : ''
          }${visualReason ? ` · 画面选择依据：${visualReason}` : ''}`,
        ];
      }),
    },
    TRIMMING: {
      completed: Math.min(trims.length, selections.length),
      total: selections.length,
      inputSamples: selections.slice(0, limit).map((item) => {
        const slot = slotById.get(item.slotId ?? '');
        const sampled = sampledById.get(item.materialId ?? '');
        const frames = sampled?.timestamps.length
          ? ` · 已抽取关键帧：${timestampSamples(sampled.timestamps)}`
          : '';
        return `${materialLabel(item.materialId)} · ${slot?.label ?? roleLabel(item.role)}（目标 ${slot?.duration ?? 0} 秒）${frames}`;
      }),
      outputSamples: trims.slice(0, limit).map((item) => {
        const selection = selectedByMaterial.get(item.materialId ?? '') ?? item;
        const slot = slotById.get(item.slotId ?? selection.slotId ?? '');
        const reason = sampleText(item.trimReason, 96);
        return `${materialLabel(item.materialId)} → ${slot?.label ?? roleLabel('')} · 截取 ${trimRange(item, selection)}${reason ? ` · ${reason}` : ''}`;
      }),
    },
    COMPLETED: {
      completed: run.status === 'COMPLETED' ? 1 : 0,
      total: 1,
      inputSamples: completedInputSamples.slice(0, limit),
      outputSamples: completedOutputSamples.slice(0, limit),
    },
  };
  return {
    id: run.id,
    templateId: run.templateId,
    workflowRunId: run.workflowRunId,
    operation: snapshot?.trimOnly ? 'REFRESH_TRIMS' : 'FILL',
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

/**
 * Re-points a fill the branch inherited at the clips this Run holds, so the pool it describes can be
 * read here.
 *
 * A fork copies the rendered files, never the fill row, and the frozen snapshot names the ancestor's
 * artifact ids, revisions and content hashes — every one of which the pool guard resolves against
 * the Run being viewed. That is why a branch that kept the clips but not the fill came back to the
 * material library as it looked before the fill. The files are the one thing the two Runs share, so
 * the snapshot is matched up by `fileObjectId`; the prompt batch is this Run's own, because product
 * ids are minted per fork and nothing else joins them. Anything that does not resolve drops the
 * whole fill: a partially re-pointed snapshot would score a pool that is not this Run's.
 */
const remapInheritedFill = (
  run: EffectTemplateMixAiRunRecord,
  artifacts: readonly Pick<
    WorkingArtifact,
    'id' | 'revision' | 'contentHash' | 'artifactKey' | 'nodeId' | 'freshness' | 'availability'
  >[],
  activeMaterials: readonly Pick<EffectTemplateMixMaterial, 'id' | 'fileObjectId' | 'artifactId'>[],
): EffectTemplateMixAiRunRecord | null => {
  const snapshot = run.inputSnapshot as EffectTemplateMixAiSnapshot | null;
  const classifications = Array.isArray(run.classificationResult)
    ? (run.classificationResult as EffectTemplateMixAiClassification[])
    : null;
  if (!snapshot || !Array.isArray(snapshot.materials) || !classifications?.length) return null;
  const rowById = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
  const materialByFile = new Map(
    activeMaterials.map((material) => [material.fileObjectId, material]),
  );
  const materialIds = new Map<string, string>();
  const materials: EffectTemplateMixAiSnapshot['materials'] = [];
  for (const frozen of snapshot.materials) {
    const material = materialByFile.get(frozen.fileObjectId);
    const row = material ? rowById.get(material.artifactId) : undefined;
    if (!material || !row) return null;
    materialIds.set(frozen.id, material.id);
    materials.push({
      ...frozen,
      id: material.id,
      artifactId: material.id,
      artifactKey: row.artifactKey,
      artifactRevision: row.revision,
      contentHash: row.contentHash ?? '',
    });
  }
  const prompts = Array.isArray(snapshot.promptArtifacts) ? snapshot.promptArtifacts : [];
  const prompt = prompts.length
    ? artifacts.find(
        (artifact) =>
          artifact.nodeId === 'PROMPT_GENERATION' &&
          artifact.artifactKey.startsWith('prompt-batch:') &&
          artifact.freshness === 'CURRENT' &&
          artifact.availability === 'AVAILABLE',
      )
    : undefined;
  if (prompts.length && !prompt) return null;
  return {
    ...run,
    inputSnapshot: {
      ...snapshot,
      materials,
      ...(snapshot.materialRoleAssignments
        ? {
            materialRoleAssignments: Object.fromEntries(
              Object.entries(snapshot.materialRoleAssignments).flatMap(([id, role]) =>
                materialIds.has(id) ? [[materialIds.get(id)!, role]] : [],
              ),
            ),
          }
        : {}),
      ...(snapshot.manualMaterialRoles
        ? {
            manualMaterialRoles: Object.fromEntries(
              Object.entries(snapshot.manualMaterialRoles).flatMap(([id, role]) =>
                materialIds.has(id) ? [[materialIds.get(id)!, role]] : [],
              ),
            ),
          }
        : {}),
      ...(prompt
        ? {
            promptArtifacts: prompts.map((frozen) => ({
              ...frozen,
              id: prompt.id,
              artifactKey: prompt.artifactKey,
              revision: prompt.revision,
              contentHash: prompt.contentHash ?? '',
            })),
          }
        : {}),
    },
    classificationResult: classifications.map((item) => ({
      ...item,
      materialId: materialIds.get(item.materialId) ?? item.materialId,
    })),
  };
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
    const [
      nodeState,
      artifactData,
      aiRuns,
      classificationSources,
      lockedTemplateIds,
      packagingLockedIds,
      inheritedAiRuns,
    ] = await Promise.all([
      this.working.getNodeStateOrNull(projectId, workflowRunId, 'TEMPLATE_MIX'),
      this.working.listArtifacts(projectId, { workflowRunId }),
      this.aiRuns?.listRecent(projectId, workflowRunId) ?? Promise.resolve([]),
      this.aiRuns?.sourceArtifacts(projectId, workflowRunId) ?? Promise.resolve([]),
      this.aiRuns?.lockedTemplateIds?.(projectId, workflowRunId) ?? Promise.resolve([]),
      this.aiRuns?.packagedTemplateIds?.(projectId, workflowRunId) ?? Promise.resolve([]),
      this.aiRuns?.inheritedMixAiRuns?.(projectId, workflowRunId) ?? Promise.resolve([]),
    ]);
    const templateCreationReady = await this.templateCreationReady(
      projectId,
      workflowRunId,
      artifactData.items,
    );
    return this.toWorkspaceData(
      nodeState ? draftOf(nodeState.state) : emptyDraft(),
      nodeState?.revision ?? null,
      artifactData.items,
      aiRuns,
      classificationSources,
      lockedTemplateIds,
      packagingLockedIds,
      templateCreationReady,
      inheritedAiRuns,
    );
  }

  private async templateCreationReady(
    projectId: string,
    workflowRunId: string,
    artifacts: WorkingArtifact[],
  ): Promise<boolean> {
    if (
      artifacts.some(
        (artifact) =>
          artifact.nodeId === 'SEGMENT_RENDER' &&
          artifact.artifactKey.startsWith('render-clip:') &&
          artifact.freshness === 'CURRENT' &&
          artifact.availability === 'AVAILABLE',
      )
    ) return true;
    return (await this.aiRuns?.hasSuccessfulRenderBatch(projectId, workflowRunId)) ?? false;
  }

  /** Worker hot path: read the saved visual draft without building the material pool or UI state. */
  async currentVariant(
    projectId: string,
    workflowRunId: string,
    templateId: string,
    variantId: string,
  ): Promise<EffectTemplateMixVariant | null> {
    const state = await this.working.getNodeStateOrNull(projectId, workflowRunId, 'TEMPLATE_MIX');
    if (!state) return null;
    return (
      draftOf(state.state)
        .templates.find((entry) => entry.id === templateId)
        ?.workspace.variants.find((variant) => variant.id === variantId) ?? null
    );
  }

  /**
   * The voice only feeds future packaging and voice redos, never existing audio, so a template that
   * has already been packaged may still have its voice switched. Hashing without it keeps every
   * other field locked exactly as before.
   */
  private templateWithoutVoice(
    template: EffectTemplateMixTemplate,
  ): Omit<EffectTemplateMixTemplate, 'voiceProfileId'> {
    const { voiceProfileId: _voiceProfileId, ...rest } = template;
    return rest;
  }

  async saveDraft(
    projectId: string,
    workflowRunId: string,
    expectedRevision: number | null,
    value: unknown,
  ): Promise<EffectTemplateMixWorkspaceData> {
    const draft = draftOf(value);
    const [previousState, lockedTemplateIds, packagingLockedIds, activePackagingIds, recentAiRuns, sourceArtifacts] =
      await Promise.all([
        this.working.getNodeStateOrNull(projectId, workflowRunId, 'TEMPLATE_MIX'),
        this.aiRuns?.lockedTemplateIds?.(projectId, workflowRunId) ?? Promise.resolve([]),
        this.aiRuns?.packagedTemplateIds?.(projectId, workflowRunId) ?? Promise.resolve([]),
        this.aiRuns?.activePackagingTemplateIds?.(projectId, workflowRunId) ?? Promise.resolve([]),
        this.aiRuns?.listRecent(projectId, workflowRunId) ?? Promise.resolve([]),
        this.working.listArtifacts(projectId, { workflowRunId }),
      ]);
    const previous = previousState ? draftOf(previousState.state) : emptyDraft();
    const roleMaterials = new Map(
      materialsFromArtifacts(sourceArtifacts.items).map((material) => [
        material.id,
        material,
      ]),
    );
    for (const entry of draft.templates) {
      const oldEntry = previous.templates.find((item) => item.id === entry.id);
      const old = oldEntry?.materialRoleOverrides ?? {};
      entry.materialRoleEditVersion =
        (oldEntry?.materialRoleEditVersion ?? 0) +
        (workflowStateHash(old) === workflowStateHash(entry.materialRoleOverrides ?? {}) ? 0 : 1);
      for (const [id, role] of Object.entries(entry.materialRoleOverrides ?? {})) {
        if (Object.prototype.hasOwnProperty.call(old, id) && old[id] === role) continue;
        const material = roleMaterials.get(id);
        if (!material?.available)
          throw new ApiHttpException(
            '归槽素材不属于当前分支或已不可用，请刷新素材列表',
            HttpStatus.BAD_REQUEST,
            'VALIDATION_ERROR',
          );
        const slot =
          role === null
            ? undefined
            : entry.workspace.template.slots.find((item) => item.role === role);
        if (role !== null && (!slot || material.duration + 0.001 < slot.duration))
          throw new ApiHttpException(
            `「${material.code}」时长不足以归入「${slot?.label ?? '目标槽位'}」，请调整槽位时长`,
            HttpStatus.BAD_REQUEST,
            'VALIDATION_ERROR',
          );
      }
    }

    for (const existing of previous.templates) {
      if (draft.templates.some((entry) => entry.id === existing.id)) continue;
      if (
        !this.aiRuns ||
        (await this.aiRuns.templateHasDownstream(projectId, workflowRunId, existing.id))
      )
        throw new ApiHttpException(
          '此模板已有智能填充或下游分支，不能删除',
          HttpStatus.CONFLICT,
          'CONFLICT',
        );
    }
    const newTemplateIds = draft.templates.filter(
      (entry) => !previous.templates.some((existing) => existing.id === entry.id),
    );
    if (newTemplateIds.length) {
      const artifacts = await this.working.listArtifacts(projectId, { workflowRunId });
      if (!(await this.templateCreationReady(projectId, workflowRunId, artifacts.items)))
        throw new ApiHttpException(
          '请先等待当前视频渲染批次全部成功，再新建混剪模板',
          HttpStatus.CONFLICT,
          'CONFLICT',
        );
    }
    if (introducesDuplicateTemplateName(draft, previous))
      throw new ApiHttpException(
        '模板名称不能重复，请修改后再保存',
        HttpStatus.BAD_REQUEST,
        'VALIDATION_ERROR',
      );
    const activeSet = new Set(lockedTemplateIds);
    const packagingSet = new Set(packagingLockedIds);
    const activePackagingSet = new Set(activePackagingIds);
    for (const templateId of new Set([...activeSet, ...packagingSet, ...activePackagingSet])) {
      const before = previous.templates.find((entry) => entry.id === templateId);
      const next = draft.templates.find((entry) => entry.id === templateId);
      const workspaceChanged = Boolean(
        before && next && workflowStateHash(before.workspace) !== workflowStateHash(next.workspace),
      );
      // A voice-only change is allowed after packaging, so it is masked out here. `workspaceChanged`
      // above still includes it, which keeps a run that is currently in flight locked.
      const templateChanged = Boolean(
        before &&
        next &&
        workflowStateHash(this.templateWithoutVoice(before.workspace.template)) !==
          workflowStateHash(this.templateWithoutVoice(next.workspace.template)),
      );
      const removedExistingVariant = Boolean(
        before &&
        next &&
        before.workspace.variants.some(
          (variant) => !next.workspace.variants.some((candidate) => candidate.id === variant.id),
        ),
      );
      if (
        !before ||
        !next ||
        ((activeSet.has(templateId) || activePackagingSet.has(templateId)) && workspaceChanged) ||
        (packagingSet.has(templateId) && (templateChanged || removedExistingVariant))
      ) {
        throw new ApiHttpException(
          packagingSet.has(templateId) || activePackagingSet.has(templateId)
            ? templateChanged
              ? '智能成片包装已开始，模板配置不能再修改'
              : activePackagingSet.has(templateId)
                ? '智能成片包装正在执行，暂不能修改成片工程'
                : '智能成片包装后不能删除既有成片工程'
            : '智能填充正在运行，此模板暂时不能修改',
          HttpStatus.CONFLICT,
          'CONFLICT',
        );
      }
      next.aiFillLocked = activeSet.has(templateId);
      // Once a packaging run starts, the template and smart-fill configuration stay locked.
      next.packagingLocked = packagingSet.has(templateId);
    }
    const currentSlotsValid = (
      slots: EffectTemplateMixSlot[],
      before: EffectTemplateMixSlot[] | undefined,
    ) =>
      slotsValid(slots) &&
      slots.every(
        (slot) =>
          slot.duration >= 4 ||
          before?.some((old) => old.id === slot.id && JSON.stringify(old) === JSON.stringify(slot)),
      );
    if (
      draft.templates.some(({ id, workspace }) => {
        const old = previous.templates.find((entry) => entry.id === id)?.workspace;
        return (
          !currentSlotsValid(workspace.template.slots, old?.template.slots) ||
          workspace.variants.some(
            (variant) =>
              !currentSlotsValid(
                variant.slots,
                old?.variants.find((candidate) => candidate.id === variant.id)?.slots,
              ),
          )
        );
      })
    )
      throw new ApiHttpException(
        '新增或修改的槽位时长必须为 4–15 秒，且槽位编号不可重复',
        HttpStatus.BAD_REQUEST,
        'VALIDATION_ERROR',
      );
    for (const entry of draft.templates) {
      const before = previous.templates.find((candidate) => candidate.id === entry.id);
      // Creation time belongs to the persisted template, never to an editable client field.
      if (before?.createdAt) entry.createdAt = before.createdAt;
      else if (!before) entry.createdAt = new Date().toISOString();
      else delete entry.createdAt;
      entry.aiFillLocked = activeSet.has(entry.id);
      entry.packagingLocked = packagingSet.has(entry.id);
      const untrustedEntry = { ...entry };
      delete untrustedEntry.filledTemplateHash;
      const filledTemplateHash = this.filledHashForEntry(before ?? untrustedEntry, recentAiRuns);
      if (filledTemplateHash) entry.filledTemplateHash = filledTemplateHash;
      else delete entry.filledTemplateHash;
      entry.needsAiFill = this.needsRefill(entry, entry.filledTemplateHash);
    }
    const result = await this.working.putNodeState(projectId, workflowRunId, 'TEMPLATE_MIX', {
      expectedRevision,
      schemaVersion: 1,
      state: draft,
    });
    const [artifacts, aiRuns, classificationSources, inheritedAiRuns] = await Promise.all([
      this.working.listArtifacts(projectId, { workflowRunId }),
      this.aiRuns?.listRecent(projectId, workflowRunId) ?? Promise.resolve([]),
      this.aiRuns?.sourceArtifacts(projectId, workflowRunId) ?? Promise.resolve([]),
      this.aiRuns?.inheritedMixAiRuns?.(projectId, workflowRunId) ?? Promise.resolve([]),
    ]);
    const templateCreationReady = await this.templateCreationReady(
      projectId,
      workflowRunId,
      artifacts.items,
    );
    return this.toWorkspaceData(
      draft,
      result.nodeState.revision,
      artifacts.items,
      aiRuns,
      classificationSources,
      lockedTemplateIds,
      packagingLockedIds,
      templateCreationReady,
      inheritedAiRuns,
    );
  }

  async createAiRun(
    projectId: string,
    sourceWorkflowRunId: string,
    templateId: string,
    expectedRevision: number,
    idempotencyKey: string,
    targetVariantId?: string,
    refreshAffectedSlots = false,
  ): Promise<EffectTemplateMixAiRun> {
    // Re-filling is a full update. It has to run in an unpublished child so the published mix
    // result is never mutated in place. Every successful fill is a version of its own, so this
    // forks even for the first one — there is no user-visible validation to promote it later.
    const edit = await this.working.beginEffectNodeEdit(
      projectId,
      sourceWorkflowRunId,
      'TEMPLATE_MIX',
      'BATCH',
      { always: true },
    );
    const workflowRunId = edit.run.id;
    const [nodeState, artifacts, previousRuns, packagingLockedIds, inheritedRuns] = await Promise.all([
      this.working.getNodeState(projectId, workflowRunId, 'TEMPLATE_MIX'),
      this.aiRuns!.sourceArtifacts(projectId, workflowRunId),
      this.aiRuns!.listRecent(projectId, workflowRunId),
      this.aiRuns?.packagedTemplateIds?.(projectId, workflowRunId) ?? Promise.resolve([]),
      this.aiRuns?.inheritedMixAiRuns?.(projectId, workflowRunId) ?? Promise.resolve([]),
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
    entry!.packagingLocked = packagingLockedIds.includes(templateId);
    const target = targetVariantId
      ? entry!.workspace.variants.find(({ id }) => id === targetVariantId)
      : undefined;
    if (targetVariantId && !target) this.notFound('当前成片工程不存在');
    if (refreshAffectedSlots && !target)
      throw new ApiHttpException(
        '更新已替换素材需要指定已有成片工程',
        HttpStatus.BAD_REQUEST,
        'VALIDATION_ERROR',
      );
    if (entry!.packagingLocked && !refreshAffectedSlots)
      throw new ApiHttpException(
        '智能成片包装已开始，此模板不能重新智能填充',
        HttpStatus.CONFLICT,
        'CONFLICT',
      );
    const slots = entry!.workspace.template.slots;
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
      { prompt: string; promptSummary?: string; artifact: (typeof promptArtifacts)[number] }
    >();
    for (const artifact of promptArtifacts) {
      const items = object(artifact.payload)?.items;
      if (!Array.isArray(items)) continue;
      for (const raw of items) {
        const item = object(raw);
        if (
          typeof item?.id === 'string' &&
          typeof item.content === 'string' &&
          item.content.trim()
        ) {
          const promptSummary =
            typeof item.creativeCore === 'string' && item.creativeCore.trim()
              ? item.creativeCore.trim()
              : undefined;
          promptById.set(item.id, {
            prompt: item.content,
            ...(promptSummary ? { promptSummary } : {}),
            artifact,
          });
        }
      }
    }
    const renderCandidates = artifacts.filter(
      (artifact) =>
        artifact.nodeId === 'SEGMENT_RENDER' && artifact.artifactKey.startsWith('render-clip:'),
    );
    const { artifacts: renderArtifacts, canonicalIdById } = distinctRenderFiles(
      renderCandidates,
      new Set([
        ...(target ? boundMaterialIds([target]) : []),
        ...Object.keys(entry!.materialRoleOverrides ?? {}),
      ]),
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
        ...(prompt.promptSummary ? { promptSummary: prompt.promptSummary } : {}),
        artifactId: artifact.id,
        artifactKey: artifact.artifactKey,
        artifactRevision: artifact.revision,
        contentHash: artifact.contentHash,
        fileObjectId: renderFileKey(artifact),
      });
    }
    if (materials.length !== renderArtifacts.length)
      throw new ApiHttpException(
        '部分视频片段无法精确回连原始 Prompt 或缺少可用视频文件，请先返回视频渲染节点检查',
        HttpStatus.BAD_REQUEST,
        'VALIDATION_ERROR',
      );
    const materialById = new Map(materials.map((item) => [item.id, item]));
    const classificationRuns = [
      ...previousRuns,
      ...inheritedRuns.flatMap((run) => {
        const remapped = remapInheritedFill(run, artifacts, materials);
        return remapped ? [remapped] : [];
      }),
    ];
    const priorClassifications = new Map<string, EffectTemplateMixAiClassification>();
    let priorItems: EffectTemplateMixClassificationPool['items'] = [];
    const currentSources = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
    for (const previous of classificationRuns) {
      if (
        previous.status !== 'COMPLETED' ||
        previous.templateId !== templateId ||
        !Array.isArray(previous.classificationResult)
      )
        continue;
      const frozen = previous.inputSnapshot as unknown as EffectTemplateMixAiSnapshot;
      const rows = previous.classificationResult as unknown as EffectTemplateMixAiClassification[];
      if (
        !frozen ||
        !Array.isArray(frozen.materials) ||
        !Array.isArray(frozen.template?.slots) ||
        classificationSlotSignature(frozen.template.slots) !== classificationSlotSignature(slots) ||
        !classificationsValid(frozen, rows, true) ||
        workflowStateHash(frozen.materials.map((item) => item.fileObjectId).sort()) !==
          workflowStateHash(materials.map((item) => item.fileObjectId).sort()) ||
        frozen.materials.some(
          (item) =>
            currentSources.get(item.id)?.revision !== item.artifactRevision ||
            currentSources.get(item.id)?.contentHash !== item.contentHash,
        ) ||
        frozen.promptArtifacts.some(
          (item) =>
            currentSources.get(item.id)?.revision !== item.revision ||
            currentSources.get(item.id)?.contentHash !== item.contentHash,
        )
      )
        continue;
      const pools = buildAssignedPools(
        slots,
        materials.map((item) => ({ ...item, available: true })),
        rows,
        new Set(),
        frozen.materialRoleAssignments,
      );
      priorItems = [...pools.entries()].flatMap(([role, pool]) =>
        pool.map((item) => ({ materialId: item.materialId, role, matchScore: item.matchScore })),
      );
      for (const row of rows) priorClassifications.set(row.materialId, row);
      break;
    }
    const effectiveRoles = resolveEffectTemplateMixMaterialRoles(
      priorItems,
      entry!.materialRoleOverrides,
    );
    const materialRoleAssignments: Record<string, EffectTemplateMixRole> = {};
    const manualMaterialRoles: Record<string, EffectTemplateMixRole> = {};
    for (const [id, item] of effectiveRoles) {
      const canonicalId = canonicalIdById.get(id);
      const material = canonicalId ? materialById.get(canonicalId) : undefined;
      const slot = slots.find((candidate) => candidate.role === item.role);
      if (!material || !slot || material.duration + 0.001 < slot.duration) {
        if (item.source !== 'MANUAL') continue;
        throw new ApiHttpException(
          `手动归槽素材「${material?.code ?? '已失效素材'}」不满足「${slot?.label ?? '目标槽位'}」的来源或时长要求，请重新归槽`,
          HttpStatus.BAD_REQUEST,
          'VALIDATION_ERROR',
        );
      }
      materialRoleAssignments[material.id] = item.role;
      if (item.source === 'MANUAL') manualMaterialRoles[material.id] = item.role;
    }
    const refreshBindings = refreshAffectedSlots
      ? slots.flatMap((slot) => {
          const previousSlot = target?.slots.find(({ id }) => id === slot.id);
          const sourceSlotId = previousSlot?.id;
          const materialId = sourceSlotId ? target?.bindings[sourceSlotId] : undefined;
          const material = materialId
            ? materialById.get(canonicalIdById.get(materialId) ?? '')
            : undefined;
          const previousRevision = sourceSlotId
            ? target?.bindingRevisions[sourceSlotId]
            : undefined;
          if (
            !sourceSlotId ||
            !material ||
            (Number.isInteger(previousRevision) &&
              material.artifactRevision <= (previousRevision ?? 0))
          )
            return [];
          if (slot.duration > material.duration + 0.001)
            throw new ApiHttpException(
              `「${slot.label}」的新素材长度不足以保留原槽位时长，请先调整模板时长`,
              HttpStatus.CONFLICT,
              'CONFLICT',
            );
          return [
            {
              slotId: slot.id,
              materialId: material.id,
              artifactRevision: material.artifactRevision,
            },
          ];
        })
      : [];
    if (refreshAffectedSlots && !refreshBindings.length)
      throw new ApiHttpException(
        '当前成片没有已完成校验的新素材需要更新',
        HttpStatus.CONFLICT,
        'CONFLICT',
      );
    const refreshSlotIds = new Set(refreshBindings.map(({ slotId }) => slotId));
    const lockedSlotIds = refreshAffectedSlots
      ? slots.filter(({ id }) => !refreshSlotIds.has(id)).map(({ id }) => id)
      : (target?.manualSlotIds ?? []);
    const lockedBindings = lockedSlotIds.flatMap((slotId) => {
      const oldSlot = target?.slots.find(({ id }) => id === slotId);
      const slot = slots.find(({ id, role }) => id === slotId || role === oldSlot?.role);
      const materialId = target?.bindings[slotId];
      const material = materialId
        ? materialById.get(canonicalIdById.get(materialId) ?? '')
        : undefined;
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
    if (refreshAffectedSlots && lockedBindings.length !== slots.length - refreshBindings.length)
      throw new ApiHttpException(
        '当前工程还有其他素材位已过期或不满足原截取范围，请先单独处理这些素材位',
        HttpStatus.CONFLICT,
        'CONFLICT',
      );
    const unlockedSlots = slots.filter(
      (slot) => !lockedBindings.some((binding) => binding.slotId === slot.id),
    );
    const lockedIds = new Set(lockedBindings.map(({ materialId }) => materialId));
    const existingVariantBindings = entry!.workspace.variants
      .filter((variant) => variant.id !== targetVariantId)
      .map((variant) =>
        slots
          .map((slot) => ({
            slotId: slot.id,
            materialId: canonicalIdById.get(variant.bindings[slot.id] ?? '') ?? '',
          }))
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
        slots: slots.map(({ id, role, label, duration, transition, transitionDuration }) => ({
          id,
          role,
          label,
          duration,
          transition,
          transitionDuration,
        })),
      },
      draftRevision: expectedRevision,
      workspaceHash: workflowStateHash(entry!.workspace),
      materialRoleAssignments,
      manualMaterialRoles,
      materialRoleEditVersion: entry!.materialRoleEditVersion ?? 0,
      targetVariantId: targetVariantId ?? null,
      ...(refreshAffectedSlots ? { trimOnly: true, refreshBindings } : {}),
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
    for (const previous of classificationRuns) {
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
      const manualRole = manualMaterialRoles[material.id];
      if (manualRole)
        return [
          {
            materialId: material.id,
            source: 'MANUAL' as const,
            scores: Object.fromEntries(
              AI_MIX_ROLES.map((role) => [role, role === manualRole ? 1 : 0]),
            ) as Record<EffectTemplateMixRole, number>,
            reasons: { [manualRole]: '用户手动归槽' },
          },
        ];
      if (
        Object.entries(entry!.materialRoleOverrides ?? {}).some(
          ([id, role]) => role === null && canonicalIdById.get(id) === material.id,
        )
      )
        return [];
      const cached =
        cachedClassifications.get(material.id) ??
        (materialRoleAssignments[material.id] ? priorClassifications.get(material.id) : undefined);
      return cached && cached.source !== 'MANUAL' ? [cached] : [];
    });
    const boundTargetSelections = refreshAffectedSlots
      ? refreshBindings.flatMap((binding) => {
          const slot = slots.find(({ id }) => id === binding.slotId);
          const oldSlot = target?.slots.find(({ id }) => id === binding.slotId);
          const metadata = target?.bindingMetadata?.[binding.slotId];
          if (!slot || !oldSlot) return [];
          const score = Number(metadata?.matchScore ?? 0.7);
          return [
            {
              slotId: binding.slotId,
              role: slot.role,
              materialId: binding.materialId,
              matchScore: Number.isFinite(score) ? Math.max(0, Math.min(1, score)) : 0.7,
              matchLevel:
                metadata?.matchLevel === 'LOW_MATCH' ? ('LOW_MATCH' as const) : ('NORMAL' as const),
              classificationReason:
                metadata?.classificationReason ?? '保留原槽位素材归属，仅重新分析截取起点',
              duration: slot.duration,
            },
          ];
        })
      : target
        ? unlockedSlots.flatMap((slot) => {
            const oldSlot = target.slots.find(
              ({ id, role }) => id === slot.id || role === slot.role,
            );
            const materialId = oldSlot ? target.bindings[oldSlot.id] : undefined;
            if (!materialId || !materialById.has(materialId)) return [];
            const metadata = target.bindingMetadata?.[oldSlot!.id];
            const classification = cachedClassifications.get(materialId);
            const matchScore = Number(
              metadata?.matchScore ?? classification?.scores[slot.role] ?? 0.7,
            );
            return [
              {
                slotId: slot.id,
                role: slot.role,
                materialId,
                matchScore: Number.isFinite(matchScore)
                  ? Math.max(0, Math.min(1, matchScore))
                  : 0.7,
                matchLevel:
                  metadata?.matchLevel === 'LOW_MATCH'
                    ? ('LOW_MATCH' as const)
                    : ('NORMAL' as const),
                classificationReason: String(
                  metadata?.classificationReason ??
                    classification?.reasons[slot.role] ??
                    '复用当前成片已有槽位归属',
                ),
                duration: slot.duration,
              },
            ];
          })
        : [];
    const preserveExistingAssignments = Boolean(
      target && unlockedSlots.length > 0 && boundTargetSelections.length === unlockedSlots.length,
    );
    // Keeping the current slot assignment needs the classification that produced it. A fill always
    // lands on a branch of its own, and cloning re-identifies the materials, so that history is
    // normally gone by the time the fill runs. It then classifies and assigns from scratch instead of
    // refusing: a fresh fill cannot overwrite the result the user already has — it is a new branch.
    // The trim-only refresh is exempt, because it keeps the assignment on purpose and only recomputes
    // the trims of the slots whose source material was replaced.
    const reuseExistingAssignments =
      preserveExistingAssignments &&
      boundTargetSelections.every(
        (selection) =>
          !snapshot.manualMaterialRoles?.[selection.materialId] ||
          snapshot.manualMaterialRoles[selection.materialId] === selection.role,
      ) &&
      (refreshAffectedSlots || reusableClassifications.length === snapshot.materials.length);
    const initialSelections = reuseExistingAssignments ? boundTargetSelections : [];
    const executionHash = (value: EffectTemplateMixAiSnapshot): string => {
      const { draftRevision: _draftRevision, workspaceHash: _workspaceHash, ...inputs } = value;
      return workflowStateHash(inputs);
    };
    const inputHash = executionHash(snapshot);
    const reusableCheckpoint = previousRuns
      .filter((previous) => {
        if (
          previous.status !== 'FAILED' ||
          !Array.isArray(previous.classificationResult) ||
          !Array.isArray(previous.selectionResult) ||
          !Array.isArray(previous.trimResult)
        )
          return false;
        const previousSnapshot = previous.inputSnapshot as unknown as EffectTemplateMixAiSnapshot;
        if (
          !previousSnapshot ||
          !Array.isArray(previousSnapshot.materials) ||
          !Array.isArray(previousSnapshot.promptArtifacts) ||
          !Array.isArray(previousSnapshot.template?.slots)
        )
          return false;
        return (
          executionHash(previousSnapshot) === inputHash &&
          classificationsValid(
            previousSnapshot,
            previous.classificationResult as EffectTemplateMixAiClassification[],
            true,
          ) &&
          trimsValid(
            previousSnapshot,
            previous.selectionResult as EffectTemplateMixAiSelection[],
            previous.trimResult as EffectTemplateMixAiTrim[],
            false,
          )
        );
      })
      .sort(
        (left, right) =>
          (right.trimResult as unknown[]).length - (left.trimResult as unknown[]).length,
      )[0];
    const requestHash = workflowStateHash({
      workflowRunId,
      templateId,
      targetVariantId: targetVariantId ?? null,
      refreshAffectedSlots,
      expectedRevision,
    });
    const initialClassifications = refreshAffectedSlots
      ? []
      : reusableCheckpoint
        ? (reusableCheckpoint.classificationResult as unknown[])
        : reusableClassifications;
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
      ...(initialClassifications.length ? { initialClassifications } : {}),
      ...(initialSelections.length ? { initialSelections } : {}),
      ...(!refreshAffectedSlots && reusableCheckpoint
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
    if (created.kind === 'PACKAGING_LOCKED')
      throw new ApiHttpException(
        '智能成片包装已开始，此模板不能重新智能填充',
        HttpStatus.CONFLICT,
        'CONFLICT',
      );
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
        snapshot.materialRoleAssignments,
      );
      if (selections.length !== slots.length)
        throw new ApiHttpException(
          '部分槽位归槽素材不足，无法完成重新智能填充',
          HttpStatus.BAD_REQUEST,
          'VALIDATION_ERROR',
        );
    } else {
      const pools = buildAssignedPools(
        slots,
        materials,
        classifications,
        new Set(),
        snapshot.materialRoleAssignments,
      );
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
        undefined,
        snapshot.materialRoleAssignments,
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
    checkpoint: {
      samples?: EffectTemplateMixSampledMaterial[];
      materialIds?: string[];
    },
  ): Promise<{ materialIds: string[]; samples: EffectTemplateMixSampledMaterial[] }> {
    const run = await this.aiRuns!.find(projectId, runId);
    if (!run || run.status !== 'RUNNING' || run.attemptToken !== attemptToken)
      throw new ApiHttpException('智能填充任务租约已失效', HttpStatus.CONFLICT, 'CONFLICT');
    const selections = Array.isArray(run.selectionResult)
      ? (run.selectionResult as EffectTemplateMixAiSelection[])
      : [];
    const snapshotMaterials = object(run.inputSnapshot)?.materials;
    const materialById = new Map(
      Array.isArray(snapshotMaterials)
        ? snapshotMaterials
            .map((value) => object(value))
            .filter((value): value is Record<string, unknown> => typeof value?.id === 'string')
            .map((value) => [value.id as string, value])
        : [],
    );
    const samples = checkpoint.samples ?? [];
    const materialIds =
      checkpoint.samples?.map(({ materialId }) => materialId) ?? checkpoint.materialIds ?? [];
    const selectedIds = new Set(selections.map(({ materialId }) => materialId));
    if (
      !Array.isArray(materialIds) ||
      materialIds.length < 1 ||
      materialIds.length > selections.length ||
      new Set(materialIds).size !== materialIds.length ||
      materialIds.some((id) => !selectedIds.has(id)) ||
      samples.some((sample) => {
        const sourceDuration = Number(materialById.get(sample.materialId)?.duration);
        return (
          !Number.isFinite(sourceDuration) ||
          sourceDuration <= 0 ||
          !sample.frameTimestampsSeconds.length ||
          sample.frameTimestampsSeconds.some(
            (timestamp, index, timestamps) =>
              !Number.isFinite(timestamp) ||
              timestamp < 0 ||
              timestamp >= sourceDuration ||
              (index > 0 && timestamp <= timestamps[index - 1]!),
          )
        );
      })
    )
      throw new ApiHttpException('关键帧进度分片无效', HttpStatus.BAD_REQUEST, 'VALIDATION_ERROR');
    const saved = await this.aiRuns!.saveSamplingCheckpoint(
      projectId,
      runId,
      attemptToken,
      samples.length ? samples : materialIds,
    );
    if (saved.kind === 'LEASE_CONFLICT')
      throw new ApiHttpException('智能填充任务租约已失效', HttpStatus.CONFLICT, 'CONFLICT');
    if (saved.kind === 'INVALID_MATERIAL')
      throw new ApiHttpException(
        '关键帧素材不属于本次匹配结果',
        HttpStatus.BAD_REQUEST,
        'VALIDATION_ERROR',
      );
    return { materialIds: saved.materialIds, samples: saved.samples };
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
    if (
      !snapshot.trimOnly &&
      (!Array.isArray(classifications) || !classificationsValid(snapshot, classifications, true))
    )
      throw new ApiHttpException('Prompt 归槽结果缺失或无效', HttpStatus.CONFLICT, 'CONFLICT');
    if (snapshot.trimOnly) {
      const expected = snapshot.refreshBindings ?? [];
      if (
        !snapshot.targetVariantId ||
        !expected.length ||
        selections.length !== expected.length ||
        expected.some(
          ({ slotId, materialId }) =>
            !selections.some(
              (selection) => selection.slotId === slotId && selection.materialId === materialId,
            ),
        )
      )
        throw new ApiHttpException(
          '素材截取更新结果与待更新槽位不一致',
          HttpStatus.CONFLICT,
          'CONFLICT',
        );
    }
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
    const draft = draftOf(nodeState.state);
    const entry = draft.templates.find(({ id }) => id === snapshot.template.id);
    if (
      snapshot.workspaceHash
        ? !entry || workflowStateHash(entry.workspace) !== snapshot.workspaceHash
        : nodeState.revision !== snapshot.draftRevision
    )
      throw new ApiHttpException(
        '混剪草稿已变化，旧任务不会覆盖当前编辑',
        HttpStatus.CONFLICT,
        'CONFLICT',
      );
    entry!.aiFillLocked = false;
    entry!.filledTemplateHash = templateConfigurationHash(entry!.workspace.template);
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
    const currentClipFiles = [
      ...new Set(
        currentSources
          .filter(
            (source) =>
              source.nodeId === 'SEGMENT_RENDER' && source.artifactKey.startsWith('render-clip:'),
          )
          .map(renderFileKey),
      ),
    ].sort();
    const snapshotClipFiles = snapshot.materials.map(({ fileObjectId }) => fileObjectId).sort();
    const legacyDuplicateSnapshot = new Set(snapshotClipFiles).size !== snapshotClipFiles.length;
    const currentClipIds = legacyDuplicateSnapshot
      ? currentSources
          .filter(
            (source) =>
              source.nodeId === 'SEGMENT_RENDER' && source.artifactKey.startsWith('render-clip:'),
          )
          .map(({ id }) => id)
          .sort()
      : [];
    const snapshotClipIds = legacyDuplicateSnapshot
      ? snapshot.materials.map(({ artifactId }) => artifactId).sort()
      : [];
    if (
      !sourcesCurrent ||
      (legacyDuplicateSnapshot
        ? workflowStateHash(currentClipIds) !== workflowStateHash(snapshotClipIds)
        : workflowStateHash(currentClipFiles) !== workflowStateHash(snapshotClipFiles))
    )
      throw new ApiHttpException(
        'Prompt 或视频片段已变化，旧任务不会覆盖当前编辑',
        HttpStatus.CONFLICT,
        'CONFLICT',
      );
    if (!entry) this.notFound('当前混剪模板不存在');
    const currentTarget = snapshot.targetVariantId
      ? entry!.workspace.variants.find(({ id }) => id === snapshot.targetVariantId)
      : undefined;
    const currentSlots = entry!.workspace.template.slots;
    const snapshotHasTransitions = snapshot.template.slots.every(
      (slot) => typeof slot.transition === 'string',
    );
    const currentSlotConfiguration = currentSlots.map(
      ({ id, role, label, duration, transition, transitionDuration }) => ({
        id,
        role,
        label,
        duration,
        ...(snapshotHasTransitions
          ? { transition, transitionDuration: transitionDuration ?? null }
          : {}),
      }),
    );
    if (
      entry!.workspace.template.editVersion !== snapshot.template.editVersion ||
      workflowStateHash(currentSlotConfiguration) !==
        workflowStateHash(
          snapshot.template.slots.map((slot) => ({
            id: slot.id,
            role: slot.role,
            label: slot.label,
            duration: slot.duration,
            ...(snapshotHasTransitions
              ? { transition: slot.transition, transitionDuration: slot.transitionDuration ?? null }
              : {}),
          })),
        )
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
    const savedSelections = Array.isArray(run.selectionResult)
      ? (run.selectionResult as EffectTemplateMixAiSelection[])
      : [];
    const variantSelections: EffectTemplateMixAiSelection[][] = snapshot.targetVariantId
      ? [savedSelections.filter(({ slotId }) => !lockedSlotIds.has(slotId))]
      : enumerateAssignedVariants(
          unlockedSlots,
          materials,
          classifications,
          snapshot.existingVariantBindings ?? [],
          snapshot.maxOutputVariants ?? 0,
          undefined,
          snapshot.materialRoleAssignments,
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
          appliedTemplateHash: templateConfigurationHash(entry!.workspace.template),
        };
        entry!.workspace.variants.push(variant);
      }
      if (snapshot.targetVariantId) {
        const oldSlots = variant.slots;
        const remap = new Map(
          oldSlots.flatMap((oldSlot) => {
            const nextSlot = entry!.workspace.template.slots.find(
              ({ id, role }) => id === oldSlot.id || role === oldSlot.role,
            );
            return nextSlot ? [[oldSlot.id, nextSlot.id] as const] : [];
          }),
        );
        const remapRecord = <T>(record: Record<string, T>): Record<string, T> =>
          Object.fromEntries(
            Object.entries(record).flatMap(([key, value]) => {
              const nextKey = remap.get(key);
              return nextKey ? [[nextKey, value]] : [];
            }),
          );
        variant.bindings = remapRecord(variant.bindings);
        variant.bindingRevisions = remapRecord(variant.bindingRevisions);
        variant.offsets = remapRecord(variant.offsets);
        variant.bindingMetadata = remapRecord(variant.bindingMetadata ?? {});
        variant.manualSlotIds = variant.manualSlotIds.flatMap((id) =>
          remap.has(id) ? [remap.get(id)!] : [],
        );
        variant.slots = JSON.parse(
          JSON.stringify(entry!.workspace.template.slots),
        ) as EffectTemplateMixSlot[];
        variant.appliedTemplateVersion = entry!.workspace.template.editVersion;
        variant.appliedTemplateHash = templateConfigurationHash(entry!.workspace.template);
        variant.status = 'CURRENT';
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
      snapshot.template.id,
      snapshot.workspaceHash,
    );
    if (completed === 'DRAFT_CONFLICT')
      throw new ApiHttpException(
        '混剪草稿已变化，旧任务不会覆盖当前编辑',
        HttpStatus.CONFLICT,
        'CONFLICT',
      );
    if (completed !== 'COMPLETED')
      throw new ApiHttpException('智能填充任务租约已失效', HttpStatus.CONFLICT, 'CONFLICT');
    await this.confirmFilledMix(projectId, run.workflowRunId, snapshot.template.id);
    return this.aiRun(projectId, runId);
  }

  /**
   * A smart fill is a paid regeneration of the mix node, so the template and timelines it just wrote
   * are this Run's confirmed mix version from that moment on — the same way a finished render batch
   * is the render node's version. Confirming them here is what turns the branch tree's draft into a
   * version instead of a pending draft, and it is also what gives the next step (packaging) a
   * published version to fork from. Publishing opens its own transaction, so it has to run after the
   * draft write commits; an unchanged fill falls back to its parent instead of opening a branch.
   */
  private async confirmFilledMix(
    projectId: string,
    workflowRunId: string,
    templateId: string,
  ): Promise<void> {
    const nodeState = await this.working.getNodeState(projectId, workflowRunId, 'TEMPLATE_MIX');
    const { inputs } = await this.prepareValidation(
      projectId,
      workflowRunId,
      nodeState.revision,
      templateId,
      { partial: true },
    );
    await this.working.commitValidatedArtifacts(projectId, workflowRunId, 'TEMPLATE_MIX', inputs);
    await this.working.publishEffectNodeEdit(projectId, workflowRunId, 'TEMPLATE_MIX');
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
        throw new ApiHttpException(
          '新成片槽位时长必须为 4–15 秒',
          HttpStatus.BAD_REQUEST,
          'VALIDATION_ERROR',
        );
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
    return this.mutate(
      projectId,
      workflowRunId,
      expectedRevision,
      templateId,
      (workspace) => {
        if (!slotsValid(workspace.template.slots, 4))
          throw new ApiHttpException(
            '新成片槽位时长必须为 4–15 秒',
            HttpStatus.BAD_REQUEST,
            'VALIDATION_ERROR',
          );
        workspace.variants.push(createEmptyVariant(workspace));
        workspace.editVersion += 1;
      },
      { allowPackagingLocked: true },
    );
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
        throw new ApiHttpException(
          '智能填充槽位时长必须为 4–15 秒',
          HttpStatus.BAD_REQUEST,
          'VALIDATION_ERROR',
        );
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
        throw new ApiHttpException(
          '同步模板的槽位时长必须为 4–15 秒',
          HttpStatus.BAD_REQUEST,
          'VALIDATION_ERROR',
        );
      applyVariantToTemplate(workspace, variant!, syncOtherVariants);
    });
  }

  async prepareValidation(
    projectId: string,
    workflowRunId: string,
    expectedRevision: number,
    templateId: string,
    options: { partial?: boolean } = {},
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
      variants.length < 1
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
    const confirmed: EffectTemplateMixVariant[] = [];
    for (const variant of variants) {
      // A partial pass is how a smart fill confirms itself: the timeline it just filled is the
      // version, and a sibling the user has not finished editing must not veto that.
      const used = new Set<string>();
      try {
        this.validateVariant(variant, sources, used);
      } catch (error) {
        if (!options.partial) throw error;
        continue;
      }
      for (const sourceId of used) allSourceIds.add(sourceId);
      confirmed.push(variant);
    }
    if (!confirmed.length)
      throw new ApiHttpException(
        '成片工程仍有素材缺口或槽位配置无效',
        HttpStatus.BAD_REQUEST,
        'VALIDATION_ERROR',
      );
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
      // A timeline consumes confirmed rendered clips, not the entire Prompt batch.
      // The renderer marks only clips whose exact Prompt input changed as stale;
      // carrying the batch-level dependency here would invalidate every variant
      // when a single Prompt changes.
      return renderDependencies;
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
        metadata: { templateId, variantCount: confirmed.length },
        dependencies: dependenciesFor(allSourceIds),
      },
    });
    for (const variant of confirmed) {
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
    return { inputs, variants: confirmed };
  }

  async validate(
    projectId: string,
    workflowRunId: string,
    expectedRevision: number,
    templateId: string,
  ): Promise<ValidateEffectTemplateMixData> {
    const { inputs, variants } = await this.prepareValidation(
      projectId,
      workflowRunId,
      expectedRevision,
      templateId,
    );
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
    options: { allowPackagingLocked?: boolean } = {},
  ): Promise<EffectTemplateMixWorkspaceData> {
    const [
      nodeState,
      artifactData,
      aiRuns,
      classificationSources,
      lockedTemplateIds,
      packagingLockedIds,
      inheritedAiRuns,
    ] = await Promise.all([
      this.working.getNodeState(projectId, workflowRunId, 'TEMPLATE_MIX'),
      this.working.listArtifacts(projectId, { workflowRunId }),
      this.aiRuns?.listRecent(projectId, workflowRunId) ?? Promise.resolve([]),
      this.aiRuns?.sourceArtifacts(projectId, workflowRunId) ?? Promise.resolve([]),
      this.aiRuns?.lockedTemplateIds?.(projectId, workflowRunId) ?? Promise.resolve([]),
      this.aiRuns?.packagedTemplateIds?.(projectId, workflowRunId) ?? Promise.resolve([]),
      this.aiRuns?.inheritedMixAiRuns?.(projectId, workflowRunId) ?? Promise.resolve([]),
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
    const addingEmptyProjectAfterPackaging =
      options.allowPackagingLocked && packagingLockedIds.includes(templateId);
    if (
      (lockedTemplateIds.includes(templateId) && !addingEmptyProjectAfterPackaging) ||
      (!options.allowPackagingLocked && packagingLockedIds.includes(templateId))
    )
      throw new ApiHttpException(
        packagingLockedIds.includes(templateId)
          ? '智能成片包装已开始，此模板不能再修改'
          : '智能填充正在运行，此模板暂时不能修改',
        HttpStatus.CONFLICT,
        'CONFLICT',
      );
    const workspace: EffectTemplateMixWorkspace = {
      ...entry!.workspace,
      materials: materialsFromArtifacts(
        artifactData.items,
        boundMaterialIds(entry!.workspace.variants),
      ),
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
    const templateCreationReady = await this.templateCreationReady(
      projectId,
      workflowRunId,
      artifactData.items,
    );
    return this.toWorkspaceData(
      draft,
      saved.nodeState.revision,
      artifactData.items,
      aiRuns,
      classificationSources,
      lockedTemplateIds,
      packagingLockedIds,
      templateCreationReady,
      inheritedAiRuns,
    );
  }

  private toWorkspaceData(
    draft: EffectTemplateMixDraft,
    draftRevision: number | null,
    artifacts: WorkingArtifact[],
    aiRunRecords: EffectTemplateMixAiRunRecord[] = [],
    classificationSources: EffectTemplateMixClassificationSource[] = [],
    lockedTemplateIds: string[] = [],
    packagingLockedIds: string[] = [],
    templateCreationReady = false,
    inheritedAiRuns: EffectTemplateMixAiRunRecord[] = [],
  ): EffectTemplateMixWorkspaceData {
    const materials = materialsFromArtifacts(
      artifacts,
      boundMaterialIds(draft.templates.flatMap((entry) => entry.workspace.variants)),
    );
    const availableMaterialIds = new Set(
      materials.filter(({ available }) => available).map(({ id }) => id),
    );
    const lockedSet = new Set(lockedTemplateIds);
    const packagedSet = new Set(packagingLockedIds);
    const workspaceDraft: EffectTemplateMixDraft = {
      ...draft,
      templates: draft.templates.map((entry) => {
        const filledTemplateHash = this.filledHashForEntry(entry, aiRunRecords);
        const packagingLocked = packagedSet.has(entry.id);
        const aiFillLocked = lockedSet.has(entry.id);
        const needsAiFill = this.needsRefill(entry, filledTemplateHash, availableMaterialIds);
        return {
          ...entry,
          ...(filledTemplateHash ? { filledTemplateHash } : {}),
          aiFillLocked,
          packagingLocked,
          needsAiFill,
        };
      }),
    };
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
    // This Run's own fills come first: a branch that re-filled shows what it ran, and only falls
    // back to what it inherited for the templates it left alone.
    const poolRuns = [
      ...aiRunRecords,
      ...inheritedAiRuns.flatMap((run) => {
        const remapped = remapInheritedFill(run, artifacts, activeMaterials);
        return remapped ? [remapped] : [];
      }),
    ];
    for (const run of poolRuns) {
      if (
        run.status !== 'COMPLETED' ||
        pooledTemplates.has(run.templateId) ||
        !Array.isArray(run.classificationResult)
      )
        continue;
      const entry = workspaceDraft.templates.find(({ id }) => id === run.templateId);
      const snapshot = run.inputSnapshot as EffectTemplateMixAiSnapshot;
      const classifications = run.classificationResult as EffectTemplateMixAiClassification[];
      const snapshotFiles = snapshot.materials.map(({ fileObjectId }) => fileObjectId);
      const frozenById = new Map(snapshot.materials.map((material) => [material.id, material]));
      const poolByFile = new Map<string, EffectTemplateMixAiSnapshot['materials'][number]>();
      for (const material of activeMaterials) {
        const frozen = frozenById.get(material.id);
        if (frozen && !poolByFile.has(frozen.fileObjectId))
          poolByFile.set(frozen.fileObjectId, frozen);
      }
      const poolSnapshotMaterials = [...poolByFile.values()];
      const poolIds = new Set(poolSnapshotMaterials.map(({ id }) => id));
      const selectedMaterials = activeMaterials.filter(({ id }) => poolIds.has(id));
      if (
        !entry ||
        classificationSlotSignature(entry.workspace.template.slots) !==
          classificationSlotSignature(snapshot.template.slots) ||
        !classificationsValid(snapshot, classifications, true) ||
        new Set(snapshotFiles).size !== selectedMaterials.length ||
        workflowStateHash(
          [...new Set(activeMaterials.map(({ fileObjectId }) => fileObjectId))].sort(),
        ) !== workflowStateHash([...new Set(snapshotFiles)].sort()) ||
        poolSnapshotMaterials.some((frozen) => {
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
      const pools = buildAssignedPools(
        entry.workspace.template.slots,
        selectedMaterials,
        classifications.filter(({ materialId }) => poolIds.has(materialId)),
        new Set(),
        snapshot.materialRoleAssignments,
      );
      classificationPools.push({
        templateId: run.templateId,
        runId: run.id,
        templateEditVersion: entry.workspace.template.editVersion,
        items: AI_MIX_ROLES.flatMap((role) =>
          (pools.get(role) ?? [])
            .map((item) => ({
              materialId: item.materialId,
              role,
              matchScore: item.matchScore,
              ...(classifications.find((row) => row.materialId === item.materialId)?.source ===
              'MANUAL'
                ? { source: 'MANUAL' as const }
                : {}),
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
      draft: workspaceDraft,
      draftRevision,
      templateCreationReady,
      materials,
      commits,
      aiRuns: aiRunRecords.map(toAiRun),
      classificationPools,
    };
  }

  private filledHashForEntry(
    entry: EffectTemplateMixDraft['templates'][number],
    aiRunRecords: EffectTemplateMixAiRunRecord[],
  ): string | undefined {
    if (entry.filledTemplateHash) return entry.filledTemplateHash;
    const latestSuccessful = aiRunRecords.find(
      (run) => run.templateId === entry.id && run.status === 'COMPLETED',
    );
    const snapshot = latestSuccessful?.inputSnapshot as EffectTemplateMixAiSnapshot | undefined;
    if (!snapshot?.template?.slots?.length) return undefined;
    const hasFullConfig = snapshot.template.slots.every(
      (slot) => typeof slot.transition === 'string',
    );
    const sameLegacyVersion =
      snapshot.template.editVersion === entry.workspace.template.editVersion;
    if (!hasFullConfig)
      return sameLegacyVersion
        ? templateConfigurationHash(entry.workspace.template)
        : `legacy-stale:${snapshot.template.editVersion}`;
    return workflowStateHash({
      name: snapshot.template.name.trim(),
      slots: snapshot.template.slots.map((slot) => ({
        id: slot.id,
        role: slot.role,
        label: slot.label,
        duration: slot.duration,
        transition: slot.transition ?? '硬切',
        transitionDuration: slot.transitionDuration ?? null,
      })),
    });
  }

  private needsRefill(
    entry: EffectTemplateMixDraft['templates'][number],
    filledTemplateHash: string | undefined,
    availableMaterialIds?: ReadonlySet<string>,
  ): boolean {
    const currentHash = templateConfigurationHash(entry.workspace.template);
    if (filledTemplateHash && currentHash !== filledTemplateHash) return true;
    return entry.workspace.variants.some((variant) => {
      if (!Object.values(variant.bindings).some(Boolean)) return false;
      if (
        availableMaterialIds &&
        Object.values(variant.bindings).some(
          (materialId) => materialId && !availableMaterialIds.has(materialId),
        )
      )
        return true;
      if (!filledTemplateHash) return false;
      return variant.appliedTemplateHash
        ? variant.appliedTemplateHash !== currentHash
        : variant.appliedTemplateVersion !== entry.workspace.template.editVersion;
    });
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
        !Number.isInteger(variant.bindingRevisions[slot.id]) ||
        variant.bindingRevisions[slot.id] !== source.revision ||
        used.has(renderFileKey(source)) ||
        !Number.isFinite(offset) ||
        offset < 0 ||
        offset + slot.duration > clipDuration(source) + 0.001
      ) {
        throw new ApiHttpException(
          '成片工程引用了缺失、待重新分析截取区间、重复或时长不足的素材',
          HttpStatus.CONFLICT,
          'CONFLICT',
        );
      }
      used.add(renderFileKey(source));
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
