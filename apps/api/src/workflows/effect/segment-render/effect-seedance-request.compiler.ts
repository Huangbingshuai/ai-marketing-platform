import { createHash } from 'node:crypto';

import type {
  EffectPromptBatchResult,
  EffectPromptItem,
  SeedanceRatio,
  SeedanceResolution,
} from '@ai-marketing/contracts';
import {
  EFFECT_PROMPT_RENDER_CAPABILITIES,
  EFFECT_PROMPT_SCHEMA_VERSION,
} from '@ai-marketing/contracts';

export type EffectSeedanceCreateTaskRequest = {
  model: string;
  content: [{ type: 'text'; text: string }];
  duration: number;
  ratio: SeedanceRatio;
  resolution: SeedanceResolution;
};

export type EffectSeedanceRequestSnapshot = {
  promptId: string;
  promptContentHash: string;
  sharedConstraintHash: string;
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

const normalizedUnique = (values: readonly string[]): string[] => {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    const value = raw
      .normalize('NFC')
      .replace(/\s+/gu, ' ')
      .trim()
      .replace(/[。；;，,]+$/gu, '');
    const key = value.toLocaleLowerCase('zh-CN');
    if (value && !seen.has(key)) {
      seen.add(key);
      result.push(value);
    }
  }
  return result;
};

const compileText = (item: EffectPromptItem, disabledElements: readonly string[]): string => {
  const content = item.content.trim().replace(/。+$/gu, '');
  const disabled = normalizedUnique(disabledElements);
  return disabled.length ? `${content}。全程避免出现：${disabled.join('、')}。` : `${content}。`;
};

export const compileEffectSeedanceRequest = (
  batch: EffectPromptBatchResult,
  promptId: string,
  model: string,
): EffectSeedanceRequestSnapshot => {
  if (batch.schemaVersion !== EFFECT_PROMPT_SCHEMA_VERSION)
    throw new EffectSeedanceCompileError('INVALID_BATCH_VERSION', '仅支持已提交的 Prompt V5 批次');
  const item = batch.items.find(({ id }) => id === promptId);
  if (!item) throw new EffectSeedanceCompileError('PROMPT_NOT_FOUND', 'Prompt 不存在');
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
  const text = compileText(item, batch.renderProfile.sharedConstraints.disabledElements);
  return {
    promptId: item.id,
    promptContentHash: createHash('sha256').update(item.content).digest('hex'),
    sharedConstraintHash: batch.renderProfile.sharedConstraints.contentHash,
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
