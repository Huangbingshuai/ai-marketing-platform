import type { EffectPromptBatchResult, EffectPromptItem } from '@ai-marketing/contracts';
import { DEFAULT_EFFECT_PROMPT_SETTINGS } from '@ai-marketing/contracts';
import { describe, expect, it } from 'vitest';

import {
  compileEffectSeedanceRequest,
  type EffectSeedanceCompileError,
  validateEffectSeedanceTaskResult,
} from './effect-seedance-request.compiler';
import {
  compileEffectPromptSharedPrompt,
  recomputePromptQuality,
} from '../prompt-generation/effect-prompt.quality';

const item: EffectPromptItem = {
  id: 'prompt-1',
  code: 'P001',
  origin: 'AI',
  fragmentType: 'PRODUCT_DISPLAY',
  materialTags: ['产品展示'],
  targetDurationSeconds: 5,
  dimensions: {
    narrative: '产品入画',
    scene: '家庭厨房',
    persona: '一名成年女性',
    sellingPoint: '切面油润可见',
    camera: '低机位近景缓慢推近',
    emotion: '暖调自然光',
  },
  content:
    '家庭厨房里，一名成年女性拿起广式腊肠并轻放到木质案板中央，低机位近景缓慢推近，暖调自然光勾出真实切面，结束时产品保持清楚可辨。',
  insightBindings: [],
  manualEdited: false,
  createdAt: '2026-08-26T00:00:00.000Z',
  updatedAt: '2026-08-26T00:00:00.000Z',
};

const batch = (capabilityKey: EffectPromptBatchResult['renderProfile']['capabilityKey']) => {
  const disabledElements = ['医疗功效', '未成年人'];
  return recomputePromptQuality(
    [item],
    DEFAULT_EFFECT_PROMPT_SETTINGS,
    undefined,
    {
      ratio: '9:16',
      resolution: '1080p',
      capabilityKey,
      sharedConstraints: {
        disabledElements,
        contentHash: 'a'.repeat(64),
      },
    },
    compileEffectPromptSharedPrompt(disabledElements, '保持产品外观前后一致。'),
  ) as EffectPromptBatchResult;
};

describe('effect Seedance request compiler', () => {
  it('keeps technical settings outside the visible prompt and appends shared constraints once', () => {
    const compiled = compileEffectSeedanceRequest(batch('SEEDANCE_2_0'), item.id, 'seedance-model');
    expect(compiled.request).toMatchObject({
      duration: 5,
      ratio: '9:16',
      resolution: '1080p',
    });
    expect(compiled.request.content[0].text).toContain(
      '画面中不得出现以下内容：医疗功效；未成年人。\n保持产品外观前后一致。',
    );
    expect(compiled.request.content[0].text.match(/医疗功效/gu)).toHaveLength(1);
    expect(compiled.sharedPromptHash).toBe(batch('SEEDANCE_2_0').sharedPrompt?.contentHash);
    expect(item.content).not.toContain('9:16');
  });

  it('rejects 1080p for Seedance 2.0 fast without silent downgrade', () => {
    expect(() => compileEffectSeedanceRequest(batch('SEEDANCE_2_0_FAST'), item.id, 'fast')).toThrow(
      expect.objectContaining<Partial<EffectSeedanceCompileError>>({
        code: 'RESOLUTION_UNSUPPORTED',
      }),
    );
  });

  it('checks the echoed task parameters against the immutable request snapshot', () => {
    const snapshot = compileEffectSeedanceRequest(batch('SEEDANCE_2_0'), item.id, 'seedance-model');
    expect(
      validateEffectSeedanceTaskResult(snapshot, {
        duration: '4',
        ratio: '16:9',
        resolution: '720P',
      }),
    ).toEqual(['DURATION_MISMATCH', 'RATIO_MISMATCH', 'RESOLUTION_MISMATCH']);
  });
});
