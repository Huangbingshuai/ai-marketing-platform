import type { EffectPromptBatchSettings, EffectPromptItem } from '@ai-marketing/contracts';
import { describe, expect, it } from 'vitest';

import {
  dimensionDistance,
  effectPromptExecutionIssues,
  mergeEffectPromptCompletionItems,
  parseEffectPromptBatchResult,
  promptPairViolationRate,
  recomputePromptQuality,
  trigramDice,
  visualOverlap,
} from './effect-prompt.quality';

const settings: EffectPromptBatchSettings = {
  count: 10,
  durationSeconds: 5,
  semanticLimit: 15,
  visualLimit: 20,
  styleOverride: null,
  fragmentTypeWeights: {
    HOOK: 16,
    PAIN: 14,
    PRODUCT_DISPLAY: 18,
    EFFECT_DEMONSTRATION: 18,
    SELLING_POINT_EXPLANATION: 16,
    CTA: 10,
    OUTRO: 8,
  },
  sellingPointWeights: [],
  additionalDisabledElements: [],
};

const item = (id: string, overrides: Partial<EffectPromptItem> = {}): EffectPromptItem => ({
  id,
  code: id,
  origin: 'AI',
  fragmentType: 'HOOK',
  materialTags: ['钩子', id],
  targetDurationSeconds: 5,
  dimensions: {
    narrative: `叙事-${id}`,
    scene: `场景-${id}`,
    persona: `人物-${id}`,
    sellingPoint: `卖点-${id}`,
    camera: `镜头-${id}`,
    emotion: `情绪-${id}`,
  },
  content: `家庭厨房中，一位穿围裙的成年人拿起产品并转向镜头，微距推进展示外观 ${id}`,
  manualEdited: false,
  createdAt: '2026-08-25T00:00:00.000Z',
  updatedAt: '2026-08-25T00:00:00.000Z',
  ...overrides,
});

describe('effect prompt quality', () => {
  it('uses Chinese character 3-gram Dice after removing fixed video parameters', () => {
    expect(
      trigramDice(
        '展示产品核心卖点。视频时长：15秒；画幅：9:16',
        '展示产品核心卖点。视频时长：30秒；画幅：16:9',
      ),
    ).toBe(1);
  });

  it('uses the frozen visual weights and dimension Hamming distance', () => {
    const left = item('left');
    const right = item('right', {
      dimensions: {
        narrative: '另一叙事',
        scene: left.dimensions.scene,
        persona: left.dimensions.persona,
        sellingPoint: '另一卖点',
        camera: left.dimensions.camera,
        emotion: '另一情绪',
      },
    });
    expect(visualOverlap(left, right)).toBeCloseTo(0.85);
    expect(dimensionDistance(left, right)).toBe(3);
  });

  it('calculates violation rate from violating pairs divided by all pairs', () => {
    const first = item('one');
    const duplicate = item('two', {
      dimensions: { ...first.dimensions },
      content: first.content,
    });
    const distinct = item('three', { content: '完全不同的户外专业测评拍摄内容' });
    const result = recomputePromptQuality([first, duplicate, distinct], settings);
    expect(result.metrics.semanticDuplicateRate).toBeCloseTo(33.33);
    expect(result.metrics.visualOverlapRate).toBeCloseTo(33.33);
    expect(result.qualityStatus).toBe('NEEDS_REVIEW');
  });

  it('rounds pair rates half-up identically to the Worker golden vector', () => {
    expect(promptPairViolationRate(63, 64)).toBe(3.13);
  });

  it('rejects incomplete six-dimensional items', () => {
    const invalid = item('invalid');
    invalid.dimensions.camera = '';
    expect(
      parseEffectPromptBatchResult({
        schemaVersion: 2,
        settings,
        items: [invalid],
        metrics: {},
        qualityStatus: 'PASS',
      }),
    ).toBeNull();
  });

  it('enforces the shared schema text limits', () => {
    const valid = recomputePromptQuality([item('valid')], settings);
    const oversizedContent = { ...item('long'), content: '字'.repeat(12_001) };
    expect(parseEffectPromptBatchResult({ ...valid, items: [oversizedContent] })).toBeNull();

    const oversizedDimension = item('dimension');
    oversizedDimension.dimensions.sellingPoint = '卖'.repeat(241);
    expect(parseEffectPromptBatchResult({ ...valid, items: [oversizedDimension] })).toBeNull();
  });

  it('blocks legacy full-video results and flags non-executable meta timelines', () => {
    const invalid = item('legacy', {
      content:
        '痛点前置型：面向全国消费者完成单一卖点表达，前段建立情境，中段展示工艺，结尾回到产品主体。',
    });
    expect(effectPromptExecutionIssues(invalid)).toEqual(
      expect.arrayContaining([
        'META_LANGUAGE',
        'ABSTRACT_PERSONA',
        'FULL_TIMELINE_NOT_FRAGMENT',
        'NO_VISIBLE_ACTION',
      ]),
    );
    const result = recomputePromptQuality([invalid], settings);
    expect(result.metrics.executionInvalidReasons.length).toBeGreaterThan(0);
    expect(parseEffectPromptBatchResult({ ...result, schemaVersion: 1 })).toBeNull();
  });

  it('recomputes fragment-label targets and required selling-point coverage', () => {
    const weightedSettings: EffectPromptBatchSettings = {
      ...settings,
      sellingPointWeights: [
        { sellingPoint: '卖点-one', weight: 50 },
        { sellingPoint: '待覆盖卖点', weight: 50 },
      ],
    };
    const result = recomputePromptQuality([item('one')], weightedSettings);

    expect(
      result.metrics.fragmentTypeDistribution.reduce(
        (sum, distribution) => sum + distribution.targetCount,
        0,
      ),
    ).toBe(weightedSettings.count);
    expect(result.metrics.sellingPointCoverage).toMatchObject({
      required: ['卖点-one', '待覆盖卖点'],
      missing: ['待覆盖卖点'],
    });
    expect(result.qualityStatus).toBe('NEEDS_REVIEW');
  });

  it('records a uniform fragment-duration mismatch in the deterministic gate', () => {
    const result = recomputePromptQuality(
      [item('duration', { targetDurationSeconds: 7 })],
      settings,
    );
    expect(result.metrics.executionInvalidReasons).toContainEqual({
      code: 'DURATION_MISMATCH',
      count: 1,
    });
    expect(result.qualityStatus).toBe('NEEDS_REVIEW');
  });

  it('replaces only the requested item while preserving stable order and ids', () => {
    const before = [item('one'), item('target'), item('three')];
    const replacement = item('new', {
      code: 'NEW',
      content: '重新生成的全新内容',
      createdAt: '2026-08-25T01:00:00.000Z',
      updatedAt: '2026-08-25T01:00:00.000Z',
    });
    const merged = mergeEffectPromptCompletionItems([replacement], {
      schemaVersion: 2,
      projectId: 'project',
      workflowRunId: 'workflow',
      productId: 'product',
      operation: 'ITEM_REGENERATE',
      targetItemId: 'target',
      settings,
      insightArtifact: { id: 'insight', revision: 1, contentHash: 'hash', result: {} },
      retainedManualItems: [before[0]!, before[2]!],
      targetItem: before[1],
      targetItemIndex: 1,
      baseResultRevision: 3,
    });

    expect(merged.map(({ id }) => id)).toEqual(['one', 'target', 'three']);
    expect(merged[1]).toMatchObject({
      id: 'target',
      code: 'target',
      content: '重新生成的全新内容',
      origin: 'AI',
      manualEdited: false,
      createdAt: before[1]!.createdAt,
    });
    expect(merged[0]).toBe(before[0]);
    expect(merged[2]).toBe(before[2]);
  });
});
