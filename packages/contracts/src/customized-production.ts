import type { CustomizedStoryboardScript } from './customized-storyboard';
import {
  CUSTOMIZED_VIDEO_RENDER_STAGES,
  type CustomizedVideoRenderSettings,
  type CustomizedVideoRenderInput,
  type CustomizedVideoResult,
  type CustomizedVideoSettingsDraft,
} from './customized-video-render';
export * from './customized-video-render';
import {
  isVideoPlan,
  validateVideoPlan,
  videoShotProjection,
  type ProductionVideoDocument,
  type ProductionClipPrompt,
  type VideoDurationPolicy,
  type VideoSourceUnit,
  type VideoCapability,
  type VideoRequestLimits,
} from './customized-video-plan';
export * from './customized-video-plan';
import {
  CUSTOMIZED_IMAGE_STAGES,
  type CustomizedImageSettings,
} from './customized-image-generation';
export * from './customized-image-generation';
import type { StoryboardSource, StoryboardStatus } from './customized-storyboard-generation';
import {
  ASSET_STAGES,
  ASSET_EDITABLE_FIELDS,
  isAssetPreparation,
  type AssetPreparation,
} from './customized-asset-preparation';
export * from './customized-asset-preparation';

export const PRODUCTION_ASSET_KINDS = ['PRODUCT', 'CHARACTER', 'SCENE', 'PROP'] as const;
export type ProductionAsset = {
  id: string;
  kind: (typeof PRODUCTION_ASSET_KINDS)[number];
  name: string;
  description: string;
  knownFacts: string;
  designNotes: string;
  sourceText: string;
  /** Future image deliverables, not generated files. Optional for historical records. */
  imageRequirements?: string;
  image?: { assetId: string; version: number } | null;
  preparation?: AssetPreparation;
  /** Maintained by the API; model output cannot clear these locks. */
  manualFields?: string[];
};
export type ProductionShot = {
  id: string;
  title: string;
  shotType: string;
  cameraMovement: string;
  durationSeconds: number;
  visual: string;
  dialogue: string;
  audio: string;
  atmosphere: string;
  bindings: { assetId: string; description: string }[];
};
export type ProductionPrompt = { shotId: string; content: string; assetIds: string[] };
export type LegacyProductionDocument = {
  assets: ProductionAsset[];
  shots: ProductionShot[];
  schemaVersion?: never;
};
export type ProductionDocument = LegacyProductionDocument | ProductionVideoDocument;
export type ProductionPromptValue = ProductionPrompt | ProductionClipPrompt;
export const isVideoDocument = (v: ProductionDocument): v is ProductionVideoDocument =>
  v.schemaVersion === 2;
export const productionShots = (v: ProductionDocument): ProductionShot[] =>
  isVideoDocument(v) ? v.videoPlan.shots.map((s) => videoShotProjection(v.videoPlan, s)) : v.shots;
/** Replaces only public assets, preserving the one authoritative video plan. */
export const withProductionAssets = (
  v: ProductionDocument,
  assets: ProductionAsset[],
): ProductionDocument => ({ ...v, assets });
export type ProductionOperation = 'ASSETS' | 'SHOTS' | 'PROMPT' | 'IMAGE' | 'RENDER';
export type ProductionInput = {
  script: CustomizedStoryboardScript;
  brief: unknown;
  document: ProductionDocument;
  sources: { id: string; revision: number; hash: string }[];
  draftRevision: number;
  models: { creative: string; detail: string };
  operation: ProductionOperation;
  shotId: string | null;
  assetWorkflowVersion?: 2;
  targetAssetId?: string | null;
  identitySeed?: string;
  imageSettings?: CustomizedImageSettings;
  videoRender?: CustomizedVideoRenderInput;
  shotWorkflowVersion?: 2;
  /** New SHOTS tasks only; absent historical snapshots retain their original prompts. */
  shotBenefitPolicyVersion?: 1;
  promptWorkflowVersion?: 2 | 3;
  strategyVersion?: string;
  durationPolicy?: VideoDurationPolicy;
  sourceUnits?: VideoSourceUnit[];
  renderCapability?: VideoCapability;
  requestLimits?: VideoRequestLimits;
  target?: { kind: 'CLIP'; id: string };
};
export const PRODUCTION_STAGES = [
  { id: 'SNAPSHOT', label: '创作依据', description: '读取本次选定的故事与已确认资料' },
  { id: 'PLAN', label: '制作规划', description: '整理本次内容安排及依据' },
  { id: 'GENERATE', label: '内容创作', description: '按当前任务整理可编辑内容' },
  { id: 'REVIEW', label: '独立审校', description: '核对事实、连续性与对象引用' },
  { id: 'REPAIR', label: '定向修订', description: '针对具体问题修订并复核；无需修改时说明原因' },
  { id: 'SAVE', label: '保存结果', description: '保存通过校验的实际产物' },
] as const;
export function productionStages(
  operation: ProductionOperation,
  assetWorkflowVersion?: number,
  shotWorkflowVersion?: number,
  promptWorkflowVersion?: number,
) {
  if (operation === 'IMAGE') return CUSTOMIZED_IMAGE_STAGES;
  if (operation === 'RENDER') return CUSTOMIZED_VIDEO_RENDER_STAGES;
  if (operation === 'ASSETS' && assetWorkflowVersion === 2) return ASSET_STAGES;
  if (operation === 'PROMPT' && (promptWorkflowVersion === 2 || promptWorkflowVersion === 3))
    return [
      {
        id: 'SNAPSHOT',
        label: '本镜创作依据',
        description: '固定当前分镜、时长、氛围与已绑定素材',
      },
      {
        id: 'PLAN',
        label: '画面与素材安排',
        description: '整理实际画面要求、素材用途和原稿声音时间窗',
      },
      {
        id: 'GENERATE',
        label: '视频提示词创作',
        description: '按时间段组织画面、动作、声音和素材引用',
      },
      { id: 'REVIEW', label: '独立审校', description: '逐项核对分镜兑现、产品事实和素材引用' },
      { id: 'REPAIR', label: '定向修订与复核', description: '确有问题才修改，无需修改时明确说明' },
      { id: 'SAVE', label: '原位保存提示词', description: '保存到当前分镜，不新增版本分支' },
    ];
  if (shotWorkflowVersion === 2)
    return PRODUCTION_STAGES.map((s) => ({
      ...s,
      label: (
        {
          SNAPSHOT: '创作依据',
          PLAN: operation === 'PROMPT' ? '片段呈现安排' : '导演规划与容量核对',
          GENERATE: operation === 'PROMPT' ? '片段提示词创作' : '分场创作与绑定',
          REVIEW: '对照原文独立审校',
          REPAIR: '问题修订与独立复核',
          SAVE: operation === 'PROMPT' ? '保存片段提示词' : '保存待确认分镜',
        } as Record<string, string>
      )[s.id]!,
    }));
  const names =
    operation === 'ASSETS'
      ? { PLAN: '实体与依据规划', GENERATE: '统一定义与制作要求' }
      : operation === 'SHOTS'
        ? { PLAN: '叙事与镜头节奏', GENERATE: '逐镜创作与绑定' }
        : { PLAN: '本镜呈现规划', GENERATE: '镜头提示词创作' };
  return PRODUCTION_STAGES.map((stage) => ({
    ...stage,
    label: names[stage.id as keyof typeof names] ?? stage.label,
  }));
}
/** Read-only business projection. Not part of Worker checkpoint writes. */
export type ProductionExecutionDetail = {
  title: string;
  summary: string;
  sections: { title: string; fields: { label: string; value: string }[] }[];
  emptyMessage?: string;
};
export type ProductionStep = {
  id: string;
  status: string;
  title: string;
  content: string;
  detail?: ProductionExecutionDetail;
};
export type ProductionTask = {
  id: string;
  operation: ProductionOperation;
  status: StoryboardStatus;
  progress: number;
  steps: ProductionStep[];
  assetWorkflowVersion?: 2;
  targetAssetId?: string | null;
  errorMessage: string | null;
  shotId: string | null;
  imageSettings?: CustomizedImageSettings;
  renderSettings?: CustomizedVideoRenderSettings;
  reviewDraftState?: 'AVAILABLE' | 'ADOPTED';
  /** Successful asset extraction publishes this aggregate asset branch. */
  publishedWorkflowRunId?: string;
  shotWorkflowVersion?: 2;
  promptWorkflowVersion?: 2 | 3;
  target?: { kind: 'CLIP'; id: string };
  failureReason?:
    | 'DURATION_CAPACITY_CONFLICT'
    | 'SOURCE_CONSTRAINT_CONFLICT'
    | 'REQUEST_LIMIT'
    | 'ASSET_INPUT_GAP'
    | 'REVIEW_UNRESOLVED'
    | 'INVALID_CANDIDATE';
  hasCandidate?: boolean;
};
export type ProductionWorkspace = {
  brandImageReferences?: { assetId: string; version: number; name: string }[];
  script: CustomizedStoryboardScript;
  source: StoryboardSource;
  sourceReady: boolean;
  document: ProductionDocument;
  confirmedDocument: ProductionDocument;
  draftRevision: number;
  assetsConfirmed: boolean;
  shotsConfirmed: boolean;
  prompts: { value: ProductionPromptValue; stale: boolean; revision: number }[];
  tasks: ProductionTask[];
  videos?: { value: CustomizedVideoResult; revision: number; stale: boolean }[];
  videoSettings?: CustomizedVideoSettingsDraft[];
};
const obj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown, limit = 20000): v is string => typeof v === 'string' && v.length <= limit;
const id = (v: unknown): v is string => text(v, 200) && !!v.trim();
const unique = (v: { id: string }[]) => new Set(v.map((a) => a.id)).size === v.length;
export function isProductionAsset(v: unknown): v is ProductionAsset {
  return (
    obj(v) &&
    id(v.id) &&
    id(v.name) &&
    PRODUCTION_ASSET_KINDS.includes(v.kind as ProductionAsset['kind']) &&
    ['description', 'knownFacts', 'designNotes', 'sourceText'].every((k) => text(v[k])) &&
    (v.preparation === undefined || isAssetPreparation(v.preparation)) &&
    (v.manualFields === undefined ||
      (Array.isArray(v.manualFields) &&
        v.manualFields.every((k) => ASSET_EDITABLE_FIELDS.includes(k)))) &&
    (v.imageRequirements === undefined || text(v.imageRequirements)) &&
    (v.image == null ||
      (obj(v.image) &&
        id(v.image.assetId) &&
        Number.isInteger(v.image.version) &&
        Number(v.image.version) > 0))
  );
}
export function isProductionDocument(v: unknown): v is ProductionDocument {
  if (
    !obj(v) ||
    !Array.isArray(v.assets) ||
    v.assets.length > 1000 ||
    !v.assets.every(isProductionAsset) ||
    !unique(v.assets)
  )
    return false;
  const assets = v.assets;
  if (v.schemaVersion === 2)
    return (
      !Object.hasOwn(v, 'shots') &&
      isVideoPlan(v.videoPlan) &&
      validateVideoPlan(v.videoPlan, assets as ProductionAsset[]) === null
    );
  if (v.schemaVersion !== undefined || Object.hasOwn(v, 'videoPlan')) return false;
  return (
    Array.isArray(v.shots) &&
    v.shots.length <= 500 &&
    v.shots.every(
      (s) =>
        obj(s) &&
        id(s.id) &&
        ['title', 'shotType', 'cameraMovement', 'visual', 'dialogue', 'audio', 'atmosphere'].every(
          (k) => text(s[k]),
        ) &&
        typeof s.durationSeconds === 'number' &&
        Number.isFinite(s.durationSeconds) &&
        s.durationSeconds > 0 &&
        s.durationSeconds <= 3600 &&
        Array.isArray(s.bindings) &&
        s.bindings.length <= 100 &&
        new Set(s.bindings.map((b) => (obj(b) ? b.assetId : null))).size === s.bindings.length &&
        s.bindings.every(
          (b) =>
            obj(b) &&
            id(b.assetId) &&
            text(b.description) &&
            assets.some((a) => a.id === b.assetId),
        ),
    ) &&
    unique(v.shots as ProductionShot[])
  );
}
export function isProductionPrompt(v: unknown, shot: ProductionShot): v is ProductionPrompt {
  return (
    obj(v) &&
    v.shotId === shot.id &&
    text(v.content) &&
    !!v.content.trim() &&
    Array.isArray(v.assetIds) &&
    new Set(v.assetIds).size === v.assetIds.length &&
    v.assetIds.every((id) => shot.bindings.some((b) => b.assetId === id)) &&
    shot.bindings.every((b) => v.assetIds instanceof Array && v.assetIds.includes(b.assetId))
  );
}
