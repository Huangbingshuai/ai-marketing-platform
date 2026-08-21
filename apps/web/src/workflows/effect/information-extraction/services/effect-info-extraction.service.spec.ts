import type { EffectVideoConfig } from '@ai-marketing/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { EffectExtractionResult } from '../effect-info-extraction-state';
import {
  mockEffectInfoExtractionService,
  type EffectExtractionContext,
  type EffectExtractionSourceProduct,
} from './effect-info-extraction.service';

const config: EffectVideoConfig = {
  aspectRatio: '9:16',
  durationSeconds: 15,
  resolution: '1080P',
  frameRate: 30,
  subtitleStrategy: '跟随口播',
  voiceoverStrategy: 'AI 女声',
  bgmStrategy: '自动匹配',
  styleTone: '自然生活',
  deliveryChannel: '抖音',
  disabledElements: ['绝对化用语'],
};

const product = (id: string): EffectExtractionSourceProduct => ({
  id,
  name: `测试产品 ${id}`,
  category: '食品',
  sku: `SKU-${id}`,
  effectiveConfig: config,
  materials: [{ id: `material-${id}`, status: 'READY', updatedAt: '2026-08-20' }],
});

const context: EffectExtractionContext = {
  projectId: 'project-service-spec',
  draftId: 'draft-service-spec',
  mode: 'BATCH',
};

afterEach(() => vi.useRealTimers());

describe('mock effect info extraction service', () => {
  it('creates independent initial states for a batch workspace', async () => {
    const states = await mockEffectInfoExtractionService.loadWorkspace(context, [
      product('a'),
      product('b'),
      product('c'),
      product('d'),
    ]);
    expect(states.map((item) => item.status)).toEqual([
      'COMPLETED',
      'NOT_GENERATED',
      'FAILED',
      'STALE',
    ]);
  });

  it('supports a failed extraction followed by a successful retry', async () => {
    vi.useFakeTimers();
    const retryContext = { ...context, draftId: 'draft-retry-spec' };
    const products = [product('first'), product('retry')];
    await mockEffectInfoExtractionService.loadWorkspace(retryContext, products);
    const firstAttempt = mockEffectInfoExtractionService.extractProduct(retryContext, products[1]!);
    await vi.advanceTimersByTimeAsync(900);
    expect((await firstAttempt).status).toBe('FAILED');

    const retry = mockEffectInfoExtractionService.extractProduct(retryContext, products[1]!);
    await vi.advanceTimersByTimeAsync(900);
    expect((await retry).status).toBe('COMPLETED');
  });

  it('persists an edited draft without changing another product', async () => {
    vi.useFakeTimers();
    const saveContext = { ...context, draftId: 'draft-save-spec' };
    const products = [product('saved'), product('untouched')];
    const initial = await mockEffectInfoExtractionService.loadWorkspace(saveContext, products);
    const edited = { ...initial[0]!.result, marketingGoal: '人工修订后的目标' } as EffectExtractionResult;
    const saving = mockEffectInfoExtractionService.saveDraft(saveContext, products[0]!, edited);
    await vi.advanceTimersByTimeAsync(260);
    expect((await saving).result?.marketingGoal).toBe('人工修订后的目标');
    const reloaded = await mockEffectInfoExtractionService.loadWorkspace(saveContext, products);
    expect(reloaded[1]!.result).toBeNull();
  });
});
