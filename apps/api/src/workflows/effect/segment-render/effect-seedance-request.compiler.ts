import { createHash } from 'node:crypto';

import type {
  EffectPromptFragmentType,
  EffectPromptItem,
  EffectPromptItemV5,
  ReadableEffectPromptBatchResult,
  SeedanceRatio,
  SeedanceResolution,
} from '@ai-marketing/contracts';
import {
  EFFECT_PROMPT_RENDER_CAPABILITIES,
  EFFECT_PROMPT_LEGACY_SCHEMA_VERSION,
  EFFECT_PROMPT_SCHEMA_VERSION,
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
      | 'INVALID_BATCH_VERSION'
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

const compileText = (item: EffectPromptItem | EffectPromptItemV5, sharedPrompt: string): string => {
  const content = item.content.trim().replace(/。+$/gu, '');
  const shared = sharedPrompt.trim();
  if (!shared) return `${content}。`;
  if (content.endsWith(shared.replace(/。+$/gu, ''))) return `${content}。`;
  return `${content}。${shared}`;
};

export const compileEffectSeedanceRequest = (
  batch: ReadableEffectPromptBatchResult,
  promptId: string,
  model: string,
): EffectSeedanceRequestSnapshot => {
  if (
    batch.schemaVersion !== EFFECT_PROMPT_SCHEMA_VERSION &&
    batch.schemaVersion !== EFFECT_PROMPT_LEGACY_SCHEMA_VERSION
  )
    throw new EffectSeedanceCompileError('INVALID_BATCH_VERSION', '仅支持已提交的 Prompt 批次');
  const item = batch.items.find(({ id }) => id === promptId);
  if (!item) throw new EffectSeedanceCompileError('PROMPT_NOT_FOUND', 'Prompt 不存在');
  if ('classificationStatus' in item && item.classificationStatus !== 'VERIFIED')
    throw new EffectSeedanceCompileError(
      'CLASSIFICATION_PENDING',
      'Prompt 尚未完成用途评估，不能进入视频渲染',
    );
  if (!model.trim()) throw new EffectSeedanceCompileError('EMPTY_MODEL', 'Seedance 模型配置为空');
  const capability = EFFECT_PROMPT_RENDER_CAPABILITIES[batch.renderProfile.capabilityKey];
  if (
    item.targetDurationSeconds < capability.minDurationSeconds ||
    item.targetDurationSeconds > capability.maxDurationSeconds
  )
    throw new EffectSeedanceCompileError(
      'DURATION_UNSUPPORTED',
      `当前模型仅支持 ${capability.minDurationSeconds}～${capability.maxDurationSeconds} 秒`,
    );
  if (!capability.ratios.includes(batch.renderProfile.ratio))
    throw new EffectSeedanceCompileError('RATIO_UNSUPPORTED', '当前模型不支持所选画幅');
  if (!capability.resolutions.includes(batch.renderProfile.resolution))
    throw new EffectSeedanceCompileError('RESOLUTION_UNSUPPORTED', '当前模型不支持所选分辨率');
  const sharedPromptContent =
    batch.sharedPrompt?.compiledContent ??
    compileEffectPromptSharedConstraintPrompt(
      batch.renderProfile.sharedConstraints.disabledElements,
    );
  const text = compileText(item, sharedPromptContent);
  return {
    promptId: item.id,
    primaryPurpose: 'primaryPurpose' in item ? item.primaryPurpose : item.fragmentType,
    compatiblePurposes:
      'compatiblePurposes' in item ? [...item.compatiblePurposes] : [item.fragmentType],
    promptContentHash: createHash('sha256').update(item.content).digest('hex'),
    sharedPromptHash:
      batch.sharedPrompt?.contentHash ?? batch.renderProfile.sharedConstraints.contentHash,
    request: {
      model: model.trim(),
      content: [{ type: 'text', text }],
      duration: item.targetDurationSeconds,
      ratio: batch.renderProfile.ratio,
      resolution: batch.renderProfile.resolution,
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
