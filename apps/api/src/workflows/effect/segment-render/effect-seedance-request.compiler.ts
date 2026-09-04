import { createHash } from 'node:crypto';

import type {
  EffectPromptFragmentType,
  EffectPromptItem,
  EffectPromptBatchResult,
  EffectSegmentRenderSettings,
  SeedanceRatio,
  SeedanceResolution,
} from '@ai-marketing/contracts';
import {
  EFFECT_PROMPT_DIMENSIONS,
  EFFECT_PROMPT_RENDER_CAPABILITIES,
} from '@ai-marketing/contracts';
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
      | 'EMPTY_MODEL',
    message: string,
  ) {
    super(message);
    this.name = 'EffectSeedanceCompileError';
  }
}

const compileText = (item: EffectPromptItem, sharedPrompt: string): string => {
  const content = item.content.trim().replace(/。+$/gu, '');
  const creativeCore = item.creativeCore.trim().replace(/。+$/gu, '');
  const dimensions = EFFECT_PROMPT_DIMENSIONS.map(
    ({ key, label }) => `${label}：${item.dimensions[key].trim().replace(/。+$/gu, '')}`,
  ).join('；');
  const structuredPrompt = [
    `创意主线：${creativeCore}。`,
    `六维创意信息：${dimensions}。`,
    `片段生成 Prompt：${content}。`,
  ].join('\n');
  const shared = sharedPrompt.trim();
  if (!shared) return structuredPrompt;
  if (content.endsWith(shared.replace(/。+$/gu, ''))) return structuredPrompt;
  return `${structuredPrompt}\n${shared}`;
};

const promptContentHash = (item: EffectPromptItem): string =>
  createHash('sha256')
    .update(
      JSON.stringify({
        content: item.content,
        creativeCore: item.creativeCore,
        dimensions: item.dimensions,
      }),
    )
    .digest('hex');

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
  snapshot: EffectSeedanceRequestSnapshot,
  result: EffectSeedanceTaskResult,
): Array<'DURATION_MISMATCH' | 'RATIO_MISMATCH' | 'RESOLUTION_MISMATCH'> => {
  const issues: Array<'DURATION_MISMATCH' | 'RATIO_MISMATCH' | 'RESOLUTION_MISMATCH'> = [];
  if (result.duration !== undefined && Number(result.duration) !== snapshot.request.duration)
    issues.push('DURATION_MISMATCH');
  if (result.ratio !== undefined && result.ratio.replace('：', ':') !== snapshot.request.ratio)
    issues.push('RATIO_MISMATCH');
  if (
    result.resolution !== undefined &&
    result.resolution.toLocaleLowerCase('en-US') !== snapshot.request.resolution
  )
    issues.push('RESOLUTION_MISMATCH');
  return issues;
};
