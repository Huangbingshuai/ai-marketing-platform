<script setup lang="ts">
withDefaults(
  defineProps<{
    detail: string;
    state?: 'clean' | 'conflict' | 'dirty' | 'save_failed' | 'saved' | 'saving';
    stateLabel: string;
    title: string;
  }>(),
  {
    state: 'clean',
  },
);
</script>

<template>
  <section class="workflow-node-draft-bar" aria-label="节点草稿状态">
    <span class="workflow-node-draft-bar__icon" aria-hidden="true">
      <svg viewBox="0 0 24 24">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
        <path d="M14 2v6h6M8 13h8M8 17h8M8 9h2" />
      </svg>
    </span>
    <div>
      <strong>{{ title }}</strong>
      <small>{{ detail }}</small>
    </div>
    <em :class="state" role="status" aria-live="polite">{{ stateLabel }}</em>
  </section>
</template>

<style scoped>
.workflow-node-draft-bar {
  display: flex;
  min-height: 67px;
  margin-top: 18px;
  padding: 12px 16px;
  box-sizing: border-box;
  align-items: center;
  gap: 12px;
  background: linear-gradient(90deg, #f4f8ff, #fff);
  border: 1px solid #d8e3f3;
  border-radius: 14px;
}
.workflow-node-draft-bar__icon {
  display: grid;
  width: 38px;
  height: 38px;
  flex: 0 0 38px;
  place-items: center;
  color: #2563eb;
  background: #e8f1ff;
  border-radius: 11px;
}
.workflow-node-draft-bar__icon svg {
  width: 18px;
  height: 18px;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.workflow-node-draft-bar > div {
  min-width: 0;
  flex: 1;
}
.workflow-node-draft-bar strong,
.workflow-node-draft-bar small {
  display: block;
}
.workflow-node-draft-bar strong {
  color: #1e2b43;
  font-size: 12px;
}
.workflow-node-draft-bar small {
  margin-top: 3px;
  overflow: hidden;
  color: #7d899f;
  font-size: 9px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.workflow-node-draft-bar em {
  padding: 5px 9px;
  color: #68768c;
  background: #eef2f7;
  border-radius: 999px;
  font-size: 9px;
  font-style: normal;
  white-space: nowrap;
}
.workflow-node-draft-bar em.dirty,
.workflow-node-draft-bar em.saving {
  color: #b7791f;
  background: #fff8e8;
}
.workflow-node-draft-bar em.clean,
.workflow-node-draft-bar em.saved {
  color: #0f8a68;
  background: #eefaf6;
}
.workflow-node-draft-bar em.conflict,
.workflow-node-draft-bar em.save_failed {
  color: #dc3f52;
  background: #fff1f2;
}
@media (max-width: 680px) {
  .workflow-node-draft-bar {
    align-items: flex-start;
    flex-wrap: wrap;
  }
  .workflow-node-draft-bar > div {
    width: calc(100% - 50px);
    flex: none;
  }
  .workflow-node-draft-bar em {
    margin-left: 50px;
  }
}
</style>
