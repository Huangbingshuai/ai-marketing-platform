/** Editable STORYBOARD node state. This is not a confirmed script artifact. */
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
  /** Full story; absent only in scripts created before the production split. */
  story?: { content: string; opening: string; development: string; ending: string; dialoguePlan: string; beats: { id: string; content: string; durationSeconds: number }[] };
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
  if (story !== undefined && (!record(story) ||
    !['content', 'opening', 'development', 'ending', 'dialoguePlan'].every(k => text(story[k])) ||
    !Array.isArray(story.beats) || story.beats.length > 60 ||
    !story.beats.every((b: unknown) => record(b) && id(b.id) && text(b.content) && seconds(b.durationSeconds)))) return false;
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
