import { describe, expect, it } from 'vitest';

import {
  EFFECT_PROMPT_LIMITS,
  isPromptWorkspaceComplete,
  normalizePromptSettings,
  promptMatchesKeyword,
  promptPageCount,
  promptPageItems,
  type EffectPromptItem,
  type EffectPromptWorkspace,
} from './effect-prompt-generation-state';

const item = (index: number): EffectPromptItem => ({
  id: `item-${index}`,
  code: `P${String(index).padStart(3, '0')}-ABC`,
  fragmentType: '钩子片段',
  dimensions: [
    { key: 'narrative', label: '叙事结构', value: '痛点前置型' },
    { key: 'scene', label: '场景变量', value: '家庭厨房' },
    { key: 'emotion', label: '情绪基调', value: '温馨治愈' },
  ],
  content: `第 ${index} 条广式腊肠 Prompt`,
  semanticSimilarity: 11.8,
  visualSimilarity: 16.4,
  createdAt: '2026-08-25T00:00:00.000Z',
  updatedAt: '2026-08-25T00:00:00.000Z',
});

describe('effect prompt generation state', () => {
  it('normalizes all four prototype settings to their supported ranges', () => {
    expect(
      normalizePromptSettings({
        count: 2,
        durationSeconds: 500,
        semanticLimit: 30,
        visualLimit: 2,
      }),
    ).toEqual({ count: 10, durationSeconds: 120, semanticLimit: 15, visualLimit: 10 });
  });

  it('filters by id, content, dimension labels and dimension values', () => {
    const prompt = item(1);
    expect(promptMatchesKeyword(prompt, 'P001')).toBe(true);
    expect(promptMatchesKeyword(prompt, '广式腊肠')).toBe(true);
    expect(promptMatchesKeyword(prompt, '叙事结构')).toBe(true);
    expect(promptMatchesKeyword(prompt, '温馨治愈')).toBe(true);
    expect(promptMatchesKeyword(prompt, '不存在')).toBe(false);
  });

  it('keeps the prototype pagination at ten prompts per page', () => {
    const items = Array.from({ length: 23 }, (_, index) => item(index + 1));
    expect(EFFECT_PROMPT_LIMITS.pageSize).toBe(10);
    expect(promptPageCount(items.length)).toBe(3);
    expect(promptPageItems(items, 2)).toHaveLength(10);
    expect(promptPageItems(items, 3)).toHaveLength(3);
  });

  it('requires target count, three dimensions and both similarity limits', () => {
    const workspace: EffectPromptWorkspace = {
      version: 1,
      hasGenerated: false,
      settings: { count: 10, durationSeconds: 15, semanticLimit: 15, visualLimit: 20 },
      items: Array.from({ length: 10 }, (_, index) => item(index + 1)),
      metrics: {
        generatedCount: 10,
        removedDuplicates: 2,
        semanticSimilarity: 11.8,
        visualSimilarity: 16.4,
      },
      updatedAt: '2026-08-25T00:00:00.000Z',
    };
    expect(isPromptWorkspaceComplete(workspace)).toBe(true);
    expect(isPromptWorkspaceComplete({ ...workspace, items: workspace.items.slice(1) })).toBe(
      false,
    );
    expect(
      isPromptWorkspaceComplete({
        ...workspace,
        metrics: { ...workspace.metrics, semanticSimilarity: 15.1 },
      }),
    ).toBe(false);
  });
});
