import type { WorkingArtifactCommitSummary } from './workflow-working';

export type EffectTemplateMixPurpose = 'EFFECT' | 'END_CONVERSION' | 'HOOK' | 'PRODUCT_DISPLAY';
export type EffectTemplateMixRole =
  'END' | 'HOOK' | 'PAIN_POINT' | 'PRODUCT' | 'SELLING_POINT' | 'TRANSFORMATION';
export type EffectTemplateMixTransition =
  | '叠化'
  | '推镜'
  | '闪白'
  | '硬切'
  | '缩放'
  | '左滑'
  | '上推'
  | '擦除'
  | '翻转'
  | '圆形展开'
  | '模糊溶解'
  | '右滑'
  | '下推'
  | '旋转'
  | '百叶窗'
  | '菱形展开'
  | '像素化'
  | '故障'
  | '色差'
  | '波纹'
  | '闪黑'
  | '缩小'
  | '圆形扩散'
  | '线性擦除'
  | '四角汇聚'
  | '分割'
  | '镜像'
  | '翻页'
  | '立方体'
  | '放大模糊'
  | '彩色闪光'
  | '噪点溶解'
  | '液体扭曲'
  | '斜向擦除';
export const EFFECT_TEMPLATE_MIX_TRANSITION_DEFAULT_DURATION = 1;
export type EffectTemplateMixSlot = {
  id: string;
  label: string;
  role: EffectTemplateMixRole;
  purpose: EffectTemplateMixPurpose;
  /** Seconds; timeline boundaries are derived from duration. */
  duration: number;
  transition: EffectTemplateMixTransition;
  /** Seconds of overlap represented by the transition junction; optional for schema-v1 history. */
  transitionDuration?: number;
  /**
   * A clip the user dropped onto a track border. It is picture only: it takes part in the visual
   * timeline (and so covers whatever sits under it) but owns no narration, subtitle or slot
   * description. Only a variant's own extra slots ever set it — a template never has overlays.
   */
  overlay?: boolean;
};
export type EffectTemplateMixMaterial = {
  id: string;
  code: string;
  name: string;
  duration: number;
  purpose: EffectTemplateMixPurpose;
  /** External video duration must never raise the render/Prompt slot-duration ceiling. */
  origin?: 'AI_GENERATED' | 'EXTERNAL_IMPORT';
  compatiblePurposes: EffectTemplateMixPurpose[];
  artifactId: string;
  artifactKey: string;
  artifactRevision: number;
  /** Business payload fingerprint; contentHash below identifies the media bytes. */
  artifactContentHash?: string;
  fileObjectId: string;
  contentHash: string;
  contentUrl: string;
  ratio: string;
  resolution: string;
  available: boolean;
  /** Stable source identity for a render replacement; never infer it from its display name. */
  sourcePromptId?: string;
  /** False for an archived binding retained solely to keep the old timeline playable. */
  activeSource?: boolean;
  /** Explicit deletion published by the authoritative render batch, not temporary unavailability. */
  sourceRemoved?: boolean;
  /** Confirmed replacements/clones of the same source, scoped by the server to this Run. */
  replacesMaterialIds?: string[];
  /** Original Prompt metadata is revealed only from the explicit material action. */
  promptCode?: string;
  promptText?: string;
  promptCreativeCore?: string;
};

export type EffectTemplateMixSourceChange = {
  slotId: string;
  kind?: 'REPLACED' | 'REMOVED';
  material?: EffectTemplateMixMaterial;
  blockedReason?: string;
};
/** One user confirmation freezes replacements and APPEND against the same saved pool. */
export type EffectTemplateMixFrozenSourceContext = {
  confirmationHash?: string;
  protocol: 'FROZEN_RENDER_V1';
  id: string;
  templateHash: string;
  materials: EffectTemplateMixMaterial[];
  promptArtifacts: EffectTemplateMixAiSnapshot['promptArtifacts'];
  addedMaterialIds: string[];
  packageNewVariants: boolean;
  facts: import('./effect-template-mix-packaging').PackagingFact[];
};
/** Mechanical signature shared by the confirmation UI and API; no semantic heuristics. */
export function effectTemplateMixSourceUpdateSignature(
  variants: readonly EffectTemplateMixVariant[], materials: readonly EffectTemplateMixMaterial[],
  addedIds: readonly string[] = [],
): string {
  return JSON.stringify({
    projects: variants.flatMap((variant) => effectTemplateMixSourceChanges(variant, materials).map((change) =>
      [variant.id, change.slotId, change.kind ?? 'REPLACED', change.blockedReason ?? '',
        change.material?.artifactId ?? '', change.material?.artifactRevision ?? 0,
        change.material?.fileObjectId ?? '', change.material?.contentHash ?? ''])).sort((a, b) =>
          JSON.stringify(a).localeCompare(JSON.stringify(b))),
    added: materials.filter((material) => addedIds.includes(material.id)).map((material) =>
      [material.artifactId, material.artifactRevision, material.fileObjectId, material.contentHash])
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  });
}
export type EffectTemplateMixSourcesData = {
  /** Published generation ratio, independent of the mutable next-generation settings draft. */
  renderAspectRatio?: string | null;
  autoPackagingTemplateIds?: string[];
  materials: EffectTemplateMixMaterial[];
  draftRevision: number | null;
  /** Exact draft source dependencies, including new-id replacements not caught by old edges. */
  pendingProjectCount?: number;
  /** Additions to each template's last successfully consumed pool; not changed old bindings. */
  pendingAddedMaterialIds?: Record<string, string[]>;
  /** Purpose assignments projected onto the current render sources, never historical trims. */
  classificationPools?: EffectTemplateMixClassificationPool[];
};

/** Compare exact render provenance, including replacements that have a new artifact id. */
export function effectTemplateMixSourceChanges(
  variant: EffectTemplateMixVariant,
  materials: readonly EffectTemplateMixMaterial[],
): EffectTemplateMixSourceChange[] {
  return variant.slots.flatMap((slot): EffectTemplateMixSourceChange[] => {
    const boundId = variant.bindings[slot.id];
    if (!boundId) return [];
    const currentBinding = materials.find((material) => material.id === boundId);
    const adopted = variant.bindingSources?.[slot.id];
    const previous = adopted?.id === boundId ? adopted : currentBinding;
    if (!previous)
      return [{ slotId: slot.id, blockedReason: '原素材来源无法确认，请手动替换素材' }];
    if (!adopted && previous.available && previous.activeSource !== false && !previous.sourceRemoved) {
      const revision = variant.bindingRevisions[slot.id];
      if (typeof revision === 'number' && previous.artifactRevision === revision) return [];
      return previous.duration + 0.001 < slot.duration
        ? [{ slotId: slot.id, blockedReason: '新素材时长不足以保留当前片段长度' }]
        : [{ slotId: slot.id, material: previous }];
    }
    const candidates = materials.filter(
      (material) =>
        material.available &&
        material.activeSource !== false &&
        !material.sourceRemoved &&
        (material.artifactKey === previous.artifactKey ||
          (previous.sourcePromptId && material.sourcePromptId === previous.sourcePromptId) ||
          material.replacesMaterialIds?.includes(boundId)),
    );
    const files = new Map(candidates.map((material) => [material.fileObjectId, material]));
    if (!files.size && (currentBinding?.sourceRemoved || materials.some((material) =>
      material.sourceRemoved && (material.artifactKey === previous.artifactKey ||
        (previous.sourcePromptId && material.sourcePromptId === previous.sourcePromptId)))))
      return [{ slotId: slot.id, kind: 'REMOVED' }];
    if (files.size !== 1)
      return [
        {
          slotId: slot.id,
          blockedReason: files.size
            ? '该素材存在多个新版本，无法自动确定替换来源'
            : '该素材没有可用的新版本，请手动替换素材',
        },
      ];
    const material = [...files.values()][0]!;
    if (adopted && material.fileObjectId === adopted.fileObjectId &&
      (!adopted.contentHash || material.contentHash === adopted.contentHash) &&
      (material.artifactId !== adopted.artifactId || material.artifactRevision === adopted.artifactRevision))
      return [];
    if (material.duration + 0.001 < slot.duration)
      return [{ slotId: slot.id, blockedReason: '新素材时长不足以保留当前片段长度' }];
    return [{ slotId: slot.id, material }];
  });
}

/** Render clips carry their frozen Prompt request duration, not a live Prompt draft setting. */
export function effectTemplateMixSlotDurationLimit(
  materials: readonly (Pick<EffectTemplateMixMaterial, 'duration' | 'available'> &
    Pick<EffectTemplateMixMaterial, 'origin'>)[],
): number | null {
  const durations = materials
    .filter(
      (material) =>
        material.origin !== 'EXTERNAL_IMPORT' &&
        material.available &&
        Number.isFinite(material.duration) &&
        material.duration > 0,
    )
    .map((material) => material.duration);
  return durations.length ? Math.max(...durations) : null;
}

/** Equal duration is legal; missing/invalid durations are never usable. */
export function effectTemplateMixMaterialFitsSlot(duration: number, slotDuration: number): boolean {
  return (
    Number.isFinite(duration) &&
    Number.isFinite(slotDuration) &&
    duration > 0 &&
    slotDuration > 0 &&
    duration + 0.001 >= slotDuration
  );
}

export function effectTemplateMixMaterialFitsTemplate(
  duration: number,
  slots: readonly Pick<EffectTemplateMixSlot, 'duration'>[],
): boolean {
  return slots.some((slot) => effectTemplateMixMaterialFitsSlot(duration, slot.duration));
}

export function effectTemplateMixSlotDurationValid(
  duration: number,
  maximum: number | null,
): boolean {
  return (
    maximum !== null && Number.isFinite(duration) && duration >= 4 && duration <= maximum + 1e-6
  );
}

export function effectTemplateMixSlotDurationMessage(maximum: number | null): string {
  return maximum === null
    ? '暂无可用的上游渲染素材，请先完成视频渲染'
    : maximum < 4
      ? '上游素材时长不足 4 秒，无法配置模板槽位'
      : `槽位时长必须为 4–${maximum} 秒（上限随当前分支的素材 Prompt 时长）`;
}
export type EffectTemplateMixCaption = {
  id: string;
  /** User-authored subtitle-only clip; it is independent of generated narration. */
  manual?: boolean;
  /** User-created captions can own an independent timeline lane; absent is the legacy lane. */
  trackId?: string;
  /** New segmented captions share one saved narration clip; absent in historical packages. */
  voiceLineId?: string;
  /** Retains explicit picture-slot lineage when an editor splits a generated caption. */
  sourceSlotId?: string;
  /** Stable order and expected count make a missing subtitle detectable after editor rewording. */
  segmentIndex?: number;
  segmentCount?: number;
  text: string;
  start: number;
  end: number;
};
export type EffectTemplateMixAudio = {
  fileObjectId: string;
  name: string;
  duration: number;
  start: number;
  offset: number;
  volume: number;
};
/** Audio placed on the timeline, either detached from video or imported from the project music library. */
export type EffectTemplateMixDetachedAudio = {
  id: string;
  /** `FILE` references an already-authorized project file, such as a split packaged voice clip. */
  sourceType?: 'FILE' | undefined;
  /** Preserved while splitting packaged voice/music so the renderer keeps its mix behavior. */
  audioKind?: 'VOICE' | 'MUSIC' | 'DETACHED' | undefined;
  /** A packaged bed may be looped to fill the timeline, so a split can seek past one source pass. */
  loopSource?: boolean | undefined;
  sourceSlotId?: string | undefined;
  sourceAssetId?: string | undefined;
  fileObjectId: string;
  name: string;
  /** Full media length before this timeline clip is trimmed. */
  sourceDuration?: number | undefined;
  duration: number;
  start: number;
  offset: number;
  volume: number;
  fadeIn?: number | undefined;
  fadeOut?: number | undefined;
};
export type EffectTemplateMixBindingMetadata = {
  source: 'AI' | 'MANUAL';
  matchScore?: number;
  matchLevel?: 'NORMAL' | 'LOW_MATCH';
  classificationReason?: string;
  trimReason?: string;
};
export type EffectTemplateMixVariant = {
  id: string;
  name: string;
  /** Manual canvas override; missing uses the adopted generation ratio or material majority. */
  canvasRatio?: string;
  videoTransforms?: Record<string, import('./effect-template-mix-transform').EffectVideoTransform>;
  /** Local template edit sequence, NOT WorkingArtifact revision. */
  appliedTemplateVersion: number;
  /** Exact template configuration used by the latest successful smart-fill for this variant. */
  appliedTemplateHash?: string;
  /**
   * Template slots followed by the clips the user dropped onto a track border. Those extra slots
   * belong to this variant alone — the template never sees them — so they must survive a template
   * resync instead of being dropped on the floor.
   */
  slots: EffectTemplateMixSlot[];
  bindings: Record<string, string>;
  bindingRevisions: Record<string, number>;
  /** Server-authorized media actually consumed by each occurrence, never the live pool. */
  bindingSources?: Record<string, EffectTemplateMixMaterial>;
  offsets: Record<string, number>;
  /** Source-delete holes are intentional and remain renderable, unlike unfinished fill slots. */
  intentionallyEmptySlotIds?: string[];
  /** Seconds; explicit source removal must not shrink the film's original extent. */
  preservedTimelineEnd?: number;
  /** Optional editor layout; absent values use the template's sequential layout. */
  timelineStarts?: Record<string, number>;
  videoLanes?: Record<string, number>;
  /**
   * Optional per-clip audio row, keyed by timeline clip id (`voice:<lineId>`, `music`,
   * `detached:<uuid>`). Audio rows carry no meaning — every one of them is just 音频 and clips
   * differ only by colour — so this is pure editor arrangement: absent values fall back to the
   * kind's default row, and moving a clip between rows never changes what the worker renders.
   */
  audioLanes?: Record<string, number>;
  /** Optional for schema-v1 compatibility; missing values are historical/manual bindings. */
  bindingMetadata?: Record<string, EffectTemplateMixBindingMetadata>;
  manualSlotIds: string[];
  conflictSlotIds: string[];
  status: 'CURRENT' | 'PENDING' | 'SYNCED';
  captions: EffectTemplateMixCaption[];
  subtitleStyle: 'standard' | 'bold' | 'yellow';
  bgm: EffectTemplateMixAudio | null;
  voice: EffectTemplateMixAudio | null;
  /** Optional for historical schema-v1 drafts. */
  detachedAudios?: EffectTemplateMixDetachedAudio[];
  originalVolume: number;
};
/**
 * Re-syncs a variant's slots with the template while keeping the variant's own extra slots, in the
 * template's order followed by the extras. A template edit means "these six slots changed", not
 * "delete every clip I placed on its own track", so a wholesale replace would silently lose them.
 * Bindings, lanes and starts are keyed by slot id and therefore survive untouched.
 */
export const syncEffectTemplateMixVariantSlots = (
  templateSlots: readonly EffectTemplateMixSlot[],
  variantSlots: readonly EffectTemplateMixSlot[],
): EffectTemplateMixSlot[] => {
  const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
  const templateIds = new Set(templateSlots.map(({ id }) => id));
  return [
    ...clone(templateSlots),
    ...variantSlots.filter(({ id }) => !templateIds.has(id)).map(clone),
  ];
};
export type EffectTemplateMixAiRunStatus =
  'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';

/** Saved additions are measured against successfully adopted source identities, not edit events. */
export function effectTemplateMixPendingAddedMaterials(
  templateId: string,
  materials: readonly (Pick<EffectTemplateMixMaterial, 'id' | 'available' | 'activeSource' | 'sourcePromptId'> &
    Partial<Pick<EffectTemplateMixMaterial, 'duration'>>)[],
  history: readonly { templateId: string; status: string; inputSnapshot: unknown; selectionResult?: unknown }[],
  slots?: readonly Pick<EffectTemplateMixSlot, 'duration'>[],
): string[] {
  const known = new Set<string>();
  let baseline = false;
  for (const run of history) {
    if (run.templateId !== templateId || run.status !== 'COMPLETED') continue;
    const snapshot = run.inputSnapshot as Partial<EffectTemplateMixAiSnapshot> | null;
    if (!Array.isArray(snapshot?.materials)) continue;
    baseline = true;
    const selected = new Set(Array.isArray(run.selectionResult)
      ? (run.selectionResult as EffectTemplateMixAiSelection[]).map((row) => row.materialId) : []);
    for (const material of snapshot.materials)
      if (snapshot.trimOnly ? selected.has(material.id) : !snapshot.incremental ||
          !snapshot.incremental.materialIds.includes(material.id) || selected.has(material.id)) known.add(material.promptId);
  }
  return baseline ? materials.filter((material) => material.available && material.activeSource !== false &&
    (!slots || effectTemplateMixMaterialFitsTemplate(material.duration ?? NaN, slots)) &&
    Boolean(material.sourcePromptId) && !known.has(material.sourcePromptId!)).map((material) => material.id) : [];
}
export type EffectTemplateMixAiRunStage =
  'CLASSIFYING' | 'MATCHING' | 'SAMPLING' | 'TRIMMING' | 'COMPLETED';
export type EffectTemplateMixAiStageDetail = {
  /** Exact persisted work units; never inferred from the run's overall percentage. */
  completed: number;
  total: number;
  inputSamples: string[];
  outputSamples: string[];
};
export type EffectTemplateMixSampledMaterial = {
  materialId: string;
  /** Actual source-video positions successfully decoded as preview keyframes, in seconds. */
  frameTimestampsSeconds: number[];
};
export type EffectTemplateMixSamplingCheckpoint = {
  samples?: EffectTemplateMixSampledMaterial[];
  /** Legacy worker payload retained for rolling deployment compatibility. */
  materialIds?: string[];
};
export type EffectTemplateMixAiRun = {
  id: string;
  templateId: string;
  /**
   * Run the fill actually writes into. A regeneration forks an unpublished child, so this can
   * differ from the Run the caller named; the source editor stays on its current branch while this
   * child runs in the background.
   */
  workflowRunId: string;
  operation?: 'FILL' | 'REFRESH_TRIMS' | 'APPEND';
  outputVariantIds?: string[];
  packageNewVariants?: boolean;
  omittedNewMaterials?: Array<{ materialId: string; code: string; reason: string }>;
  newMaterialUsage?: Array<{ materialId: string; code: string; filmCount: number }>;
  targetVariantId: string | null;
  outputVariantId: string | null;
  status: EffectTemplateMixAiRunStatus;
  stage: EffectTemplateMixAiRunStage;
  progress: number;
  stageDetails?: Partial<Record<EffectTemplateMixAiRunStage, EffectTemplateMixAiStageDetail>>;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
};
export type EffectTemplateMixMaterialClassification = {
  materialId: string;
  role: EffectTemplateMixRole;
  matchScore: number;
  /** A manual role is authoritative; its score is not an AI assessment. */
  source?: 'AI' | 'MANUAL';
};
/** null explicitly removes an existing AI classification and returns the clip to 待归槽. */
export type EffectTemplateMixMaterialRoleOverrides = Record<string, EffectTemplateMixRole | null>;

export const resolveEffectTemplateMixMaterialRoles = (
  classifications: readonly EffectTemplateMixMaterialClassification[],
  overrides: EffectTemplateMixMaterialRoleOverrides = {},
  materials: readonly Pick<EffectTemplateMixMaterial, 'id' | 'replacesMaterialIds'>[] = [],
): Map<string, EffectTemplateMixMaterialClassification> => {
  const result = new Map(classifications.map((item) => [item.materialId, item]));
  // Carry purpose, not an old trim/assessment checkpoint. A reset is a deliberate choice too.
  const inheritedOverrides: EffectTemplateMixMaterialRoleOverrides = {};
  for (const material of materials) {
    const aliases = material.replacesMaterialIds ?? [];
    if (!result.has(material.id)) {
      const previous = aliases.flatMap((id) => (result.has(id) ? [result.get(id)!] : []));
      if (previous.length && new Set(previous.map((item) => item.role)).size === 1)
        result.set(material.id, { ...previous[0]!, materialId: material.id });
    }
    if (!Object.prototype.hasOwnProperty.call(overrides, material.id)) {
      const choices = aliases
        .filter((id) => Object.prototype.hasOwnProperty.call(overrides, id))
        .map((id) => overrides[id]!);
      if (choices.length && new Set(choices).size === 1)
        inheritedOverrides[material.id] = choices[0]!;
    }
  }
  for (const [materialId, role] of Object.entries({ ...inheritedOverrides, ...overrides })) {
    if (role === null) result.delete(materialId);
    else result.set(materialId, { materialId, role, matchScore: 1, source: 'MANUAL' });
  }
  return result;
};
export type EffectTemplateMixClassificationPool = {
  templateId: string;
  runId: string;
  templateEditVersion: number;
  items: EffectTemplateMixMaterialClassification[];
};
export type EffectTemplateMixTemplate = {
  name: string;
  editVersion: number;
  slots: EffectTemplateMixSlot[];
  /** Applies only to future packaging/voice redos, not existing audio. */
  voiceProfileId?: string;
};
export type EffectTemplateMixWorkspace = {
  editVersion: number;
  template: EffectTemplateMixTemplate;
  variants: EffectTemplateMixVariant[];
  /** Read-only upstream view, never serialized in the node draft. */
  materials: EffectTemplateMixMaterial[];
};
export type EffectTemplateMixTemplateEntry = {
  id: string;
  materialRoleOverrides?: EffectTemplateMixMaterialRoleOverrides;
  /** Server-owned draft edit sequence for consuming resets without losing newer choices. */
  materialRoleEditVersion?: number;
  /** First persisted creation time; absent for legacy drafts. */
  createdAt?: string;
  /** Transient while smart-fill is queued/running. */
  aiFillLocked?: boolean;
  /** Hash of template configuration used by the latest successful smart-fill. */
  filledTemplateHash?: string;
  /** Packaging has started in this Run; informational only, timeline editing stays available. */
  packagingLocked?: boolean;
  /** A child packaging task is active; its source projects stay locked until the task ends. */
  packagingSourceLocked?: boolean;
  /** True when current template configuration differs from the latest successful fill. */
  needsAiFill?: boolean;
  workspace: EffectTemplateMixWorkspace;
};
export type EffectTemplateMixDraft = {
  schemaVersion: 1;
  templates: {
    id: string;
    materialRoleOverrides?: EffectTemplateMixMaterialRoleOverrides;
    materialRoleEditVersion?: number;
    createdAt?: string;
    aiFillLocked?: boolean;
    filledTemplateHash?: string;
    packagingLocked?: boolean;
    /** Read projection only; never trusted from a saved draft. */
    packagingSourceLocked?: boolean;
    needsAiFill?: boolean;
    workspace: Omit<EffectTemplateMixWorkspace, 'materials'>;
  }[];
  activeTemplateId: string;
};
export type EffectTemplateMixWorkspaceData = {
  /** Templates with successful packaging history; used by local-update cost confirmation. */
  autoPackagingTemplateIds?: string[];
  /** Adopted generation ratio; adaptive/missing uses the actual material majority. */
  renderAspectRatio?: string | null;
  pendingAddedMaterialIds?: Record<string, string[]>;
  draft: EffectTemplateMixDraft;
  draftRevision: number | null;
  /** A successful render batch (or an already confirmed render pool) exists in this Run. */
  templateCreationReady?: boolean;
  /** Read-only cap from this branch's committed render batch; never trusted from client drafts. */
  slotDurationMaxSeconds?: number | null;
  materials: EffectTemplateMixMaterial[];
  commits: {
    templateId: string;
    revision: number;
    contentHash: string;
    stale: boolean;
    editVersion: number;
  }[];
  aiRuns: EffectTemplateMixAiRun[];
  /** Latest classification pool whose template and upstream revisions are still current. */
  classificationPools: EffectTemplateMixClassificationPool[];
};
export type SaveEffectTemplateMixRequest = {
  workflowRunId: string;
  expectedRevision: number | null;
  draft: EffectTemplateMixDraft;
  /** Autosave needs only the persisted revision, not a rebuilt material/task workbench. */
  compactResponse?: boolean;
};
export type SaveEffectTemplateMixData = { draftRevision: number };
export type EffectTemplateMixRevisionRequest = {
  workflowRunId: string;
  expectedRevision: number;
};
export type ApplyEffectTemplateMixVariantRequest = EffectTemplateMixRevisionRequest & {
  sourceVariantId: string;
  syncOtherVariants: boolean;
};
export type ValidateEffectTemplateMixRequest = EffectTemplateMixRevisionRequest & {
  templateId: string;
};
export type ValidateEffectTemplateMixData = { artifacts: WorkingArtifactCommitSummary[] };
export type CreateEffectTemplateMixAiRunRequest = EffectTemplateMixRevisionRequest & {
  targetVariantId?: string;
  /** Recalculate trim points only for bound clips whose confirmed render revision advanced. */
  refreshAffectedSlots?: boolean;
  /** Same-branch append only; every new film must use newly confirmed material. */
  appendNewMaterials?: boolean;
  /** Server-owned frozen operation, not a client-supplied source pool. */
  sourceOperationId?: string;
  idempotencyKey: string;
};
export type EffectTemplateMixAiClassification = {
  materialId: string;
  /** MANUAL rows represent user choices, not model-generated semantic scores. */
  source?: 'AI' | 'MANUAL';
  scores: Record<EffectTemplateMixRole, number>;
  reasons: Partial<Record<EffectTemplateMixRole, string>>;
};
export type EffectTemplateMixAiSelection = {
  /** Stored on the first selection of an append run, alongside the AI choice provenance. */
  omittedNewMaterials?: Array<{ materialId: string; reason: string }>;
  /** Zero-based output group; absent means the historical single-output group. */
  variantIndex?: number;
  slotId: string;
  role: EffectTemplateMixRole;
  materialId: string;
  matchScore: number;
  matchLevel: 'NORMAL' | 'LOW_MATCH';
  classificationReason: string;
  duration: number;
};
export type EffectTemplateMixAiTrim = {
  /** Zero-based output group; absent means the historical single-output group. */
  variantIndex?: number;
  slotId: string;
  materialId: string;
  trimStartSeconds: number;
  trimReason: string;
};

/** Internal API/Worker input, frozen when the smart-fill task starts. */
export type EffectTemplateMixAiSnapshot = {
  schemaVersion: 1;
  sourceOperation?: EffectTemplateMixFrozenSourceContext;
  template: {
    id: string;
    name: string;
    editVersion: number;
    slots: Array<{
      id: string;
      role: EffectTemplateMixRole;
      label: string;
      duration: number;
      transition?: string;
      transitionDuration?: number | undefined;
    }>;
  };
  draftRevision: number;
  workspaceHash?: string;
  targetVariantId: string | null;
  materialRoleAssignments?: Record<string, EffectTemplateMixRole>;
  manualMaterialRoles?: Record<string, EffectTemplateMixRole>;
  materialRoleEditVersion?: number;
  trimOnly?: boolean;
  /** New inputs omit external videos that cannot fit any template slot. */
  durationFilteredImports?: boolean;
  incremental?: {
    materialIds: string[];
    oldVariantIds: string[];
    packageNewVariants: boolean;
    /** Omitted by historical AI-planned runs. */
    combinationStrategy?: 'ADAPTIVE';
  };
  refreshBindings?: Array<{ slotId: string; materialId: string; artifactRevision: number }>;
  maxOutputVariants: number;
  /** New full-batch fills must cover every frozen material; historical snapshots omit this. */
  requireAllMaterials?: boolean;
  /** Full regeneration replaces only this template's inherited batch in its new Run on success. */
  replaceExistingVariants?: boolean;
  lockedBindings: Array<{
    slotId: string;
    materialId: string;
    artifactRevision: number;
    offset: number;
  }>;
  existingVariantBindings: Array<Array<{ slotId: string; materialId: string }>>;
  reuseCounts: Record<string, number>;
  promptArtifacts: Array<{
    id: string;
    artifactKey: string;
    revision: number;
    contentHash: string;
  }>;
  materials: Array<{
    id: string;
    code: string;
    name: string;
    duration: number;
    promptId: string;
    prompt: string;
    promptSummary?: string;
    artifactId: string;
    artifactKey: string;
    artifactRevision: number;
    contentHash: string;
    fileObjectId: string;
    /** Exact adopted media metadata; older AI snapshots recover from their saved files. */
    adoptedSource?: Omit<EffectTemplateMixMaterial, 'purpose' | 'compatiblePurposes'>;
  }>;
};

export type EffectTemplateMixIncrementalPlan = {
  variants: Array<{
    /** AI explains the actual viewing difference; mechanical code must not invent it. */
    difference: string;
    bindings: Array<{ slotId: string; materialId: string }>;
  }>;
  omitted: Array<{ materialId: string; reason: string }>;
};
