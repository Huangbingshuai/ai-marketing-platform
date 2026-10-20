import {
  EFFECT_PROMPT_RENDER_CAPABILITIES,
  type EffectPromptRenderCapabilityKey,
  type SeedanceRatio,
  type SeedanceResolution,
} from './effect-prompt-generation';

/** Shared with effect rendering; legacy capability keys remain stable. */
export const SEEDANCE_MODEL_OPTIONS = [
  {
    value: 'SEEDANCE_1_5_PRO',
    label: 'Doubao-Seedance-2.5',
    configKey: 'SEEDANCE_MODEL_2_5',
    model: 'doubao-seedance-2-5-260628',
  },
  {
    value: 'SEEDANCE_2_0',
    label: 'Doubao-Seedance-2.0',
    configKey: 'SEEDANCE_MODEL_2_0',
    model: 'doubao-seedance-2-0-260128',
  },
  {
    value: 'SEEDANCE_1_0',
    label: 'Doubao-Seedance-2.0-mini',
    configKey: 'SEEDANCE_MODEL_2_0_MINI',
    model: 'doubao-seedance-2-0-mini-260615',
  },
  {
    value: 'SEEDANCE_2_0_FAST',
    label: 'Doubao-Seedance-2.0-fast',
    configKey: 'SEEDANCE_MODEL_2_0_FAST',
    model: 'doubao-seedance-2-0-fast-260128',
  },
] as const;
export type CustomizedVideoRenderSettings = {
  capabilityKey: EffectPromptRenderCapabilityKey;
  ratio: SeedanceRatio;
  resolution: SeedanceResolution;
};
export const DEFAULT_CUSTOMIZED_VIDEO_RENDER_SETTINGS: CustomizedVideoRenderSettings = {
  capabilityKey: 'SEEDANCE_2_0',
  ratio: '16:9',
  resolution: '720p',
};
export const CUSTOMIZED_VIDEO_MAX_BYTES = 512 * 1024 * 1024;
export const CUSTOMIZED_VIDEO_RENDER_STAGES = [
  { id: 'SNAPSHOT', label: '渲染依据', description: '固定当前提示词、规格和实际引用图片' },
  { id: 'PLAN', label: '准备参考图', description: '核验并传递本镜真正引用的图片' },
  { id: 'GENERATE', label: '生成视频', description: '提交供应商任务并查询真实执行状态' },
  { id: 'REVIEW', label: '视频文件校验', description: '核对实际时长、画幅与清晰度并生成预览封面' },
  { id: 'SAVE', label: '原位保存视频', description: '保存当前分镜视频，不增加分支' },
] as const;
export function isCustomizedVideoRenderSettings(
  value: unknown,
): value is CustomizedVideoRenderSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as CustomizedVideoRenderSettings;
  if (!Object.hasOwn(EFFECT_PROMPT_RENDER_CAPABILITIES, v.capabilityKey)) return false;
  const capability = EFFECT_PROMPT_RENDER_CAPABILITIES[v.capabilityKey];
  return (
    !!capability &&
    capability.ratios.includes(v.ratio) &&
    capability.resolutions.includes(v.resolution)
  );
}
export function customizedVideoRenderIssues(
  settings: CustomizedVideoRenderSettings,
  seconds: number,
  images: number,
): string[] {
  if (!isCustomizedVideoRenderSettings(settings)) return ['请选择模型支持的画幅和分辨率'];
  const extended = settings.capabilityKey === 'SEEDANCE_1_5_PRO';
  const capability = EFFECT_PROMPT_RENDER_CAPABILITIES[settings.capabilityKey];
  const min = extended ? 2 : capability.minDurationSeconds,
    max = extended ? 30 : capability.maxDurationSeconds;
  const issues: string[] = [];
  if (!Number.isInteger(seconds) || seconds < min || seconds > max)
    issues.push(
      `该模型支持${min}–${max}整数秒，当前分镜为${seconds}秒，请在分镜参数中明确调整时长`,
    );
  if (!Number.isInteger(images) || images < 0 || images > (extended ? 30 : 9))
    issues.push(`该模型最多支持${extended ? 30 : 9}张参考图，请调整引用或选择兼容模型`);
  return issues;
}
export type CustomizedVideoRenderInput = {
  settings: CustomizedVideoRenderSettings;
  model: string;
  clipId: string;
  title: string;
  seconds: number;
  prompt: string;
  references: {
    objectId: string;
    name: string;
    /** Explicit detail ownership; omitted for independent and historical references. */
    sourceObjectId?: string;
    sourceName?: string;
    assetId: string;
    version: number;
    storageKey: string;
    mimeType: string;
    sizeBytes: number;
    sha256: string;
  }[];
};
export type CustomizedVideoFileInfo = { durationSeconds: number; width: number; height: number };
export type CustomizedVideoResult = CustomizedVideoFileInfo & {
  clipId: string;
  taskId: string;
  fileObjectId: string;
  posterFileObjectId: string;
  settings: CustomizedVideoRenderSettings;
};
export type CustomizedVideoSettingsDraft = {
  clipId: string;
  revision: number;
  settings: CustomizedVideoRenderSettings;
};
