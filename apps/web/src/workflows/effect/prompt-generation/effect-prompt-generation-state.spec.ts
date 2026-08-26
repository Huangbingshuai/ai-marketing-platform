import type {
  EffectPromptBatchResult,
  EffectPromptItem,
  EffectPromptProductState,
} from '@ai-marketing/contracts';
import {
  DEFAULT_EFFECT_PROMPT_SETTINGS,
  EFFECT_PROMPT_FRAGMENT_TYPES,
  effectPromptTargetCount,
  effectPromptFragmentTypeTargetCounts,
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
  materialTags: ['首帧', '痛点'],
  targetDurationSeconds: 5,
  dimensions: {
    narrative: '痛点前置型',
    scene: '家庭厨房',
    persona: '都市白领',
    sellingPoint: '真空锁鲜',
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
  schemaVersion: 4,
  settings: DEFAULT_EFFECT_PROMPT_SETTINGS,
  items: Array.from({ length: 50 }, (_, index) => ({ ...prompt, id: `item-${index}` })),
  metrics: {
    targetCount: 50,
    acceptedCount: 50,
    generatedCandidateCount: 14,
    removedSemanticDuplicates: 2,
    removedVisualDuplicates: 1,
    removedDimensionConflicts: 1,
    semanticDuplicateRate: 11.8,
    visualOverlapRate: 16.4,
    replenishmentRounds: 1,
    fragmentTypeDistribution: EFFECT_PROMPT_FRAGMENT_TYPES.map((fragmentType) => {
      const targetCount = effectPromptFragmentTypeTargetCounts(DEFAULT_EFFECT_PROMPT_SETTINGS)[
        fragmentType
      ];
      return { fragmentType, targetCount, actualCount: targetCount };
    }),
    sellingPointCoverage: {
      required: ['真空锁鲜'],
      covered: ['真空锁鲜'],
      missing: [],
    },
    insightCoverage: {
      required: [],
      covered: [],
      missing: [],
      adaptive: [],
      deferred: [],
      excluded: [],
      appliedConstraints: [],
    },
    removedExecutionInvalid: 2,
    executionInvalidReasons: [{ code: 'MULTI_STAGE_STORY', count: 2 }],
  },
  qualityStatus: 'PASS',
};

describe('effect prompt generation state', () => {
  it('normalizes six independent fragment settings to contract ranges', () => {
    expect(
      normalizePromptSettings({
        ...DEFAULT_EFFECT_PROMPT_SETTINGS,
        fragmentConfigs: {
          ...DEFAULT_EFFECT_PROMPT_SETTINGS.fragmentConfigs,
          HOOK: { count: 1, durationSeconds: 500 },
        },
        semanticLimit: 30,
        visualLimit: 2,
      }),
    ).toEqual({
      ...DEFAULT_EFFECT_PROMPT_SETTINGS,
      fragmentConfigs: {
        ...DEFAULT_EFFECT_PROMPT_SETTINGS.fragmentConfigs,
        HOOK: { count: 1, durationSeconds: 10 },
      },
      semanticLimit: 15,
      visualLimit: 10,
    });
    expect(effectPromptTargetCount(DEFAULT_EFFECT_PROMPT_SETTINGS)).toBe(50);
  });

  it('matches id, content, fixed and secondary labels and six-dimensional labels', () => {
    expect(promptMatchesKeyword(prompt, 'P001')).toBe(true);
    expect(promptMatchesKeyword(prompt, '广式腊肠')).toBe(true);
    expect(promptMatchesKeyword(prompt, '叙事结构')).toBe(true);
    expect(promptMatchesKeyword(prompt, '温馨治愈')).toBe(true);
    expect(promptMatchesKeyword(prompt, '钩子片段')).toBe(true);
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
