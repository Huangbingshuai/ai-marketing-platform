import { describe, expect, it } from 'vitest';
import { effectPromptRenderSettingsIssues } from '@ai-marketing/contracts';
import { effectSegmentRenderModels } from './effect-segment-render-models';
import dialog from './components/EffectPromptRenderConfigurationDialog.vue?raw';
import page from './EffectSegmentRenderNodePage.vue?raw';

describe('per-Prompt render configuration', () => {
  it('uses the same model capabilities for the page and conflict dialog', () => {
    expect(effectSegmentRenderModels.map((model) => model.label)).toEqual([
      'Doubao-Seedance-2.5',
      'Doubao-Seedance-2.0',
      'Doubao-Seedance-2.0-mini',
      'Doubao-Seedance-2.0-fast',
    ]);
    const long = { durationSeconds: 24, origin: 'MANUAL' } as const;
    expect(
      effectSegmentRenderModels
        .filter(
          (model) =>
            !effectPromptRenderSettingsIssues(
              {
                capabilityKey: model.value,
                ratio: '9:16',
                resolution: '720p',
              },
              long,
            ).length,
        )
        .map((model) => model.value),
    ).toEqual(['SEEDANCE_1_5_PRO']);
  });
  it('collects all conflicts before paid confirmation and submits overrides for both entry points', () => {
    const start = page.slice(page.indexOf('const startBatch'));
    const loadIndex = start.indexOf('await getEffectSegmentRenderWorkspace(');
    const configureIndex = start.indexOf('promptConfiguration.value = { inputs: conflicts');
    const confirmIndex = start.indexOf('await requestActionConfirmation(');
    expect(loadIndex).toBeGreaterThanOrEqual(0);
    expect(configureIndex).toBeGreaterThan(loadIndex);
    expect(confirmIndex).toBeGreaterThan(configureIndex);
    expect(page).toContain('settingsContext:');
    expect(page).toContain('新任务的默认配置，不追溯修改已有素材。');
    expect(page).toContain('settlePromptConfiguration(null)');
  });
  it('keeps task-specific forms, explicit resolution selection, batch application and native modal keyboard support', () => {
    expect(dialog).toContain('v-for="(draft, index) in drafts"');
    expect(dialog).toContain('应用到全部冲突项');
    expect(dialog).toContain(':disabled="!valid"');
    expect(dialog).toContain('@cancel.prevent="emit(\'cancel\')"');
    expect(dialog).toContain('showModal()');
    expect(dialog).toContain('trigger.focus()');
    expect(dialog).toContain('grid-template-columns: 1fr 1fr');
    expect(dialog).not.toContain('linear-gradient');
  });
  it('provides per-Prompt read-only content with independent expansion state', () => {
    expect(dialog).toContain('查看提示词');
    expect(dialog).toContain('收起提示词');
    expect(dialog).toContain(':aria-expanded="expandedPrompts.has(draft.promptId)"');
    expect(dialog).toContain('draft.promptText');
    expect(dialog).not.toContain('v-html');
    expect(dialog).toContain('overflow-wrap: anywhere');
  });
});
