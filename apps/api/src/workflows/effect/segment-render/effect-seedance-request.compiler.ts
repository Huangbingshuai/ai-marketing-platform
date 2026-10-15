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

export type EffectSeedanceRequestSnapshot = Pick<
  EffectSegmentRenderRequestSnapshot,
  'creativeCore' | 'dimensions' | 'promptDurationMaxSeconds'
> & {
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

const compileText = (item: Pick<EffectPromptItem, 'content'>, sharedPrompt: string): string => {
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
  const durationMs = inputVideo.durationSeconds * 1000;
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
    `输出时长保持 ${generationSnapshot.request.duration} 秒，输出分辨率 ${generationSnapshot.request.resolution}；沿用参考视频的画幅、镜头顺序和时间节奏。`,
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
      duration:
        repair.providerMode === 'VIDEO_REFERENCE'
          ? Math.round(inputVideo.durationSeconds)
          : inputVideo.durationSeconds,
    },
  };
};

export const compileEffectImportedSeedanceRequest = (
  previous: EffectSegmentRenderRequestSnapshot,
  model: string,
  settings: EffectSegmentRenderSettings,
  batch: EffectPromptBatchResult,
): EffectSegmentRenderRequestSnapshot => {
  const rawDuration = previous.outputDurationSeconds ?? previous.request.duration;
  if (!Number.isFinite(rawDuration) || rawDuration < 4 || rawDuration > 30)
    throw new EffectSeedanceCompileError('DURATION_UNSUPPORTED', '导入视频仅支持 4～30 秒');
  const capability = EFFECT_PROMPT_RENDER_CAPABILITIES[settings.capabilityKey];
  const maxDuration =
    settings.capabilityKey === 'SEEDANCE_1_5_PRO' ? 30 : capability.maxDurationSeconds;
  const duration = Math.round(rawDuration);
  if (duration > maxDuration || duration < capability.minDurationSeconds)
    throw new EffectSeedanceCompileError(
      'DURATION_UNSUPPORTED',
      `当前模型仅支持 ${capability.minDurationSeconds}～${maxDuration} 秒`,
    );
  if (!model.trim()) throw new EffectSeedanceCompileError('EMPTY_MODEL', 'Seedance 模型配置为空');
  if (!capability.ratios.includes(settings.ratio))
    throw new EffectSeedanceCompileError('RATIO_UNSUPPORTED', '当前模型不支持所选画幅');
  if (!capability.resolutions.includes(settings.resolution))
    throw new EffectSeedanceCompileError('RESOLUTION_UNSUPPORTED', '当前模型不支持所选分辨率');
  if (!previous.promptText.trim())
    throw new EffectSeedanceCompileError('INVALID_BATCH', '请先确认导入素材的提示词');
  const shared =
    batch.sharedPrompt?.compiledContent ??
    compileEffectPromptSharedConstraintPrompt(
      batch.renderProfile.sharedConstraints.disabledElements,
    );
  const {
    outputDurationSeconds: _previousOutputDuration,
    outputRatio: _previousOutputRatio,
    ...source
  } = previous;
  return {
    ...source,
    operation: 'GENERATE',
    inputVideo: null,
    repair: null,
    renderSettings: settings,
    promptContentHash: createHash('sha256').update(previous.promptText.trim()).digest('hex'),
    sharedPromptHash:
      batch.sharedPrompt?.contentHash ?? batch.renderProfile.sharedConstraints.contentHash,
    renderSettingsHash: createHash('sha256').update(JSON.stringify(settings)).digest('hex'),
    request: {
      model: model.trim(),
      content: [{ type: 'text', text: compileText({ content: previous.promptText }, shared) }],
      duration,
      ratio: settings.ratio,
      resolution: settings.resolution,
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
  const maxDuration =
    item.origin === 'MANUAL' && renderSettings.capabilityKey === 'SEEDANCE_1_5_PRO'
      ? 30
      : capability.maxDurationSeconds;
  if (
    item.targetDurationSeconds < capability.minDurationSeconds ||
    item.targetDurationSeconds > maxDuration
  )
    throw new EffectSeedanceCompileError(
      'DURATION_UNSUPPORTED',
      `当前模型仅支持 ${capability.minDurationSeconds}～${maxDuration} 秒`,
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
    creativeCore: item.creativeCore,
    dimensions: { ...item.dimensions },
    promptDurationMaxSeconds: batch.settings.defaultDurationSeconds,
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
    inputVideo?: EffectSegmentRenderInputVideo | null;
    repair?: EffectSegmentRenderRepairInput | null;
  },
  result: EffectSeedanceTaskResult,
): Array<'DURATION_MISMATCH' | 'RATIO_MISMATCH' | 'RESOLUTION_MISMATCH'> => {
  const issues: Array<'DURATION_MISMATCH' | 'RATIO_MISMATCH' | 'RESOLUTION_MISMATCH'> = [];
  if (result.duration !== undefined) {
    const duration = Number(result.duration);
    const isVideoEdit =
      snapshot.operation === 'REPAIR' && snapshot.repair?.providerMode !== 'VIDEO_REFERENCE';
    const expected = isVideoEdit
      ? (snapshot.inputVideo?.durationSeconds ?? snapshot.request.duration)
      : snapshot.request.duration;
    const matches = isVideoEdit
      ? duration <= expected + 0.001 && duration >= expected - 0.4 - 0.001
      : duration === expected;
    if (!Number.isFinite(duration) || duration <= 0 || !matches) issues.push('DURATION_MISMATCH');
  }
  if (
    result.ratio !== undefined &&
    !ratioMatches(
      snapshot.operation === 'REPAIR' && snapshot.repair?.providerMode !== 'VIDEO_REFERENCE'
        ? (snapshot.inputVideo?.ratio ?? snapshot.request.ratio)
        : snapshot.request.ratio,
      result.ratio,
      snapshot.operation === 'REPAIR' && snapshot.repair?.providerMode !== 'VIDEO_REFERENCE',
    )
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
  const parse = (value: string): number | null => {
    if (!/^\d+(?:\.\d+)?:\d+(?:\.\d+)?$/u.test(value)) return null;
    const [width, height, ...rest] = value.split(':').map(Number);
    if (
      rest.length ||
      !Number.isFinite(width) ||
      !Number.isFinite(height) ||
      !width ||
      !height ||
      width <= 0 ||
      height <= 0
    )
      return null;
    const ratio = width / height;
    return Number.isFinite(ratio) && ratio > 0 ? ratio : null;
  };
  const actualValue = parse(normalizedActual);
  // Adaptive is a selection strategy, not the concrete ratio echoed by Seedance.
  if (normalizedExpected === 'adaptive') return actualValue !== null;
  if (!allowAdaptiveRounding) return false;
  const expectedValue = parse(normalizedExpected);
  if (expectedValue === null || actualValue === null) return false;
  return Math.abs(actualValue / expectedValue - 1) <= 0.03;
};
