<script setup lang="ts">
import { Pencil } from '@lucide/vue';
defineProps<{ nodeLabel: string; description: string }>();
</script>
<template>
  <div class="effect-edit-mode-banner" role="status">
    <span class="effect-edit-mode-banner__icon"><Pencil :size="18" /></span>
    <span class="effect-edit-mode-banner__copy"
      ><strong
        >编辑草稿中 <small>{{ nodeLabel }}</small></strong
      ><span>{{ description }}</span></span
    >
    <span class="effect-edit-mode-banner__badge">未发布</span>
  </div>
</template>
<style scoped>
.effect-edit-mode-banner {
  display: flex;
  align-items: center;
  gap: 13px;
  margin: 16px 0;
  padding: 13px 16px;
  color: #71480d;
  background: #fff7e6;
  border: 1px solid #efcf91;
  border-left: 4px solid #dfa438;
  border-radius: 13px;
  box-shadow: 0 6px 18px #b8791712;
}
.effect-edit-mode-banner__icon {
  display: grid;
  flex: 0 0 34px;
  height: 34px;
  place-items: center;
  color: #a96a12;
  background: #ffedc5;
  border-radius: 10px;
}
.effect-edit-mode-banner__copy {
  display: grid;
  flex: 1;
  gap: 3px;
  min-width: 0;
  font-size: 12px;
  line-height: 1.45;
}
.effect-edit-mode-banner__copy strong {
  font-size: 13px;
}
.effect-edit-mode-banner__copy small {
  margin-left: 6px;
  color: #a16e20;
  font-size: 11px;
  font-weight: 600;
}
.effect-edit-mode-banner__badge {
  flex: 0 0 auto;
  padding: 5px 9px;
  color: #9b6110;
  background: #fff;
  border: 1px solid #ebd19f;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 800;
}
@media (max-width: 680px) {
  .effect-edit-mode-banner {
    align-items: flex-start;
    flex-wrap: wrap;
  }
  .effect-edit-mode-banner__badge {
    margin-left: 47px;
  }
}
</style>
