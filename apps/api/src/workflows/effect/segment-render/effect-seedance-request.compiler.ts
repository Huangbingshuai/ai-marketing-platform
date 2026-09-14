import { createHash } from 'node:crypto';

import type {
  EffectPromptFragmentType,
  EffectPromptItem,
  EffectPromptBatchResult,
  EffectSegmentRenderSettings,
  EffectSegmentRenderInputVideo,
  EffectSegmentRenderRepairInput,
  EffectSegmentRenderRequestSnapshot,
  SeedanceRatio,
  SeedanceResolution,
} from '@ai-marketing/contracts';
import { EFFECT_PROMPT_RENDER_CAPABILITIES } from '@ai-marketing/contracts';
import { compileEffectPromptSharedConstraintPrompt } from '../prompt-generation/effect-prompt.quality';

export type EffectSeedanceCreateTaskRequest = {
  model: string;
  content: [{ type: 'text'; text: string }];
  duration: number;
  ratio: SeedanceRatio;
  resolution: SeedanceResolution;
};

export type EffectSeedanceRequestSnapshot = {
  promptId: string;
  primaryPurpose: EffectPromptFragmentType;
  compatiblePurposes: EffectPromptFragmentType[];
  promptContentHash: string;
  sharedPromptHash: string;
  renderSettingsHash: string;
  request: EffectSeedanceCreateTaskRequest;
};

export type EffectSeedanceTaskResult = {
  duration?: number | string;
  ratio?: string;
  resolution?: string;
};

export class EffectSeedanceCompileError extends Error {
  constructor(
    readonly code:
      | 'INVALID_BATCH'
      | 'CLASSIFICATION_PENDING'
      | 'PROMPT_NOT_FOUND'
      | 'DURATION_UNSUPPORTED'
      | 'RATIO_UNSUPPORTED'
      | 'RESOLUTION_UNSUPPORTED'
      | 'REPAIR_RANGE_INVALID'
      | 'REPAIR_INSTRUCTION_EMPTY'
      | 'EMPTY_MODEL',
    message: string,
  ) {
    super(message);
    this.name = 'EffectSeedanceCompileError';
  }
}

const compileText = (item: EffectPromptItem, sharedPrompt: string): string => {
  const content = item.content.trim().replace(/。+$/gu, '');
  const prompt = `${content}。`;
  const shared = sharedPrompt.trim();
  if (!shared) return prompt;
  if (content.endsWith(shared.replace(/。+$/gu, ''))) return prompt;
  return `${prompt}\n${shared}`;
};

const seconds = (milliseconds: number): string => (milliseconds / 1000).toFixed(3);

const repairRegionText = (region: EffectSegmentRenderRepairInput['region']): string => {
  if (!region) return '未限定矩形区域，以时间段和修改要求为准';
  const percent = (value: number): string => `${Math.round(value * 1000) / 10}%`;
  return [
    `左侧 ${percent(region.x)}`,
    `顶部 ${percent(region.y)}`,
    `宽度 ${percent(region.width)}`,
    `高度 ${percent(region.height)}`,
  ].join('，');
};

export const compileEffectSeedanceRepairRequest = (
  generationSnapshot: EffectSegmentRenderRequestSnapshot,
  inputVideo: EffectSegmentRenderInputVideo,
  repair: EffectSegmentRenderRepairInput,
  repairModel: string,
): EffectSegmentRenderRequestSnapshot => {
  const instruction = repair.instruction.trim();
  if (!instruction)
    throw new EffectSeedanceCompileError('REPAIR_INSTRUCTION_EMPTY', '视频返修要求不能为空');
  const model = repairModel.trim();
  if (!model) throw new EffectSeedanceCompileError('EMPTY_MODEL', 'Seedance 返修模型配置为空');
  const durationMs = generationSnapshot.request.duration * 1000;
  if (
    !Number.isInteger(repair.startMs) ||
    !Number.isInteger(repair.endMs) ||
    repair.startMs < 0 ||
    repair.endMs <= repair.startMs ||
    repair.endMs > durationMs
  )
    throw new EffectSeedanceCompileError('REPAIR_RANGE_INVALID', '视频返修时间范围超出原视频时长');
  const normalizedInstruction = instruction.replace(/。+$/gu, '');
  const text = [
    '任务类型：基于输入的完整参考视频进行局部画面修复。',
    `用户修改要求（最高优先级，必须产生肉眼可见且直接对应要求的变化）：${normalizedInstruction}。`,
    `修改时间段：[${seconds(repair.startMs)}s-${seconds(repair.endMs)}s]。`,
    ...(repair.region ? [`修改区域：${repairRegionText(repair.region)}。`] : []),
    `输出时长保持 ${generationSnapshot.request.duration} 秒，并沿用参考视频的画幅、分辨率、镜头顺序和时间节奏。`,
    '仅对用户要求直接涉及的画面内容进行修改，其余内容尽量沿用参考视频；保持要求不得削弱或抵消用户修改。',
    '不要新增与返修无关的镜头、人物、商品、文字、字幕、口播、旁白或特效。',
    '如果修改目标与参考视频看起来基本相同，视为未完成返修。',
  ].join('\n');
  return {
    ...generationSnapshot,
    operation: 'REPAIR',
    inputImages: [],
    inputVideo,
    repair: { ...repair, instruction },
    request: {
      ...generationSnapshot.request,
      model,
      content: [{ type: 'text', text }],
    },
  };
};

const promptContentHash = (item: EffectPromptItem): string =>
  createHash('sha256').update(item.content.trim()).digest('hex');

export const compileEffectSeedanceRequest = (
  batch: EffectPromptBatchResult,
  promptId: string,
  model: string,
  renderSettings: EffectSegmentRenderSettings,
): EffectSeedanceRequestSnapshot => {
  const item = batch.items.find(({ id }) => id === promptId);
  if (!item) throw new EffectSeedanceCompileError('PROMPT_NOT_FOUND', 'Prompt 不存在');
  if (item.classificationStatus !== 'VERIFIED')
    throw new EffectSeedanceCompileError(
      'CLASSIFICATION_PENDING',
      'Prompt 尚未完成用途评估，不能进入视频渲染',
    );
  if (!model.trim()) throw new EffectSeedanceCompileError('EMPTY_MODEL', 'Seedance 模型配置为空');
  const capability = EFFECT_PROMPT_RENDER_CAPABILITIES[renderSettings.capabilityKey];
  if (
    item.targetDurationSeconds < capability.minDurationSeconds ||
    item.targetDurationSeconds > capability.maxDurationSeconds
  )
    throw new EffectSeedanceCompileError(
      'DURATION_UNSUPPORTED',
      `当前模型仅支持 ${capability.minDurationSeconds}～${capability.maxDurationSeconds} 秒`,
    );
  if (!capability.ratios.includes(renderSettings.ratio))
    throw new EffectSeedanceCompileError('RATIO_UNSUPPORTED', '当前模型不支持所选画幅');
  if (!capability.resolutions.includes(renderSettings.resolution))
    throw new EffectSeedanceCompileError('RESOLUTION_UNSUPPORTED', '当前模型不支持所选分辨率');
  const sharedPromptContent =
    batch.sharedPrompt?.compiledContent ??
    compileEffectPromptSharedConstraintPrompt(
      batch.renderProfile.sharedConstraints.disabledElements,
    );
  const text = compileText(item, sharedPromptContent);
  return {
    promptId: item.id,
    primaryPurpose: item.primaryPurpose,
    compatiblePurposes: [...item.compatiblePurposes],
    promptContentHash: promptContentHash(item),
    sharedPromptHash:
      batch.sharedPrompt?.contentHash ?? batch.renderProfile.sharedConstraints.contentHash,
    renderSettingsHash: createHash('sha256').update(JSON.stringify(renderSettings)).digest('hex'),
    request: {
      model: model.trim(),
      content: [{ type: 'text', text }],
      duration: item.targetDurationSeconds,
      ratio: renderSettings.ratio,
      resolution: renderSettings.resolution,
    },
  };
};

export const validateEffectSeedanceTaskResult = (
  snapshot: EffectSeedanceRequestSnapshot & {
    operation?: EffectSegmentRenderRequestSnapshot['operation'];
  },
  result: EffectSeedanceTaskResult,
): Array<'DURATION_MISMATCH' | 'RATIO_MISMATCH' | 'RESOLUTION_MISMATCH'> => {
  const issues: Array<'DURATION_MISMATCH' | 'RATIO_MISMATCH' | 'RESOLUTION_MISMATCH'> = [];
  if (result.duration !== undefined && Number(result.duration) !== snapshot.request.duration)
    issues.push('DURATION_MISMATCH');
  if (
    result.ratio !== undefined &&
    !ratioMatches(snapshot.request.ratio, result.ratio, snapshot.operation === 'REPAIR')
  )
    issues.push('RATIO_MISMATCH');
  if (
    result.resolution !== undefined &&
    result.resolution.toLocaleLowerCase('en-US') !== snapshot.request.resolution
  )
    issues.push('RESOLUTION_MISMATCH');
  return issues;
};

const ratioMatches = (
  expected: string,
  actual: string,
  allowAdaptiveRounding: boolean,
): boolean => {
  const normalizedExpected = expected.replace('：', ':');
  const normalizedActual = actual.replace('：', ':');
  if (normalizedExpected === normalizedActual) return true;
  if (!allowAdaptiveRounding) return false;
  const parse = (value: string): number | null => {
    const [width, height, ...rest] = value.split(':').map(Number);
    if (rest.length || !width || !height || width <= 0 || height <= 0) return null;
    return width / height;
  };
  const expectedValue = parse(normalizedExpected);
  const actualValue = parse(normalizedActual);
  if (expectedValue === null || actualValue === null) return false;
  return Math.abs(actualValue / expectedValue - 1) <= 0.03;
};
