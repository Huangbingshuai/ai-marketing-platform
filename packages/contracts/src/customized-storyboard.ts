/** Editable STORYBOARD node state. This is not a confirmed script artifact. */
export const CUSTOMIZED_VIDEO_TYPES = ['ECOMMERCE', 'LOCAL_STORE', 'BRAND_AD', 'DRAMA'] as const;
export type CustomizedVideoType = (typeof CUSTOMIZED_VIDEO_TYPES)[number];
export const CUSTOMIZED_VIDEO_TYPE_LABELS: Record<CustomizedVideoType, string> = {
  ECOMMERCE: '口播带货',
  LOCAL_STORE: '同城到店',
  BRAND_AD: '品牌广告',
  DRAMA: '剧情短片',
};
export const CUSTOMIZED_SCRIPT_STRUCTURES: Record<CustomizedVideoType, string[][]> = {
  ECOMMERCE: [
    ['黄金3秒钩子', '痛点', '产品亮相', '卖点拆解', '信任背书', '行动号召'],
    ['问题提出', '产品解答', '价值呈现', '行动号召'],
  ],
  LOCAL_STORE: [['到店理由', '空间体验', '特色服务', '到店引导']],
  BRAND_AD: [
    ['视觉引入', '主题展开', '产品关联', '品牌收束'],
    ['悬念建立', '逐步揭示', '产品亮相', '主题回扣'],
  ],
  DRAMA: [['人物与处境', '冲突推进', '转折', '情绪回收']],
};
export type CustomizedStoryboardDialogue = { id: string; speaker: string; text: string };
export const CUSTOMIZED_STORYBOARD_ASSET_KINDS = ['characters', 'products', 'scenes'] as const;
export type CustomizedStoryboardAssetKind = (typeof CUSTOMIZED_STORYBOARD_ASSET_KINDS)[number];
/** Script-local identity, not a generated ProjectAsset or a file reference. */
export type CustomizedStoryboardAsset = {
  id: string;
  kind: CustomizedStoryboardAssetKind;
  name: string;
  description: string;
};
export type CustomizedStoryboardAssetGroup = {
  state: 'UNDEFINED' | 'NONE' | 'DEFINED';
  items: { assetId: string; description: string }[];
};
export type CustomizedStoryboardAssetRequirements = Record<
  CustomizedStoryboardAssetKind,
  CustomizedStoryboardAssetGroup
>;
export type CustomizedStoryboardShot = {
  id: string;
  title: string;
  shotType: string;
  cameraMovement: string;
  durationSeconds: number;
  visual: string;
  dialogues: CustomizedStoryboardDialogue[];
  audio: string;
  continuity: string;
  /** Absent in legacy drafts; absence means undefined, never inferred from visual text. */
  assetRequirements?: CustomizedStoryboardAssetRequirements;
};
export type CustomizedStoryboardScript = {
  id: string;
  name: string;
  synopsis: string;
  structure: string;
  productFocus: string;
  creation?: {
    videoType: CustomizedVideoType;
    referenceDurationSeconds: number;
    structureSections: string[];
  };
  /** Full story; absent only in scripts created before the production split. */
  story?: {
    structureMapping?: import('./customized-script-routes').ScriptStructureMapping[];
    content: string;
    opening: string;
    development: string;
    ending: string;
    dialoguePlan: string;
    beats: { id: string; content: string; durationSeconds: number }[];
  };
  shots: CustomizedStoryboardShot[];
  assets?: CustomizedStoryboardAsset[];
};
export type CustomizedStoryboardDraft = {
  schemaVersion: 1;
  source: { artifactId: string; revision: number } | null;
  settings: {
    targetDurationSeconds: number;
    variantCount: number;
    structureMode: 'AI' | 'REFERENCE' | 'CUSTOM';
    structure: string;
    instructions: string;
    videoType?: CustomizedVideoType;
    structureSections?: string[];
  };
  scripts: CustomizedStoryboardScript[];
  activeScriptId: string | null;
  /** A draft preference only; downstream cannot consume this as a confirmed selection. */
  mainCandidateId: string | null;
};

const record = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown, max = 20000): v is string => typeof v === 'string' && v.length <= max;
const id = (v: unknown): v is string => text(v, 200) && v.trim().length > 0;
const seconds = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 3600;
const unique = (items: { id: string }[]) => new Set(items.map((i) => i.id)).size === items.length;
function validAssetRequirements(v: unknown, assets: CustomizedStoryboardAsset[]): boolean {
  if (v === undefined) return true;
  if (!record(v)) return false;
  return CUSTOMIZED_STORYBOARD_ASSET_KINDS.every((kind) => {
    const group = v[kind];
    if (
      !record(group) ||
      !['UNDEFINED', 'NONE', 'DEFINED'].includes(group.state as string) ||
      !Array.isArray(group.items) ||
      group.items.length > 100 ||
      (group.state === 'DEFINED' ? !group.items.length : group.items.length !== 0)
    )
      return false;
    return (
      group.items.every(
        (item: unknown) =>
          record(item) &&
          id(item.assetId) &&
          text(item.description) &&
          assets.some((asset) => asset.id === item.assetId && asset.kind === kind),
      ) &&
      new Set(group.items.map((item) => (item as { assetId: string }).assetId)).size ===
        group.items.length
    );
  });
}
export function isCustomizedStoryboardScript(v: unknown): v is CustomizedStoryboardScript {
  if (
    !record(v) ||
    !id(v.id) ||
    !text(v.name, 200) ||
    !text(v.synopsis) ||
    !text(v.structure) ||
    !text(v.productFocus) ||
    !Array.isArray(v.shots) ||
    v.shots.length > 500
  )
    return false;
  const story = v.story;
  if (
    v.creation !== undefined &&
    (!record(v.creation) ||
      !CUSTOMIZED_VIDEO_TYPES.includes(v.creation.videoType as CustomizedVideoType) ||
      !seconds(v.creation.referenceDurationSeconds) ||
      !Array.isArray(v.creation.structureSections) ||
      v.creation.structureSections.length > 20 ||
      !v.creation.structureSections.every((s: unknown) => id(s)))
  )
    return false;
  if (
    story !== undefined &&
    (!record(story) ||
      !['content', 'opening', 'development', 'ending', 'dialoguePlan'].every((k) =>
        text(story[k]),
      ) ||
      !Array.isArray(story.beats) ||
      story.beats.length > 60 ||
      !story.beats.every(
        (b: unknown) => record(b) && id(b.id) && text(b.content) && seconds(b.durationSeconds),
      ))
  )
    return false;
  if (
    v.assets !== undefined &&
    (!Array.isArray(v.assets) ||
      v.assets.length > 1000 ||
      !v.assets.every(
        (asset: unknown) =>
          record(asset) &&
          id(asset.id) &&
          CUSTOMIZED_STORYBOARD_ASSET_KINDS.includes(asset.kind as CustomizedStoryboardAssetKind) &&
          id(asset.name) &&
          text(asset.description),
      ) ||
      !unique(v.assets as CustomizedStoryboardAsset[]))
  )
    return false;
  const assets = (v.assets ?? []) as CustomizedStoryboardAsset[];
  if (
    !v.shots.every(
      (s: unknown) =>
        record(s) &&
        id(s.id) &&
        text(s.title, 200) &&
        text(s.shotType, 200) &&
        text(s.cameraMovement, 200) &&
        seconds(s.durationSeconds) &&
        text(s.visual) &&
        text(s.audio) &&
        text(s.continuity) &&
        validAssetRequirements(s.assetRequirements, assets) &&
        Array.isArray(s.dialogues) &&
        s.dialogues.length <= 100 &&
        s.dialogues.every(
          (d: unknown) => record(d) && id(d.id) && text(d.speaker, 200) && text(d.text),
        ) &&
        unique(s.dialogues as CustomizedStoryboardDialogue[]),
    )
  )
    return false;
  return unique(v.shots as CustomizedStoryboardShot[]);
}
export function isCustomizedStoryboardDraft(v: unknown): v is CustomizedStoryboardDraft {
  if (
    !record(v) ||
    v.schemaVersion !== 1 ||
    !record(v.settings) ||
    !seconds(v.settings.targetDurationSeconds) ||
    !Number.isInteger(v.settings.variantCount) ||
    Number(v.settings.variantCount) < 1 ||
    Number(v.settings.variantCount) > 5 ||
    !['AI', 'REFERENCE', 'CUSTOM'].includes(String(v.settings.structureMode)) ||
    !text(v.settings.structure) ||
    !text(v.settings.instructions) ||
    (v.settings.videoType !== undefined &&
      !CUSTOMIZED_VIDEO_TYPES.includes(v.settings.videoType as CustomizedVideoType)) ||
    (v.settings.structureSections !== undefined &&
      (!Array.isArray(v.settings.structureSections) ||
        v.settings.structureSections.length > 20 ||
        !v.settings.structureSections.every((s: unknown) => text(s, 200)))) ||
    !Array.isArray(v.scripts) ||
    v.scripts.length > 100 ||
    !v.scripts.every(isCustomizedStoryboardScript)
  )
    return false;
  if (
    v.source !== null &&
    (!record(v.source) ||
      !id(v.source.artifactId) ||
      !Number.isInteger(v.source.revision) ||
      Number(v.source.revision) < 1)
  )
    return false;
  const scripts = v.scripts as CustomizedStoryboardScript[];
  return (
    unique(scripts) &&
    [v.activeScriptId, v.mainCandidateId].every(
      (s) => s === null || (typeof s === 'string' && scripts.some((i) => i.id === s)),
    )
  );
}
