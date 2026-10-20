<script setup lang="ts">
import { Package, UserRound, Image, Captions, Music, Mic, Sparkles, Video } from '@lucide/vue';
withDefaults(defineProps<{ type?: string; size?: number }>(), { type: 'product', size: 20 });
const icons = {
  product: Package,
  person: UserRound,
  scene: Image,
  subtitle: Captions,
  bgm: Music,
  voiceover: Mic,
  video: Video,
  image: Image,
  sparkles: Sparkles,
};
</script>
<template>
  <component :is="icons[type as keyof typeof icons] ?? Package" :size="size" aria-hidden="true" />
</template>
