import { describe, expect, it } from 'vitest';

import componentSource from './ParameterAdjustList.vue?raw';
import indexSource from './index.ts?raw';

describe('ParameterAdjustList', () => {
  it('renders one row per configured item with label, slider and field', () => {
    expect(componentSource).toContain('v-for="item in items"');
    expect(componentSource).toContain(':data-parameter-key="item.key"');
    expect(componentSource).toContain('class="parameter-adjust-label"');
    expect(componentSource).toContain('class="parameter-adjust-slider"');
    expect(componentSource).toContain('type="range"');
    expect(componentSource).toContain('class="parameter-adjust-input"');
    expect(componentSource).toContain('class="parameter-adjust-unit"');
    // The steppers sit to the right of the number, one arrow per direction.
    expect(componentSource).toContain('class="parameter-adjust-steppers"');
    expect(componentSource).toContain(':aria-label="`增大${item.label}`"');
    expect(componentSource).toContain(':aria-label="`减小${item.label}`"');
    expect(componentSource).toContain('@click="step(item, 1)"');
    expect(componentSource).toContain('@click="step(item, -1)"');
  });

  it('configures every row from props instead of hard-coding any parameter', () => {
    expect(componentSource).toContain('export type ParameterAdjustItem = {');
    for (const field of [
      'key: string;',
      'label: string;',
      'min: number;',
      'max: number;',
      'step: number;',
      'unit?: string;',
      'precision?: number;',
      'default?: number;',
      'marks?: ParameterAdjustMark[];',
    ]) {
      expect(componentSource).toContain(field);
    }
    // The list carries no knowledge of any particular parameter.
    expect(componentSource).not.toContain('音量');
    expect(componentSource).not.toContain('淡入');
  });

  it('lays the items out on one line, sharing the width', () => {
    expect(componentSource).toContain(
      '.parameter-adjust-list {\n  display: flex;\n  flex-direction: row;',
    );
    // Each item takes an equal share and may shrink, so a longer list never wraps or overflows.
    expect(componentSource).toContain(
      '.parameter-adjust-row {\n  display: flex;\n  flex: 1;\n  min-width: 0;',
    );
  });

  it('draws each configured mark on the track at its own position', () => {
    expect(componentSource).toContain('v-for="mark in item.marks ?? []"');
    expect(componentSource).toContain(':style="markStyle(item, mark)"');
    expect(componentSource).toContain('class="parameter-adjust-mark"');
    expect(componentSource).toContain('class="parameter-adjust-track"');
    // Placed by percentage of the range, with a zero-width span so the tick can be centred on it.
    expect(componentSource).toContain(
      'const markStyle = (item: ParameterAdjustItem, mark: ParameterAdjustMark): Record<string, string> => {',
    );
    expect(componentSource).toContain('const ratio = span > 0 ? (mark.value - item.min) / span : 0;');
    expect(componentSource).toContain('return { left: `${Math.min(1, Math.max(0, ratio)) * 100}%` };');
    // A mark is a reading aid, so it must not intercept a click aimed at the slider beneath it.
    expect(componentSource).toContain('pointer-events: none;');
  });

  it('keeps slider, typed value and arrows on one bound number', () => {
    // All three gestures commit through the same clamp-and-round path.
    expect(componentSource).toContain('@input="onSlider(item, $event)"');
    expect(componentSource).toContain('@input="onTyped(item, $event)"');
    expect(componentSource).toContain(
      'const commit = (item: ParameterAdjustItem, value: number): void',
    );
    // Both directions are bound to the same value, so the two controls cannot drift apart.
    expect(componentSource).toContain(':value="valueOf(item)"');
    expect(componentSource).toContain(':value="textOf(item)"');
    expect(componentSource).toContain(
      "emit('update:modelValue', { ...values.value, [item.key]: next })",
    );
    expect(componentSource).toContain(':step="item.step"');
  });

  it('bounds and rounds each value, and falls back to the configured default', () => {
    expect(componentSource).toContain(
      'const normalize = (item: ParameterAdjustItem, value: number): number',
    );
    expect(componentSource).toContain('Math.min(item.max, Math.max(item.min, round(item, value)))');
    expect(componentSource).toContain(
      'const seeded = Number.isFinite(bound) ? (bound as number) : (item.default ?? item.min);',
    );
    // A step past a boundary stops on the boundary rather than overflowing it.
    expect(componentSource).toContain(':disabled="disabled || valueOf(item) >= item.max"');
    expect(componentSource).toContain(':disabled="disabled || valueOf(item) <= item.min"');
    // Precision follows the step unless the caller overrides it.
    expect(componentSource).toContain("const decimals = String(item.step).split('.')[1];");
    expect(componentSource).toContain('if (item.precision !== undefined) return item.precision;');
  });

  it('lets a half-typed number stand until the field is left', () => {
    // A draft wins while typing, so `-` or `0.` is not rewritten under the caret.
    expect(componentSource).toContain('const drafts = ref<Record<string, string>>({});');
    expect(componentSource).toContain('drafts.value[item.key] ?? format(item, valueOf(item))');
    expect(componentSource).toContain('if (!text.trim()) return;');
    expect(componentSource).toContain('const onBlur = (item: ParameterAdjustItem): void');
    // An arrow steps from the committed value, so one click is always exactly one step.
    expect(componentSource).toContain('delete drafts.value[item.key];');
  });

  it('exposes only interaction structure, leaving colour and placement to the host', () => {
    // Every colour and size is a custom property with a neutral fallback.
    expect(componentSource).toContain('var(--parameter-accent, currentColor)');
    expect(componentSource).toContain('var(--parameter-field-border, 1px solid currentColor)');
    expect(componentSource).toContain('var(--parameter-field-background, transparent)');
    expect(componentSource).toContain('var(--parameter-label-width, 4.5em)');
    expect(componentSource).toContain('var(--parameter-input-width, 4.5em)');
    expect(componentSource).toContain('var(--parameter-row-gap, 6px)');
    expect(componentSource).toContain('color: inherit;');
    expect(componentSource).toContain('font: inherit;');
    // No hex colour and nothing pinned to the viewport. The only absolute placement is a mark inside
    // the track it annotates, which is why the track is the positioned box.
    expect(componentSource).not.toMatch(/#[0-9a-f]{3,6}/i);
    expect(componentSource).not.toContain('position: fixed');
    expect(componentSource).toContain('position: relative;');
    expect(componentSource).toContain('position: absolute;');
  });

  it('is exported for reuse outside the feature that needed it first', () => {
    expect(indexSource).toContain(
      "export { default as ParameterAdjustList } from './ParameterAdjustList.vue';",
    );
    expect(indexSource).toContain(
      "export type { ParameterAdjustItem } from './ParameterAdjustList.vue';",
    );
  });
});
