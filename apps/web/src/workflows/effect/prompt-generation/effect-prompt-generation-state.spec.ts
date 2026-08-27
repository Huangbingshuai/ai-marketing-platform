import type {
  EffectPromptBatchResult,
  EffectPromptItem,
  EffectPromptProductState,
} from '@ai-marketing/contracts';
import {
  DEFAULT_EFFECT_PROMPT_SETTINGS,
  EFFECT_PROMPT_FRAGMENT_TYPES,
  EFFECT_PROMPT_SCHEMA_VERSION,
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
  fragmentType: 'HOOK',
  primaryPurpose: 'HOOK',
  compatiblePurposes: ['HOOK', 'PAIN'],
  classificationStatus: 'VERIFIED',
  productRelevance: 92,
  materialTags: ['首帧', '痛点'],
  targetDurationSeconds: 5,
  dimensions: {
    narrative: '痛点前置型',
    scene: '家庭厨房',
    persona: '都市白领',
    productRelation: '广式腊肠真空锁鲜',
    camera: '手持跟拍＋特写',
    emotion: '温馨治愈',
  },
  content: '广式腊肠结构化 Prompt',
  insightBindings: [],
  manualEdited: false,
  createdAt: '2026-08-25T00:00:00.000Z',
  updatedAt: '2026-08-25T00:00:00.000Z',
};

const batch: EffectPromptBatchResult = {
  schemaVersion: EFFECT_PROMPT_SCHEMA_VERSION,
  settings: DEFAULT_EFFECT_PROMPT_SETTINGS,
  renderProfile: {
    ratio: '9:16',
    resolution: '1080p',
    capabilityKey: 'SEEDANCE_2_0',
    sharedConstraints: { disabledElements: [], contentHash: 'a'.repeat(64) },
  },
  items: Array.from({ length: 50 }, (_, index) => ({ ...prompt, id: `item-${index}` })),
  metrics: {
    targetCount: 50,
    candidateTargetCount: 65,
    acceptedCount: 50,
    generatedCandidateCount: 65,
    rejectedCount: 15,
    replenishmentRounds: 1,
    exactDuplicateCount: 2,
    purposeDistribution: EFFECT_PROMPT_FRAGMENT_TYPES.map((purpose) => ({
      purpose,
      primaryCount: purpose === 'HOOK' ? 50 : 0,
      compatibleCount: purpose === 'HOOK' || purpose === 'PAIN' ? 50 : 0,
    })),
    averageScores: {
      productRelevance: 92,
      creativeCoherence: 88,
      visualExecutability: 90,
      commercialUsefulness: 86,
      visualClarity: 91,
    },
    hardIssueCounts: [],
    warningCounts: [{ code: 'LOW_PURPOSE_CONFIDENCE', count: 2 }],
  },
  qualityStatus: 'PASS',
};

describe('effect prompt generation state', () => {
  it('normalizes the simplified total-count and shared-duration settings', () => {
    expect(
      normalizePromptSettings({
        targetCount: 1,
        defaultDurationSeconds: 500,
      }),
    ).toEqual({
      targetCount: 10,
      defaultDurationSeconds: 15,
    });
    expect(normalizePromptSettings(DEFAULT_EFFECT_PROMPT_SETTINGS)).toEqual(
      DEFAULT_EFFECT_PROMPT_SETTINGS,
    );
  });

  it('matches id, content, fixed and secondary labels and six-dimensional labels', () => {
    expect(promptMatchesKeyword(prompt, 'P001')).toBe(true);
    expect(promptMatchesKeyword(prompt, '广式腊肠')).toBe(true);
    expect(promptMatchesKeyword(prompt, '叙事结构')).toBe(true);
    expect(promptMatchesKeyword(prompt, '温馨治愈')).toBe(true);
    expect(promptMatchesKeyword(prompt, '钩子片段')).toBe(true);
    expect(promptMatchesKeyword(prompt, '痛点片段')).toBe(true);
    expect(promptMatchesKeyword(prompt, '产品关联点')).toBe(true);
    expect(promptMatchesKeyword(prompt, '首帧')).toBe(true);
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
        metrics: { ...batch.metrics, acceptedCount: 49 },
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
