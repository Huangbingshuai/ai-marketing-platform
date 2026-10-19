<script setup lang="ts">
import { computed } from 'vue';
import { NodeViewWrapper, nodeViewProps } from '@tiptap/vue-3';
import { Image } from '@lucide/vue';
import type { PromptMentionImages } from './production-prompt-document';
const props = defineProps(nodeViewProps);
const context = computed(() => props.extension.options.context as PromptMentionImages);
const asset = computed(() => context.value.assets().find((a) => a.id === props.node.attrs.id));
const label = computed(() => String(props.node.attrs.label));
const url = computed(() => context.value.urls[String(props.node.attrs.id)]);
</script>
<template>
  <NodeViewWrapper
    as="span"
    class="prompt-mention"
    :class="{ selected }"
    contenteditable="false"
    :data-asset-id="node.attrs.id"
    :title="`引用素材：${label}`"
  >
    <span class="at">@</span
    ><span class="thumb" aria-hidden="true">
      <img
        v-if="url"
        :src="url"
        alt=""
        draggable="false"
        @error="delete context.urls[String(node.attrs.id)]"
      />
      <Image v-else :size="12" :stroke-width="1.5" /> </span
    ><span class="name">{{ label }}</span>
    <span v-if="!asset" class="unavailable" aria-label="引用不在当前素材中">!</span>
  </NodeViewWrapper>
</template>
<style scoped>
.prompt-mention {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: 100%;
  box-sizing: border-box;
  vertical-align: baseline;
  margin: 0 1px;
  padding: 0 5px;
  border-radius: 5px;
  background: #edf4ff;
  box-shadow: inset 0 0 0 1px #d9e6fa;
  color: #365fa8;
  line-height: 23px;
  font-weight: 500;
  user-select: all;
}
.prompt-mention.selected {
  background: #dce9ff;
  box-shadow: inset 0 0 0 1px #7197e1;
}
.at {
  color: #6d91c8;
  font-size: 12px;
}
.thumb {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  flex: 0 0 18px;
  overflow: hidden;
  border-radius: 3px;
  background: #e0e9f4;
}
.thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.name {
  min-width: 0;
  overflow-wrap: anywhere;
}
.unavailable {
  color: #b58230;
}
</style>
