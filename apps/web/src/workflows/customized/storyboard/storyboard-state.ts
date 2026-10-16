import type {
  CustomizedStoryboardDraft,
  CustomizedStoryboardScript,
  CustomizedStoryboardShot,
  CustomizedStoryboardAssetKind,
  CustomizedStoryboardAssetRequirements,
} from '@ai-marketing/contracts';
import { CUSTOMIZED_VIDEO_TYPE_LABELS } from '@ai-marketing/contracts';
export const storyboardAssetLabels: Record<CustomizedStoryboardAssetKind, string> = {
  characters: '人物',
  products: '产品',
  scenes: '场景',
};
export const emptyStoryboardAssetRequirements = (): CustomizedStoryboardAssetRequirements => ({
  characters: { state: 'UNDEFINED', items: [] },
  products: { state: 'UNDEFINED', items: [] },
  scenes: { state: 'UNDEFINED', items: [] },
});
export const emptyStoryboardDraft = (): CustomizedStoryboardDraft => ({
  schemaVersion: 1,
  source: null,
  settings: {
    targetDurationSeconds: 30,
    variantCount: 1,
    structureMode: 'AI',
    structure: '',
    instructions: '',
    videoType: 'BRAND_AD',
    structureSections: [],
  },
  scripts: [],
  activeScriptId: null,
  mainCandidateId: null,
});
export const snapshotStoryboard = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
export function storyboardStructure(settings: CustomizedStoryboardDraft['settings']): string[] {
  return (
    settings.structureSections ??
    (settings.structureMode === 'AI'
      ? []
      : settings.structure
          .split(/→|\n/)
          .map((v) => v.trim())
          .filter(Boolean))
  );
}
export function setStoryboardStructure(
  settings: CustomizedStoryboardDraft['settings'],
  sections: string[],
) {
  settings.structureSections = [...sections];
  settings.structureMode = sections.length ? 'CUSTOM' : 'AI';
  settings.structure = sections.join(' → ');
  settings.instructions = '';
}
/** Viewing another candidate is navigation, not a content change. */
export const storyboardContentFingerprint = (draft: CustomizedStoryboardDraft) =>
  JSON.stringify({ ...draft, activeScriptId: null });
export const createStoryboardShot = (): CustomizedStoryboardShot => ({
  id: crypto.randomUUID(),
  title: '',
  shotType: '近景',
  cameraMovement: '固定镜头',
  durationSeconds: 5,
  visual: '',
  dialogues: [],
  audio: '',
  continuity: '',
  assetRequirements: emptyStoryboardAssetRequirements(),
});
export const createStoryboardScript = (name: string): CustomizedStoryboardScript => ({
  id: crypto.randomUUID(),
  name,
  synopsis: '',
  structure: '',
  productFocus: '',
  story: {
    content: '',
    opening: '',
    development: '',
    ending: '',
    dialoguePlan: '',
    beats: [{ id: crypto.randomUUID(), content: '', durationSeconds: 30 }],
  },
  shots: [],
  assets: [],
});
/** Copy imported identities as one graph; preserve cross-shot reuse inside the copy. */
export function importStoryboardScript(script: CustomizedStoryboardScript) {
  const copy = snapshotStoryboard(script);
  copy.id = crypto.randomUUID();
  const assets = new Map(
    (copy.assets ?? []).map((asset) => {
      const oldId = asset.id;
      asset.id = crypto.randomUUID();
      return [oldId, asset.id];
    }),
  );
  copy.shots.forEach((shot) => {
    shot.id = crypto.randomUUID();
    shot.dialogues.forEach((d) => {
      d.id = crypto.randomUUID();
    });
    Object.values(shot.assetRequirements ?? {}).forEach((group) => {
      group.items.forEach((item) => {
        item.assetId = assets.get(item.assetId)!;
      });
    });
  });
  return copy;
}
export function storyboardAssetText(
  script: CustomizedStoryboardScript,
  shot: CustomizedStoryboardShot,
) {
  return (Object.keys(storyboardAssetLabels) as CustomizedStoryboardAssetKind[])
    .map((kind) => {
      const group = shot.assetRequirements?.[kind];
      const label = `${storyboardAssetLabels[kind]}资产`;
      if (!group || group.state === 'UNDEFINED') return `${label}：尚未定义`;
      if (group.state === 'NONE') return `${label}：本镜不需要`;
      return `${label}：\n${group.items
        .map((item) => {
          const asset = script.assets?.find((a) => a.id === item.assetId);
          return `${asset?.name ?? '对象引用缺失'}\n公共定义：${asset?.description || '尚未填写'}\n本镜要求：${item.description || '尚未填写'}`;
        })
        .join('\n')}`;
    })
    .join('\n');
}
export const scriptDuration = (script: CustomizedStoryboardScript) =>
  script.story
    ? script.story.beats.reduce((sum, b) => sum + b.durationSeconds, 0)
    : script.shots.reduce((sum, s) => sum + s.durationSeconds, 0);
export function reorderStoryboardShot(
  script: CustomizedStoryboardScript,
  sourceId: string,
  targetId: string,
) {
  const from = script.shots.findIndex((s) => s.id === sourceId),
    to = script.shots.findIndex((s) => s.id === targetId);
  if (from < 0 || to < 0 || from === to) return;
  const [shot] = script.shots.splice(from, 1);
  script.shots.splice(to, 0, shot!);
}
export function removeStoryboardScript(draft: CustomizedStoryboardDraft, id: string) {
  draft.scripts = draft.scripts.filter((s) => s.id !== id);
  if (draft.activeScriptId === id) draft.activeScriptId = draft.scripts[0]?.id ?? null;
  if (draft.mainCandidateId === id) draft.mainCandidateId = null;
}
export function storyboardText(script: CustomizedStoryboardScript) {
  if (script.story)
    return [
      script.name,
      '',
      script.story.content || '尚未填写剧本正文',
      '',
      `预计时长：${scriptDuration(script)} 秒`,
      ...(script.creation
        ? [
            `视频类型：${CUSTOMIZED_VIDEO_TYPE_LABELS[script.creation.videoType]}`,
            `参考时长：${script.creation.referenceDurationSeconds} 秒`,
          ]
        : []),
    ].join('\n');
  return [
    script.name,
    `方案概述：${script.synopsis}`,
    '历史方案未保存完整剧本正文；以下保留已有分镜。',
    `叙事结构：${script.structure || '未填写'}`,
    `产品呈现：${script.productFocus || '未填写'}`,
    `共 ${script.shots.length} 镜 · ${scriptDuration(script)} 秒`,
    ...script.shots.map(
      (s, i) =>
        `\n镜头 ${String(i + 1).padStart(2, '0')}\u3000${s.title}\n${s.shotType} · ${s.cameraMovement} · ${s.durationSeconds} 秒\n画面：${s.visual}\n台词 / 口播：${s.dialogues.map((d) => `${d.speaker}：${d.text}`).join('\n') || '无'}\n音效 / 音乐：${s.audio || '无'}\n衔接：${s.continuity || '未填写'}\n${storyboardAssetText(script, s)}`,
    ),
  ].join('\n');
}
