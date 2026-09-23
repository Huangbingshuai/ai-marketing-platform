<script lang="ts">
/**
 * One adjustable number. Everything the row needs is configuration, so a caller can render any
 * list of numeric parameters without the component knowing what they mean.
 */
/** A reading aid drawn on the track — unity gain, a zero, whatever the caller wants marked. */
export type ParameterAdjustMark = {
  /** Where on the track, in the item's own units. */
  value: number;
  /** Short caption under the tick, e.g. `0dB`. Omitted leaves a bare tick. */
  label?: string;
};
export type ParameterAdjustItem = {
  /** Identifies the row in the bound record, and is echoed on the DOM for styling hooks. */
  key: string;
  label: string;
  min: number;
  max: number;
  /** Increment for the stepper arrows, the slider and the typed value's rounding. */
  step: number;
  /** Suffix shown after the number, e.g. `dB` or `s`. Purely cosmetic. */
  unit?: string;
  /** Decimals to keep; derived from `step` when omitted (0.1 → 1, 5 → 0). */
  precision?: number;
  /** Used when the bound record has no value for this key yet. Falls back to `min`. */
  default?: number;
  /** Ticks to draw on the track, e.g. the 0 dB reference on a level control. */
  marks?: ParameterAdjustMark[];
};
</script>

<script setup lang="ts">
import { computed, ref } from 'vue';

const props = defineProps<{
  items: ParameterAdjustItem[];
  /** One number per item key, in the item's own units. */
  modelValue: Record<string, number>;
  disabled?: boolean;
}>();
const emit = defineEmits<{ 'update:modelValue': [values: Record<string, number>] }>();

/**
 * Decimals implied by the step, so a 0.1s row shows `0.5` and a 1dB row shows `-2` without every
 * caller having to spell the precision out.
 */
const precisionOf = (item: ParameterAdjustItem): number => {
  if (item.precision !== undefined) return item.precision;
  const decimals = String(item.step).split('.')[1];
  return decimals ? decimals.length : 0;
};
const round = (item: ParameterAdjustItem, value: number): number => {
  const factor = 10 ** precisionOf(item);
  return Math.round(value * factor) / factor;
};
/** Rounded first, then clamped, so a step from the boundary lands on the boundary exactly. */
const normalize = (item: ParameterAdjustItem, value: number): number =>
  Math.min(item.max, Math.max(item.min, round(item, value)));
const valueOf = (item: ParameterAdjustItem): number => {
  const bound = props.modelValue[item.key];
  const seeded = Number.isFinite(bound) ? (bound as number) : (item.default ?? item.min);
  return normalize(item, seeded);
};
const format = (item: ParameterAdjustItem, value: number): string =>
  value.toFixed(precisionOf(item));
/** The whole record, so a consumer can treat the emit as the new state rather than a patch. */
const values = computed<Record<string, number>>(() =>
  Object.fromEntries(props.items.map((item) => [item.key, valueOf(item)])),
);
/**
 * What the text box shows. While a value is being typed the raw string wins, so a half-finished
 * `-0.` or a trailing `.` is not rewritten under the caret; blurring drops the draft and the box
 * snaps back to the normalized number.
 */
const drafts = ref<Record<string, string>>({});
const textOf = (item: ParameterAdjustItem): string =>
  drafts.value[item.key] ?? format(item, valueOf(item));
const commit = (item: ParameterAdjustItem, value: number): void => {
  if (!Number.isFinite(value)) return;
  const next = normalize(item, value);
  if (next === valueOf(item)) return;
  emit('update:modelValue', { ...values.value, [item.key]: next });
};
/** Arrows step from the committed value, not from a draft, so one click is always one step. */
const step = (item: ParameterAdjustItem, direction: 1 | -1): void => {
  if (props.disabled) return;
  delete drafts.value[item.key];
  commit(item, valueOf(item) + item.step * direction);
};
const onTyped = (item: ParameterAdjustItem, event: Event): void => {
  const text = (event.target as HTMLInputElement).value;
  drafts.value[item.key] = text;
  if (!text.trim()) return;
  const parsed = Number(text);
  if (Number.isFinite(parsed)) commit(item, parsed);
};
const onBlur = (item: ParameterAdjustItem): void => {
  delete drafts.value[item.key];
};
const onSlider = (item: ParameterAdjustItem, event: Event): void => {
  delete drafts.value[item.key];
  commit(item, Number((event.target as HTMLInputElement).value));
};
/** A mark's place along the track, as a percentage of the range. */
const markStyle = (item: ParameterAdjustItem, mark: ParameterAdjustMark): Record<string, string> => {
  const span = item.max - item.min;
  const ratio = span > 0 ? (mark.value - item.min) / span : 0;
  return { left: `${Math.min(1, Math.max(0, ratio)) * 100}%` };
};
</script>

<template>
  <div class="parameter-adjust-list" :data-parameter-count="items.length">
    <div
      v-for="item in items"
      :key="item.key"
      class="parameter-adjust-row"
      :data-parameter-key="item.key"
    >
      <span class="parameter-adjust-label">{{ item.label }}</span>
      <span class="parameter-adjust-track">
        <input
          class="parameter-adjust-slider"
          type="range"
          :aria-label="item.label"
          :disabled="disabled"
          :max="item.max"
          :min="item.min"
          :step="item.step"
          :value="valueOf(item)"
          @input="onSlider(item, $event)"
        />
        <span
          v-for="mark in item.marks ?? []"
          :key="mark.value"
          class="parameter-adjust-mark"
          :style="markStyle(item, mark)"
        >
          <i aria-hidden="true"></i>
          <b v-if="mark.label">{{ mark.label }}</b>
        </span>
      </span>
      <span class="parameter-adjust-field">
        <input
          class="parameter-adjust-input"
          type="number"
          :aria-label="`${item.label}数值`"
          :disabled="disabled"
          :step="item.step"
          :value="textOf(item)"
          @blur="onBlur(item)"
          @input="onTyped(item, $event)"
        />
        <span v-if="item.unit" class="parameter-adjust-unit">{{ item.unit }}</span>
        <span class="parameter-adjust-steppers">
          <button
            class="parameter-adjust-step"
            type="button"
            :aria-label="`增大${item.label}`"
            :disabled="disabled || valueOf(item) >= item.max"
            @click="step(item, 1)"
          >
            ▲
          </button>
          <button
            class="parameter-adjust-step"
            type="button"
            :aria-label="`减小${item.label}`"
            :disabled="disabled || valueOf(item) <= item.min"
            @click="step(item, -1)"
          >
            ▼
          </button>
        </span>
      </span>
    </div>
  </div>
</template>

<!--
  Interaction structure only. Every colour and every position that a host might want to own is
  either inherited or read from a custom property with a neutral fallback, so a caller can restyle
  the list (or place it anywhere) without the component fighting back.
-->
<style scoped>
/* One line for the whole list: the items share the width rather than stacking, so a small set of
   numbers stays as compact as the caption row it sits beside. */
.parameter-adjust-list {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: var(--parameter-row-gap, 6px);
}
.parameter-adjust-row {
  display: flex;
  flex: 1;
  min-width: 0;
  align-items: center;
  gap: var(--parameter-column-gap, 8px);
}
.parameter-adjust-label {
  flex: none;
  width: var(--parameter-label-width, 4.5em);
  overflow: hidden;
  color: inherit;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.parameter-adjust-track {
  display: block;
  flex: 1;
  min-width: 0;
  /* Anchors the marks, which are placed by percentage of the range. */
  position: relative;
}
.parameter-adjust-slider {
  display: block;
  width: 100%;
  height: var(--parameter-slider-height, 18px);
  margin: 0;
  /* The track and thumb are left to the host: only the box is laid out here. */
  background: transparent;
  accent-color: var(--parameter-accent, currentColor);
  cursor: pointer;
}
.parameter-adjust-slider:disabled {
  cursor: not-allowed;
}
.parameter-adjust-mark {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 0;
  /* A reference, not a control: it must never swallow a click meant for the slider under it. */
  pointer-events: none;
  transform: translateX(-50%);
}
.parameter-adjust-mark i {
  display: block;
  width: 1px;
  height: 100%;
  background: currentColor;
  opacity: var(--parameter-mark-opacity, 0.5);
}
.parameter-adjust-mark b {
  position: absolute;
  top: 100%;
  left: 50%;
  font-size: var(--parameter-mark-font-size, 9px);
  font-weight: 400;
  line-height: 1;
  opacity: var(--parameter-mark-opacity, 0.8);
  transform: translateX(-50%);
  white-space: nowrap;
}
.parameter-adjust-field {
  display: flex;
  flex: none;
  align-items: center;
  gap: 2px;
  border: var(--parameter-field-border, 1px solid currentColor);
  border-radius: var(--parameter-field-radius, 4px);
  background: var(--parameter-field-background, transparent);
}
.parameter-adjust-input {
  width: var(--parameter-input-width, 4.5em);
  min-width: 0;
  padding: 0 2px;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: right;
  /* Spinners would sit beside our own steppers; the host can turn them back on if it wants them. */
  appearance: textfield;
}
.parameter-adjust-input:focus {
  outline: none;
}
.parameter-adjust-input:disabled {
  cursor: not-allowed;
}
.parameter-adjust-unit {
  flex: none;
  color: inherit;
  opacity: var(--parameter-unit-opacity, 0.7);
}
.parameter-adjust-steppers {
  display: flex;
  flex: none;
  flex-direction: column;
}
.parameter-adjust-step {
  display: grid;
  place-items: center;
  width: var(--parameter-step-width, 16px);
  height: var(--parameter-step-height, 10px);
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  font-size: var(--parameter-step-font-size, 6px);
  line-height: 1;
  cursor: pointer;
}
.parameter-adjust-step:hover:not(:disabled) {
  color: var(--parameter-accent, currentColor);
}
.parameter-adjust-step:disabled {
  cursor: not-allowed;
  opacity: 0.35;
}
</style>
