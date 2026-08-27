import type {
  EffectPromptBatchResult,
  EffectPromptBatchResultV5,
  EffectPromptItem,
} from '@ai-marketing/contracts';
import {
  DEFAULT_EFFECT_PROMPT_FRAGMENT_CONFIGS,
  DEFAULT_EFFECT_PROMPT_SETTINGS,
} from '@ai-marketing/contracts';
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
  primaryPurpose: 'PRODUCT_DISPLAY',
  compatiblePurposes: ['PRODUCT_DISPLAY'],
  classificationStatus: 'VERIFIED',
  productRelevance: 95,
  materialTags: ['产品展示'],
  targetDurationSeconds: 5,
  dimensions: {
    narrative: '产品入画',
    scene: '家庭厨房',
    persona: '一名成年女性',
    productRelation: '切面油润可见',
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

  it('compiles a committed V5 item without inventing V6 classification data', () => {
    const current = batch('SEEDANCE_2_0');
    const currentItem = current.items[0]!;
    const baseItem = {
      id: currentItem.id,
      code: currentItem.code,
      origin: currentItem.origin,
      fragmentType: currentItem.fragmentType,
      materialTags: currentItem.materialTags,
      targetDurationSeconds: currentItem.targetDurationSeconds,
      dimensions: currentItem.dimensions,
      content: currentItem.content,
      insightBindings: currentItem.insightBindings,
      manualEdited: currentItem.manualEdited,
      createdAt: currentItem.createdAt,
      updatedAt: currentItem.updatedAt,
    };
    const legacy: EffectPromptBatchResultV5 = {
      ...current,
      schemaVersion: 5,
      settings: {
        fragmentConfigs: DEFAULT_EFFECT_PROMPT_FRAGMENT_CONFIGS,
        semanticLimit: 15,
        visualLimit: 20,
      },
      items: [
        {
          ...baseItem,
          dimensions: {
            narrative: baseItem.dimensions.narrative,
            scene: baseItem.dimensions.scene,
            persona: baseItem.dimensions.persona,
            sellingPoint: baseItem.dimensions.productRelation,
            camera: baseItem.dimensions.camera,
            emotion: baseItem.dimensions.emotion,
          },
        },
      ],
      metrics: {
        targetCount: 50,
        acceptedCount: 1,
        generatedCandidateCount: 1,
        fallbackCount: 0,
        removedSemanticDuplicates: 0,
        removedVisualDuplicates: 0,
        removedDimensionConflicts: 0,
        semanticDuplicateRate: 0,
        visualOverlapRate: 0,
        replenishmentRounds: 0,
        fragmentTypeDistribution: [],
        sellingPointCoverage: { required: [], covered: [], missing: [] },
        insightCoverage: {
          required: [],
          covered: [],
          missing: [],
          adaptive: [],
          deferred: [],
          excluded: [],
          appliedConstraints: [],
        },
        removedExecutionInvalid: 0,
        executionInvalidReasons: [],
      },
    };
    const compiled = compileEffectSeedanceRequest(legacy, item.id, 'seedance-model');
    expect(compiled.primaryPurpose).toBe('PRODUCT_DISPLAY');
    expect(compiled.compatiblePurposes).toEqual(['PRODUCT_DISPLAY']);
    expect(compiled.request.duration).toBe(5);
  });

  it('rejects a V6 item whose purpose evaluation is pending', () => {
    const current = batch('SEEDANCE_2_0');
    current.items[0] = { ...current.items[0]!, classificationStatus: 'PENDING' };
    expect(() => compileEffectSeedanceRequest(current, item.id, 'seedance-model')).toThrow(
      expect.objectContaining<Partial<EffectSeedanceCompileError>>({
        code: 'CLASSIFICATION_PENDING',
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
