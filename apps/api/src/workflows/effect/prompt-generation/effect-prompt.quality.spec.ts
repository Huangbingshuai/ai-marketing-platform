import { createHash } from 'node:crypto';

import type { EffectPromptItem } from '@ai-marketing/contracts';
import { DEFAULT_EFFECT_PROMPT_SETTINGS } from '@ai-marketing/contracts';
import { describe, expect, it } from 'vitest';

import {
  compileEffectPromptSharedPrompt,
  defaultEffectPromptRenderProfile,
  isEffectPromptItem,
  parseEffectPromptBatchResult,
  mergeEffectPromptCompletionItems,
  parseEffectPromptSemanticAudit,
  recomputePromptQuality,
  semanticEvaluationAfterDeletion,
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
  creativeCore: '家庭厨房中的产品切面展示',
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

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

const auditFor = (items: EffectPromptItem[], pairs: Array<[string, string]>) => {
  const evaluatedItems = items
    .map(({ id, content }) => ({
      itemId: id,
      contentHash: sha256(content.normalize('NFKC').trim()),
    }))
    .sort((left, right) => left.itemId.localeCompare(right.itemId, 'en-US'));
  return {
    schemaVersion: 1,
    similarityThreshold: 0.82,
    evaluatedItems,
    duplicatePairs: pairs.map(([leftItemId, rightItemId]) => ({ leftItemId, rightItemId })),
    contentFingerprint: sha256(JSON.stringify(evaluatedItems)),
  };
};

describe('effect prompt quality contract', () => {
  it('requires purpose projection and productRelation', () => {
    expect(isEffectPromptItem(item('001'))).toBe(true);
    expect(isEffectPromptItem({ ...item('002'), fragmentType: 'HOOK' })).toBe(false);
    expect(isEffectPromptItem({ ...item('003'), compatiblePurposes: ['HOOK'] })).toBe(false);
  });

  it('restores creative core from narrative for existing stored items', () => {
    const existing = item('legacy');
    const withoutCreativeCore: Partial<EffectPromptItem> = { ...existing };
    delete withoutCreativeCore.creativeCore;
    const result = recomputePromptQuality([existing], {
      targetCount: 1,
      defaultDurationSeconds: 5,
    });
    const parsed = parseEffectPromptBatchResult({ ...result, items: [withoutCreativeCore] });

    expect(parsed?.items[0]?.creativeCore).toBe(existing.dimensions.narrative);
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
      {
        status: 'VERIFIED',
        evaluatedCount: 10,
        duplicateGroupCount: 0,
        duplicateCount: 0,
        duplicateRate: 0,
      },
    );
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
    expect(result.metrics.semanticEvaluation.duplicateRate).toBe(0);
    expect(
      parseEffectPromptBatchResult({
        ...result,
        metrics: { ...result.metrics, replenishmentRounds: 3 },
      })?.metrics.replenishmentRounds,
    ).toBe(3);
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

  it('does not treat product identity alone as deep insight usage', () => {
    const requiredFact = {
      factId: 'CORE_SELLING_POINT:confirmed',
      field: 'CORE_SELLING_POINT' as const,
      value: '广府酒香腌制工艺',
      valueHash: sha256('广府酒香腌制工艺'),
    };
    const productOnly = {
      ...item('identity-only'),
      insightBindings: [
        {
          factId: 'PRODUCT_NAME:confirmed',
          field: 'PRODUCT_NAME' as const,
          value: '广式腊肠',
          valueHash: sha256('广式腊肠'),
          role: 'PRIMARY' as const,
        },
      ],
    };
    const deeplyBound = {
      ...item('deeply-bound'),
      insightBindings: [{ ...requiredFact, role: 'CONTEXT' as const }],
    };
    const result = recomputePromptQuality(
      [productOnly, deeplyBound],
      { targetCount: 2, defaultDurationSeconds: 5 },
      {
        insightCoverage: {
          required: [requiredFact],
          covered: [],
          missing: [requiredFact],
          adaptive: [],
          deferred: [],
          excluded: [],
          appliedConstraints: [],
        },
      },
      defaultEffectPromptRenderProfile(),
      compileEffectPromptSharedPrompt([]),
      {
        status: 'VERIFIED',
        evaluatedCount: 2,
        duplicateGroupCount: 0,
        duplicateCount: 0,
        duplicateRate: 0,
      },
    );

    expect(result.metrics.hardIssueCounts).toContainEqual({
      code: 'MISSING_DEEP_BUSINESS_FACT',
      count: 1,
    });
    expect(result.qualityStatus).toBe('NEEDS_REVIEW');
  });

  it('requires semantic duplicate rate to be strictly below fifteen percent', () => {
    const items = Array.from({ length: 20 }, (_, index) =>
      item(`00000000-0000-4000-8000-${String(index).padStart(12, '0')}`),
    );
    const result = recomputePromptQuality(
      items,
      { targetCount: 20, defaultDurationSeconds: 5 },
      undefined,
      defaultEffectPromptRenderProfile(),
      compileEffectPromptSharedPrompt([]),
      {
        status: 'VERIFIED',
        evaluatedCount: 20,
        duplicateGroupCount: 1,
        duplicateCount: 3,
        duplicateRate: 15,
      },
    );
    expect(result.qualityStatus).toBe('NEEDS_REVIEW');
  });

  it('allows seven but blocks eight semantic duplicates in a fifty-item batch', () => {
    const items = Array.from({ length: 50 }, (_, index) =>
      item(`00000000-0000-4000-8000-${String(index).padStart(12, '0')}`),
    );
    const evaluate = (duplicateCount: number) =>
      recomputePromptQuality(
        items,
        { targetCount: 50, defaultDurationSeconds: 5 },
        undefined,
        defaultEffectPromptRenderProfile(),
        compileEffectPromptSharedPrompt([]),
        {
          status: 'VERIFIED',
          evaluatedCount: 50,
          duplicateGroupCount: 1,
          duplicateCount,
          duplicateRate: duplicateCount * 2,
        },
      );

    expect(evaluate(7).qualityStatus).toBe('PASS');
    expect(evaluate(8).qualityStatus).toBe('NEEDS_REVIEW');
  });

  it('recalculates connected duplicate groups after a deletion from a trusted audit', () => {
    const items = Array.from({ length: 10 }, (_, index) =>
      item(`00000000-0000-4000-8000-${String(index).padStart(12, '0')}`),
    );
    const rawAudit = auditFor(items, [
      [items[0]!.id, items[1]!.id],
      [items[1]!.id, items[2]!.id],
      [items[5]!.id, items[6]!.id],
    ]);
    const audit = parseEffectPromptSemanticAudit(rawAudit, items);
    expect(audit).not.toBeNull();
    expect(
      semanticEvaluationAfterDeletion(
        items.filter(({ id }) => id !== items[1]!.id),
        audit!,
      ),
    ).toEqual({
      status: 'VERIFIED',
      evaluatedCount: 9,
      duplicateGroupCount: 1,
      duplicateCount: 1,
      duplicateRate: 11.11,
    });
    expect(
      semanticEvaluationAfterDeletion(
        items.map((row, index) => (index === 0 ? { ...row, content: '正文已变化' } : row)),
        audit!,
      ).status,
    ).toBe('PENDING');
  });

  it('keeps historical results without semantic evaluation pending', () => {
    const result = recomputePromptQuality([item('legacy')], {
      targetCount: 1,
      defaultDurationSeconds: 5,
    });
    const legacyMetrics: Partial<typeof result.metrics> = { ...result.metrics };
    delete legacyMetrics.semanticEvaluation;
    const parsed = parseEffectPromptBatchResult({ ...result, metrics: legacyMetrics });
    expect(parsed?.metrics.semanticEvaluation).toEqual({
      status: 'PENDING',
      evaluatedCount: 0,
      duplicateGroupCount: null,
      duplicateCount: null,
      duplicateRate: null,
    });
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
      selectionPolicy: 'MMR_CONTENT',
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
