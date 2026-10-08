<script setup lang="ts">
import { FileText, Film, Layers, PackageOpen, Sparkles } from '@lucide/vue';

const icons = {
  import: PackageOpen,
  extraction: FileText,
  prompt: Sparkles,
  render: Film,
  mix: Layers,
  output: Film,
};

withDefaults(
  defineProps<{
    title?: string;
    description: string;
    icon?: keyof typeof icons;
    minHeight?: number;
  }>(),
  {
    title: '正在恢复资料包草稿',
    icon: 'import',
    minHeight: 430,
  },
);
</script>

<template>
  <section
    class="workflow-page-loading"
    :style="{ minHeight: `${minHeight}px` }"
    role="status"
    aria-live="polite"
    aria-busy="true"
  >
    <span class="loading-icon" aria-hidden="true">
      <component :is="icons[icon]" :size="24" />
    </span>
    <h2>{{ title }}</h2>
    <p>{{ description }}</p>
  </section>
</template>

<style scoped>
.workflow-page-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  color: #7f8da2;
  text-align: center;
  gap: 10px;
  padding: 24px;
}
.loading-icon {
  display: grid;
  width: 48px;
  height: 48px;
  flex-shrink: 0;
  place-items: center;
  color: #2563eb;
  background: #eaf2ff;
  border-radius: 15px;
  animation: loading-icon-breathe 1.6s ease-in-out infinite;
}
@keyframes loading-icon-breathe {
  0%,
  100% {
    opacity: 0.7;
    transform: translateY(0) scale(0.96);
  }
  50% {
    opacity: 1;
    transform: translateY(-3px) scale(1.06);
  }
}
@media (prefers-reduced-motion: reduce) {
  .loading-icon {
    animation: none;
  }
}
.workflow-page-loading h2 {
  margin: 2px 0 0;
  color: #34445c;
  font-size: 17px;
}
.workflow-page-loading p {
  max-width: 560px;
  margin: 0;
  font-size: 12px;
  line-height: 1.7;
}
</style>
