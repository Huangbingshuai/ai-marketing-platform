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
  it('preserves unified long-text bindings and still accepts historical field names', () => {
    const entry = item('unified');
    entry.insightBindings = Array.from({ length: 8 }, (_, index) => ({
      factId: `SELLING_POINT:${index}`,
      field: 'SELLING_POINT', value: `${index}${'字'.repeat(999)}`,
      valueHash: 'a'.repeat(64), role: 'CONTEXT',
    }));
    expect(isEffectPromptItem(entry)).toBe(true);
    expect(entry.insightBindings).toHaveLength(8);
    entry.insightBindings[0]!.field = 'CORE_SELLING_POINT';
    expect(isEffectPromptItem(entry)).toBe(true);
    entry.insightBindings[0]!.value += '字';
    expect(isEffectPromptItem(entry)).toBe(false);
  });
  it('requires purpose projection and productRelation', () => {
    expect(isEffectPromptItem(item('001'))).toBe(true);
    expect(isEffectPromptItem({ ...item('002'), fragmentType: 'HOOK' })).toBe(false);
    expect(isEffectPromptItem({ ...item('003'), compatiblePurposes: ['HOOK'] })).toBe(false);
  });

  it('normalizes legacy stored items without exposing removed secondary tags', () => {
    const existing = item('legacy');
    const withoutCreativeCore: Partial<EffectPromptItem> = { ...existing };
    delete withoutCreativeCore.creativeCore;
    (withoutCreativeCore as Record<string, unknown>).materialTags = ['历史标签'];
    const result = recomputePromptQuality([existing], {
      targetCount: 1,
      defaultDurationSeconds: 5,
    });
    const parsed = parseEffectPromptBatchResult({ ...result, items: [withoutCreativeCore] });

    expect(parsed?.items[0]?.creativeCore).toBe(existing.dimensions.narrative);
    expect(parsed?.items[0]).not.toHaveProperty('materialTags');
  });

  it('keeps historical 16-to-30-second batches readable without accepting them as new items', () => {
    const historicalItem = { ...item('historical'), targetDurationSeconds: 30 };
    const current = recomputePromptQuality([item('current')], {
      ...DEFAULT_EFFECT_PROMPT_SETTINGS,
      targetCount: 10,
    });
    const parsed = parseEffectPromptBatchResult({
      ...current,
      settings: { ...current.settings, defaultDurationSeconds: 30 },
      items: [historicalItem],
    });

    expect(parsed?.settings.defaultDurationSeconds).toBe(30);
    expect(parsed?.items[0]?.targetDurationSeconds).toBe(30);
    expect(isEffectPromptItem(historicalItem)).toBe(false);
  });

  it('projects legacy six-purpose batches into the current four-purpose contract', () => {
    const currentItems = [item('pain'), item('selling'), item('outro')];
    const result = recomputePromptQuality(currentItems, {
      targetCount: 3,
      defaultDurationSeconds: 5,
    });
    const legacyItems = [
      {
        ...currentItems[0]!,
        fragmentType: 'PAIN',
        primaryPurpose: 'PAIN',
        compatiblePurposes: ['PAIN', 'HOOK'],
      },
      {
        ...currentItems[1]!,
        fragmentType: 'SELLING_POINT_EXPLANATION',
        primaryPurpose: 'SELLING_POINT_EXPLANATION',
        compatiblePurposes: ['SELLING_POINT_EXPLANATION', 'PRODUCT_DISPLAY'],
      },
      {
        ...currentItems[2]!,
        fragmentType: 'OUTRO',
        primaryPurpose: 'OUTRO',
        compatiblePurposes: ['OUTRO', 'CTA'],
      },
    ];
    const parsed = parseEffectPromptBatchResult({
      ...result,
      items: legacyItems,
      metrics: {
        ...result.metrics,
        purposeDistribution: [
          { purpose: 'HOOK', primaryCount: 0, compatibleCount: 1 },
          { purpose: 'PAIN', primaryCount: 1, compatibleCount: 1 },
          { purpose: 'PRODUCT_DISPLAY', primaryCount: 0, compatibleCount: 1 },
          { purpose: 'SELLING_POINT_EXPLANATION', primaryCount: 1, compatibleCount: 1 },
          { purpose: 'CTA', primaryCount: 0, compatibleCount: 1 },
          { purpose: 'OUTRO', primaryCount: 1, compatibleCount: 1 },
        ],
      },
    });

    expect(parsed?.items.map(({ primaryPurpose }) => primaryPurpose)).toEqual([
      'HOOK',
      'EFFECT',
      'CTA',
    ]);
    expect(parsed?.items.map(({ compatiblePurposes }) => compatiblePurposes)).toEqual([
      ['HOOK'],
      ['EFFECT', 'PRODUCT_DISPLAY'],
      ['CTA'],
    ]);
    expect(parsed?.metrics.purposeDistribution).toEqual([
      { purpose: 'HOOK', primaryCount: 1, compatibleCount: 1 },
      { purpose: 'PRODUCT_DISPLAY', primaryCount: 0, compatibleCount: 1 },
      { purpose: 'EFFECT', primaryCount: 1, compatibleCount: 1 },
      { purpose: 'CTA', primaryCount: 1, compatibleCount: 1 },
    ]);
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
    expect(result.metrics.purposeDistribution).toContainEqual({
      purpose: 'PRODUCT_DISPLAY',
      primaryCount: 1,
      compatibleCount: 1,
    });
    const recomputed = recomputePromptQuality(result.items, result.settings, result.metrics);
    expect(recomputed.metrics.hardIssueCounts).toEqual(result.metrics.hardIssueCounts);
  });

  it('accepts semantic evaluation statistics from an oversized candidate pool', () => {
    const items = Array.from({ length: 100 }, (_, index) =>
      item(String(index + 1), `产品创意画面 ${index + 1}`),
    );
    const result = recomputePromptQuality(
      items,
      { targetCount: 100, defaultDurationSeconds: 15 },
      undefined,
      defaultEffectPromptRenderProfile(),
      compileEffectPromptSharedPrompt([]),
      {
        status: 'VERIFIED',
        evaluatedCount: 142,
        duplicateGroupCount: 18,
        duplicateCount: 106,
        duplicateRate: 74.65,
      },
    );

    expect(parseEffectPromptBatchResult(result)?.metrics.semanticEvaluation).toEqual({
      status: 'VERIFIED',
      evaluatedCount: 142,
      duplicateGroupCount: 18,
      duplicateCount: 106,
      duplicateRate: 74.65,
    });
  });

  it('preserves the worker candidate target when recomputing a generated draft', () => {
    const items = Array.from({ length: 100 }, (_, index) =>
      item(String(index + 1), `产品创意画面 ${index + 1}`),
    );
    const initial = recomputePromptQuality(items, {
      targetCount: 100,
      defaultDurationSeconds: 15,
    });
    const result = recomputePromptQuality(items, initial.settings, {
      ...initial.metrics,
      candidateTargetCount: 140,
      generatedCandidateCount: 160,
    });

    expect(result.metrics.candidateTargetCount).toBe(140);
    expect(result.metrics.generatedCandidateCount).toBe(160);
  });

  it('keeps evaluator hard issues as a distinct revision blocker', () => {
    const result = recomputePromptQuality(
      [
        {
          ...item('001'),
          classificationStatus: 'NEEDS_REVISION',
          reviewIssues: ['PRODUCT_UNRELATED'],
        },
      ],
      { targetCount: 1, defaultDurationSeconds: 5 },
    );

    expect(result.qualityStatus).toBe('NEEDS_REVIEW');
    expect(result.metrics.hardIssueCounts).toContainEqual({
      code: 'ITEM_NEEDS_REVISION',
      count: 1,
    });
    expect(result.items[0]?.reviewIssues).toEqual(['PRODUCT_UNRELATED']);
  });

  it('uses batch coverage instead of blocking each identity-led item', () => {
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
      creativeCore: '通过风味制作细节建立产品记忆点',
      content:
        '木质餐台上，成年人将已熟制的广式腊肠摆入白瓷碟，镜头缓慢推近并停留在产品的油润纹理上。',
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

    expect(result.metrics.hardIssueCounts).not.toContainEqual(
      expect.objectContaining({ code: 'MISSING_DEEP_BUSINESS_FACT' }),
    );
    expect(result.metrics.insightCoverage.missing).toEqual([]);
    expect(result.qualityStatus).toBe('NEEDS_REVIEW');
    expect(result.metrics.acceptedCount).toBe(2);
    expect(result.settings.targetCount).toBe(10);
  });

  it('preserves the silent-material coverage scope through parsing and edits', () => {
    const visible = {
      factId: 'VISUAL_FEATURES:visible',
      field: 'VISUAL_FEATURES' as const,
      value: '可见产品外观',
      valueHash: sha256('可见产品外观'),
    };
    const background = {
      factId: 'CORE_SELLING_POINT:context',
      field: 'CORE_SELLING_POINT' as const,
      value: '仅作背景的风味信息',
      valueHash: sha256('仅作背景的风味信息'),
    };
    const items = Array.from({ length: 10 }, (_, index) => ({
      ...item(`00000000-0000-4000-8000-${String(index).padStart(12, '0')}`),
      insightBindings: index === 0 ? [{ ...visible, role: 'PRIMARY' as const }] : [],
    }));
    const result = recomputePromptQuality(
      items,
      {
        targetCount: 10,
        defaultDurationSeconds: 5,
      },
      {
        insightCoverage: {
          required: [visible],
          covered: [visible],
          missing: [],
          adaptive: [background],
          deferred: [background],
          excluded: [],
          appliedConstraints: [],
        },
      },
    );
    const parsed = parseEffectPromptBatchResult(result);
    expect(parsed?.qualityStatus).toBe('PASS');
    expect(parsed?.metrics.insightCoverage.missing).toEqual([]);
    expect(parsed?.metrics.insightCoverage.deferred).toEqual([background]);
    const edited = recomputePromptQuality(
      items.map((entry) => ({ ...entry, insightBindings: [] })),
      result.settings,
      parsed!.metrics,
    );
    expect(edited.qualityStatus).toBe('NEEDS_REVIEW');
    expect(edited.metrics.insightCoverage.missing).toEqual([visible]);
    expect(edited.metrics.insightCoverage.deferred).toEqual([background]);
  });

  it('keeps semantic duplicate rate as an advisory metric', () => {
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
    expect(result.qualityStatus).toBe('PASS');
  });

  it('does not change the quality status at the semantic duplicate reference line', () => {
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
    expect(evaluate(8).qualityStatus).toBe('PASS');
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

  it('ITEM_EVALUATE autofill preserves user-authored fields and does not apply AI scoring', () => {
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
      creativeCore: target.creativeCore,
      dimensions: target.dimensions,
      origin: 'MANUAL',
      manualEdited: true,
      fragmentType: target.primaryPurpose,
      primaryPurpose: target.primaryPurpose,
      classificationStatus: 'VERIFIED',
      productRelevance: target.productRelevance,
    });
    expect(merged[0]?.content).not.toBe(evaluated.content);
  });
});
