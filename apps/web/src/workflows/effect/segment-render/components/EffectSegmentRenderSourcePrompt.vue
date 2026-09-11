<script setup lang="ts">
import { EFFECT_PROMPT_DIMENSIONS } from '@ai-marketing/contracts';

import type { EffectSegmentRenderPromptDetails } from '../effect-segment-render-state';

withDefaults(
  defineProps<{
    compact?: boolean;
    details?: EffectSegmentRenderPromptDetails | null;
    heading?: string;
    promptText: string;
  }>(),
  {
    compact: false,
    details: null,
    heading: '',
  },
);
</script>

<template>
  <section
    class="source-prompt-panel"
    :class="{ 'source-prompt-panel--compact': compact }"
    aria-label="来源 Prompt"
  >
    <header v-if="heading" class="source-prompt-heading">
      <strong>{{ heading }}</strong>
    </header>
    <pre class="source-prompt-content">{{ promptText }}</pre>
    <details v-if="details" class="source-prompt-detail">
      <summary>查看创意方向</summary>
      <p class="prompt-creative-core">{{ details.creativeCore }}</p>
    </details>
    <details v-if="details" class="source-prompt-detail">
      <summary>查看六维创意信息</summary>
      <div class="prompt-source-dimensions">
        <span v-for="dimension in EFFECT_PROMPT_DIMENSIONS" :key="dimension.key">
          <b>{{ dimension.label }}</b>
          {{ details.dimensions[dimension.key] }}
        </span>
      </div>
    </details>
  </section>
</template>

<style scoped>
.source-prompt-panel {
  min-width: 0;
}
.source-prompt-panel--compact {
  margin-top: 2px;
  padding-top: 12px;
  border-top: 1px solid #e8edf5;
}
.source-prompt-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  color: #334155;
  font-size: 12px;
}
.source-prompt-content {
  max-height: 310px;
  margin: 12px 0;
  padding: 14px;
  overflow: auto;
  color: #42526a;
  white-space: pre-wrap;
  background: #f8fafc;
  border: 1px solid #e4e9f1;
  border-radius: 10px;
  font-family: inherit;
  font-size: 11px;
  line-height: 1.75;
}
.source-prompt-panel--compact .source-prompt-content {
  max-height: 190px;
  margin-top: 8px;
}
.source-prompt-detail {
  margin: 8px 0 0;
  color: #78869a;
  font-size: 9px;
}
.source-prompt-detail summary {
  width: max-content;
  color: #5577a8;
  cursor: pointer;
  user-select: none;
}
.source-prompt-detail .prompt-creative-core,
.source-prompt-detail .prompt-source-dimensions {
  margin-top: 7px;
}
.prompt-creative-core {
  margin: 0;
  padding: 8px 10px;
  color: #253047;
  background: #f4f8ff;
  border: 1px solid #cfe0ff;
  border-radius: 7px;
  font-size: 10px;
  line-height: 1.6;
}
.prompt-source-dimensions {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 7px;
}
.prompt-source-dimensions > span {
  padding: 8px 9px;
  color: #42526a;
  background: #f4f8ff;
  border: 1px solid #cfe0ff;
  border-radius: 7px;
  font-size: 9px;
  line-height: 1.55;
}
.prompt-source-dimensions b {
  display: block;
  margin-bottom: 2px;
  color: #2f6fed;
}

@media (max-width: 680px) {
  .prompt-source-dimensions {
    grid-template-columns: 1fr;
  }
}
</style>
