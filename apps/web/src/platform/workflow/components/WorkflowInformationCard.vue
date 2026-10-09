<template>
  <section class="workflow-information-card"><slot /></section>
</template>

<style scoped>
.workflow-information-card {
  padding: 20px;
  background: #fff;
  border: 1px solid #f0e2db;
  border-radius: 20px;
  min-width: 0;
}
@media (max-width: 680px) {
  .workflow-information-card {
    padding: 16px;
  }
}
</style>
