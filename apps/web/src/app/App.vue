<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import ProjectManagementPage from '../platform/project/ProjectManagementPage.vue';
import ActionConfirmationDialog from '../shared/components/ActionConfirmationDialog.vue';
import LoginPage from '../platform/auth/LoginPage.vue';
import FissionWorkflowPage from '../workflows/fission/shared/FissionWorkflowPage.vue';
import { authReady, authSession, invalidateAuth, restoreAuth } from '../platform/auth/auth-state';

const startupError = ref('');
// Explicit development-only preview; production continues through the normal login.
const localReplacePreview =
  import.meta.env.DEV && new URLSearchParams(location.search).get('mock') === 'local-replace';
const localReplacePreviewProject = localReplacePreview
  ? new URLSearchParams(location.search).get('mockProject') || ''
  : '';
const checking = ref(false);
const restore = async (): Promise<void> => {
  checking.value = true;
  startupError.value = '';
  try {
    await restoreAuth();
  } catch {
    startupError.value = '暂时无法连接系统，请稍后重试';
  } finally {
    checking.value = false;
  }
};
onMounted(() => {
  window.addEventListener('richi:auth-required', invalidateAuth);
  if (!localReplacePreview) void restore();
});
onBeforeUnmount(() => window.removeEventListener('richi:auth-required', invalidateAuth));
</script>

<template>
  <template v-if="localReplacePreview">
    <header class="local-replace-preview-header">
      <strong>✧ 裂变工坊 <small>AI Material Studio</small></strong
      ><span>● 本地 Mock · 独立演示空间</span>
    </header>
    <FissionWorkflowPage
      preview
      initial-module="replace"
      :project-id="localReplacePreviewProject"
    />
  </template>
  <template v-else-if="authSession && !checking">
    <ProjectManagementPage />
    <ActionConfirmationDialog />
  </template>
  <LoginPage
    v-else
    :checking="checking || !authReady"
    :startup-error="startupError"
    @retry="restore"
  />
</template>
<style>
.local-replace-preview-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 72px;
  padding: 12px max(24px, calc((100vw - 1312px) / 2));
  border-bottom: 1px solid #dbe4f6;
  background: #fff;
  color: #172033;
}
.local-replace-preview-header strong {
  font-size: 18px;
}
.local-replace-preview-header small {
  display: block;
  margin-top: 3px;
  color: #94a3b8;
  font-size: 10px;
  letter-spacing: 1.6px;
}
.local-replace-preview-header > span {
  color: #64748b;
  font-size: 12px;
}
</style>
