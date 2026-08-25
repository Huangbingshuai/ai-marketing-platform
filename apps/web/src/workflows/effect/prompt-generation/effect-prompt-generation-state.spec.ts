import type {
  EffectPromptBatchResult,
  EffectPromptItem,
  EffectPromptProductState,
} from '@ai-marketing/contracts';
import { describe, expect, it } from 'vitest';

import {
  EFFECT_PROMPT_LIMITS,
  isPromptProductCommitted,
  isPromptResultQualityReady,
  isPromptRunActive,
  normalizePromptSettings,
  promptMatchesKeyword,
  promptPageCount,
} from './effect-prompt-generation-state';

const prompt: EffectPromptItem = {
  id: 'item-1',
  code: 'P001-ABC',
  origin: 'AI',
  fragmentType: '钩子片段',
  dimensions: {
    narrative: '痛点前置型',
    scene: '家庭厨房',
    persona: '都市白领',
    sellingPoint: '真空锁鲜',
    camera: '手持跟拍＋特写',
    emotion: '温馨治愈',
  },
  content: '广式腊肠结构化 Prompt',
  manualEdited: false,
  createdAt: '2026-08-25T00:00:00.000Z',
  updatedAt: '2026-08-25T00:00:00.000Z',
};

const batch: EffectPromptBatchResult = {
  schemaVersion: 1,
  settings: { count: 10, durationSeconds: 15, semanticLimit: 15, visualLimit: 20 },
  items: Array.from({ length: 10 }, (_, index) => ({ ...prompt, id: `item-${index}` })),
  metrics: {
    targetCount: 10,
    acceptedCount: 10,
    generatedCandidateCount: 14,
    removedSemanticDuplicates: 2,
    removedVisualDuplicates: 1,
    removedDimensionConflicts: 1,
    semanticDuplicateRate: 11.8,
    visualOverlapRate: 16.4,
    replenishmentRounds: 1,
  },
  qualityStatus: 'PASS',
};

describe('effect prompt generation state', () => {
  it('normalizes all four prototype settings to contract ranges', () => {
    expect(
      normalizePromptSettings({
        count: 2,
        durationSeconds: 500,
        semanticLimit: 30,
        visualLimit: 2,
      }),
    ).toEqual({
      count: 10,
      durationSeconds: 120,
      semanticLimit: 15,
      visualLimit: 10,
    });
  });

  it('matches id, content, fragment type and six-dimensional labels', () => {
    expect(promptMatchesKeyword(prompt, 'P001')).toBe(true);
    expect(promptMatchesKeyword(prompt, '广式腊肠')).toBe(true);
    expect(promptMatchesKeyword(prompt, '叙事结构')).toBe(true);
    expect(promptMatchesKeyword(prompt, '温馨治愈')).toBe(true);
    expect(promptMatchesKeyword(prompt, '不存在')).toBe(false);
  });

  it('keeps server pagination at ten prompts per page', () => {
    expect(EFFECT_PROMPT_LIMITS.pageSize).toBe(10);
    expect(promptPageCount(23)).toBe(3);
    expect(promptPageCount(0)).toBe(1);
  });

  it('uses authoritative quality metrics and commit status for progression', () => {
    expect(isPromptResultQualityReady(batch)).toBe(true);
    expect(
      isPromptResultQualityReady({
        ...batch,
        metrics: { ...batch.metrics, semanticDuplicateRate: 15.1 },
      }),
    ).toBe(false);

    const state = {
      status: 'COMPLETED',
      qualityStatus: 'PASS',
      commitStatus: 'COMMITTED',
    } as EffectPromptProductState;
    expect(isPromptProductCommitted(state)).toBe(true);
    expect(isPromptProductCommitted({ ...state, commitStatus: 'DRAFT_CHANGED' })).toBe(false);
    expect(isPromptRunActive({ ...state, status: 'PROCESSING' })).toBe(true);
  });
});
