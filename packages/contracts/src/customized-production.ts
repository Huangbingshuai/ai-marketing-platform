import type { CustomizedStoryboardScript } from './customized-storyboard';
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
export type ProductionDocument = { assets: ProductionAsset[]; shots: ProductionShot[] };
export type ProductionOperation = 'ASSETS' | 'SHOTS' | 'PROMPT' | 'IMAGE';
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
};
export const PRODUCTION_STAGES = [
  { id: 'SNAPSHOT', label: '创作依据', description: '读取本次选定的故事与已确认资料' },
  { id: 'PLAN', label: '制作规划', description: '整理本次内容安排及依据' },
  { id: 'GENERATE', label: '内容创作', description: '按当前任务整理可编辑内容' },
  { id: 'REVIEW', label: '独立审校', description: '核对事实、连续性与对象引用' },
  { id: 'REPAIR', label: '定向修订', description: '针对具体问题修订并复核；无需修改时说明原因' },
  { id: 'SAVE', label: '保存结果', description: '保存通过校验的实际产物' },
] as const;
export function productionStages(operation: ProductionOperation, assetWorkflowVersion?: number) {
  if (operation === 'IMAGE') return CUSTOMIZED_IMAGE_STAGES;
  if (operation === 'ASSETS' && assetWorkflowVersion === 2) return ASSET_STAGES;
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
  reviewDraftState?: 'AVAILABLE' | 'ADOPTED';
  /** Successful asset extraction publishes this aggregate asset branch. */
  publishedWorkflowRunId?: string;
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
  prompts: { value: ProductionPrompt; stale: boolean; revision: number }[];
  tasks: ProductionTask[];
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
