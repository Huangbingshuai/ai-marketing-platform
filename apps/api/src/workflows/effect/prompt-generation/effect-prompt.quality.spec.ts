import type {
  EffectPromptBatchResultV5,
  EffectPromptItem,
  EffectPromptItemV5,
} from '@ai-marketing/contracts';
import {
  DEFAULT_EFFECT_PROMPT_FRAGMENT_CONFIGS,
  DEFAULT_EFFECT_PROMPT_SETTINGS,
} from '@ai-marketing/contracts';
import { describe, expect, it } from 'vitest';

import {
  compileEffectPromptSharedPrompt,
  defaultEffectPromptRenderProfile,
  isEffectPromptItem,
  parseEffectPromptBatchResult,
  parseEffectPromptBatchResultV5ForRead,
  mergeEffectPromptCompletionItems,
  recomputePromptQuality,
} from './effect-prompt.quality';

const item = (id: string, content = `产品创意画面 ${id}`): EffectPromptItem => ({
  id,
  code: `P${id}`,
  origin: 'AI',
  fragmentType: 'PRODUCT_DISPLAY',
  primaryPurpose: 'PRODUCT_DISPLAY',
  compatiblePurposes: ['PRODUCT_DISPLAY', 'HOOK'],
  classificationStatus: 'VERIFIED',
  productRelevance: 92,
  materialTags: ['产品展示'],
  targetDurationSeconds: 5,
  dimensions: {
    narrative: '单镜头状态变化',
    scene: '家庭厨房',
    persona: '成年使用者手部',
    productRelation: '广式腊肠切面与食用动作',
    camera: '近景缓慢推进',
    emotion: '温暖自然',
  },
  content,
  insightBindings: [],
  manualEdited: false,
  createdAt: '2026-08-27T00:00:00.000Z',
  updatedAt: '2026-08-27T00:00:00.000Z',
});

describe('effect prompt V6 quality contract', () => {
  it('requires purpose projection and productRelation', () => {
    expect(isEffectPromptItem(item('001'))).toBe(true);
    expect(isEffectPromptItem({ ...item('002'), fragmentType: 'HOOK' })).toBe(false);
    expect(isEffectPromptItem({ ...item('003'), compatiblePurposes: ['HOOK'] })).toBe(false);
  });

  it('computes exact-count, purpose and lightweight issue metrics', () => {
    const contents = [
      '厨房切面',
      '餐桌装盘',
      '蒸笼开盖',
      '案板切片',
      '门店陈列',
      '礼盒展示',
      '早餐烹饪',
      '砂锅煲仔饭',
      '节庆餐桌',
      '包装入镜',
    ];
    const result = recomputePromptQuality(
      contents.map((content, index) => item(String(index + 1), content)),
      { targetCount: 10, defaultDurationSeconds: 5 },
      undefined,
      defaultEffectPromptRenderProfile(),
      compileEffectPromptSharedPrompt([]),
    );
    expect(result.schemaVersion).toBe(6);
    expect(result.items).toHaveLength(10);
    expect(result.metrics.hardIssueCounts).toEqual([]);
    expect(result.metrics.exactDuplicateCount).toBe(0);
    expect(result.qualityStatus).toBe('PASS');
    expect(result.metrics.acceptedCount).toBe(10);
    expect(result.metrics.purposeDistribution).toContainEqual({
      purpose: 'PRODUCT_DISPLAY',
      primaryCount: 10,
      compatibleCount: 10,
    });
    expect(result.metrics.averageScores.productRelevance).toBe(92);
  });

  it('keeps duplicate and pending classification as blocking issues', () => {
    const pending = { ...item('002'), classificationStatus: 'PENDING' as const };
    const result = recomputePromptQuality(
      [item('001'), { ...pending, content: item('001').content }],
      { targetCount: 2, defaultDurationSeconds: 5 },
    );
    expect(result.qualityStatus).toBe('NEEDS_REVIEW');
    expect(result.metrics.exactDuplicateCount).toBe(1);
    expect(result.metrics.hardIssueCounts).toEqual(
      expect.arrayContaining([
        { code: 'EXACT_DUPLICATE', count: 1 },
        { code: 'CLASSIFICATION_PENDING', count: 1 },
      ]),
    );
    const recomputed = recomputePromptQuality(result.items, result.settings, result.metrics);
    expect(recomputed.metrics.hardIssueCounts).toEqual(result.metrics.hardIssueCounts);
  });

  it('reads V5 without fabricating V6 purpose or score fields', () => {
    const legacyItem: EffectPromptItemV5 = {
      id: 'legacy-1',
      code: 'P001',
      origin: 'AI',
      fragmentType: 'HOOK',
      materialTags: ['钩子'],
      targetDurationSeconds: 5,
      dimensions: {
        narrative: '悬念',
        scene: '厨房',
        persona: '成年人',
        sellingPoint: '产品切面',
        camera: '近景',
        emotion: '好奇',
      },
      content: '历史 Prompt',
      insightBindings: [],
      manualEdited: false,
      createdAt: '2026-08-26T00:00:00.000Z',
      updatedAt: '2026-08-26T00:00:00.000Z',
    };
    const legacy: EffectPromptBatchResultV5 = {
      schemaVersion: 5,
      settings: {
        fragmentConfigs: DEFAULT_EFFECT_PROMPT_FRAGMENT_CONFIGS,
        semanticLimit: 15,
        visualLimit: 20,
      },
      renderProfile: defaultEffectPromptRenderProfile(),
      items: [legacyItem],
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
        fragmentTypeDistribution: [
          { fragmentType: 'HOOK', targetCount: 10, actualCount: 1 },
          { fragmentType: 'PAIN', targetCount: 8, actualCount: 0 },
          { fragmentType: 'PRODUCT_DISPLAY', targetCount: 12, actualCount: 0 },
          { fragmentType: 'SELLING_POINT_EXPLANATION', targetCount: 10, actualCount: 0 },
          { fragmentType: 'CTA', targetCount: 6, actualCount: 0 },
          { fragmentType: 'OUTRO', targetCount: 4, actualCount: 0 },
        ],
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
      qualityStatus: 'PASS',
    };
    expect(parseEffectPromptBatchResultV5ForRead(legacy)?.items[0]).toEqual(legacyItem);
    expect(parseEffectPromptBatchResult(legacy)).toBeNull();
    expect(DEFAULT_EFFECT_PROMPT_SETTINGS.targetCount).toBe(50);
  });

  it('ITEM_EVALUATE updates only classification data and keeps authored content intact', () => {
    const target = { ...item('target'), origin: 'MANUAL' as const, manualEdited: true };
    const evaluated = {
      ...target,
      content: '模型不应覆盖这段正文',
      dimensions: { ...target.dimensions, scene: '模型不应覆盖的场景' },
      fragmentType: 'HOOK' as const,
      primaryPurpose: 'HOOK' as const,
      compatiblePurposes: ['HOOK' as const, 'PRODUCT_DISPLAY' as const],
      classificationStatus: 'VERIFIED' as const,
      productRelevance: 88,
    };
    const merged = mergeEffectPromptCompletionItems([evaluated], {
      schemaVersion: 6,
      graphVersion: 'V11_COHERENT_CREATIVE_GENERATION',
      projectId: 'project-a',
      workflowRunId: 'workflow-a',
      productId: 'product-a',
      operation: 'ITEM_EVALUATE',
      targetItemId: target.id,
      settings: DEFAULT_EFFECT_PROMPT_SETTINGS,
      insightArtifact: { id: 'insight-a', revision: 1, contentHash: 'a'.repeat(64), result: {} },
      retainedManualItems: [],
      targetItem: target,
      targetItemIndex: 0,
      baseResultRevision: 1,
    });
    expect(merged[0]).toMatchObject({
      content: target.content,
      dimensions: target.dimensions,
      origin: 'MANUAL',
      manualEdited: true,
      primaryPurpose: 'HOOK',
      classificationStatus: 'VERIFIED',
      productRelevance: 88,
    });
  });
});
