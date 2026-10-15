import type { EffectPromptProductState } from '@ai-marketing/contracts';
import { DEFAULT_EFFECT_PROMPT_SETTINGS } from '@ai-marketing/contracts';
import { describe, expect, it } from 'vitest';

import {
  changePromptPrimaryPurpose,
  clampPromptPage,
  clonePromptSettings,
  EFFECT_PROMPT_PAGE_SIZE_OPTIONS,
  EFFECT_PROMPT_LIMITS,
  isPromptProductCommitted,
  isPromptRunActive,
  normalizePromptSettings,
  normalizeManualPromptDuration,
  promptPageCount,
} from './effect-prompt-generation-state';

describe('effect prompt generation state', () => {
  it('does not turn previous primary purposes into implicitly selected compatible purposes', () => {
    const effect = changePromptPrimaryPurpose('PRODUCT_DISPLAY', 'EFFECT', ['PRODUCT_DISPLAY']);
    expect(effect).toEqual(['EFFECT']);
    expect(changePromptPrimaryPurpose('EFFECT', 'CTA', effect)).toEqual(['CTA']);
  });

  it('clears all extra compatible selections whenever the primary purpose changes', () => {
    const selected = ['PRODUCT_DISPLAY', 'HOOK', 'CTA'] as const;
    expect(changePromptPrimaryPurpose('PRODUCT_DISPLAY', 'EFFECT', [...selected])).toEqual([
      'EFFECT',
    ]);
    expect(changePromptPrimaryPurpose('PRODUCT_DISPLAY', 'HOOK', [...selected])).toEqual(['HOOK']);
    expect(selected).toEqual(['PRODUCT_DISPLAY', 'HOOK', 'CTA']);
  });
  it('does not reset selections when the primary purpose has not changed', () => {
    expect(
      changePromptPrimaryPurpose('PRODUCT_DISPLAY', 'PRODUCT_DISPLAY', ['PRODUCT_DISPLAY', 'HOOK']),
    ).toEqual(['PRODUCT_DISPLAY', 'HOOK']);
  });
  it.each([
    [50, 30],
    [100, 30],
    [31, 30],
    [30, 30],
    [1, 4],
    [0, 4],
    [-5, 4],
    [4, 4],
    [15, 15],
    [25, 25],
    [12.7, 13],
    [Number.NaN, 4],
    [Number.POSITIVE_INFINITY, 4],
  ])('normalizes manual duration %s to %s seconds', (input, expected) => {
    expect(normalizeManualPromptDuration(input)).toBe(expected);
  });
  it('keeps a confirmed historical batch below the current generation minimum readable', () => {
    expect(clonePromptSettings({ targetCount: 10, defaultDurationSeconds: 5 }).targetCount).toBe(
      10,
    );
  });

  it('normalizes the simplified total-count and shared-duration settings', () => {
    expect(
      normalizePromptSettings({
        targetCount: 1,
        defaultDurationSeconds: 500,
      }),
    ).toEqual({
      targetCount: 20,
      defaultDurationSeconds: 15,
      styleMode: 'AI_AUTO',
      styleTone: null,
      deliveryChannel: '抖音',
      disabledElements: [],
    });
    expect(normalizePromptSettings(DEFAULT_EFFECT_PROMPT_SETTINGS)).toEqual(
      DEFAULT_EFFECT_PROMPT_SETTINGS,
    );
    expect(
      normalizePromptSettings({ targetCount: 19, defaultDurationSeconds: 5 }).targetCount,
    ).toBe(20);
    expect(normalizePromptSettings({ targetCount: 101, defaultDurationSeconds: 5 })).toEqual({
      targetCount: 100,
      defaultDurationSeconds: 5,
      styleMode: 'AI_AUTO',
      styleTone: null,
      deliveryChannel: '抖音',
      disabledElements: [],
    });
  });

  it('supports selectable server pagination sizes', () => {
    expect(EFFECT_PROMPT_LIMITS.pageSize).toBe(5);
    expect(EFFECT_PROMPT_PAGE_SIZE_OPTIONS).toEqual([5, 10, 20, 50, 100]);
    expect(promptPageCount(23)).toBe(5);
    expect(promptPageCount(23, 20)).toBe(2);
    expect(promptPageCount(100, 50)).toBe(2);
    expect(promptPageCount(0)).toBe(1);
  });

  it('clamps stale page numbers after filtering or deleting the last page', () => {
    expect(clampPromptPage(3, 10)).toBe(2);
    expect(clampPromptPage(2, 11)).toBe(2);
    expect(clampPromptPage(3, 0)).toBe(1);
    expect(clampPromptPage(Number.NaN, 50)).toBe(1);
    expect(clampPromptPage(5, 50, 20)).toBe(3);
  });

  it('uses authoritative commit status for progression even when quality advice remains', () => {
    const state = {
      status: 'COMPLETED',
      qualityStatus: 'PASS',
      commitStatus: 'COMMITTED',
    } as EffectPromptProductState;
    expect(isPromptProductCommitted(state)).toBe(true);
    expect(isPromptProductCommitted({ ...state, qualityStatus: 'NEEDS_REVIEW' })).toBe(true);
    expect(isPromptProductCommitted({ ...state, commitStatus: 'DRAFT_CHANGED' })).toBe(false);
    expect(isPromptRunActive({ ...state, status: 'PROCESSING' })).toBe(true);
  });
});
