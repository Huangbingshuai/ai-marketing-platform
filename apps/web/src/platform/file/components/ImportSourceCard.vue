<script setup lang="ts">
defineProps<{ title: string; description: string }>();
</script>
<template>
  <section class="source-card upload-source-card">
    <header class="panel-heading">
      <span class="panel-heading-icon"><slot name="icon" /></span>
      <div>
        <h3>{{ title }}</h3>
        <p>{{ description }}</p>
      </div>
      <span class="card-actions"><slot name="actions" /></span>
    </header>
    <slot />
  </section>
</template>
<style scoped src="./import-source.css"></style>
<style scoped>
.source-card {
  min-width: 0;
}
.card-actions {
  margin-left: auto;
  flex-shrink: 0;
}
@media (max-width: 780px) {
  .panel-heading {
    flex-wrap: wrap;
  }
  .card-actions {
    margin-left: 49px;
  }
}
</style>
