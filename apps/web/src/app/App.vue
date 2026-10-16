<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import ProjectManagementPage from '../platform/project/ProjectManagementPage.vue';
import ActionConfirmationDialog from '../shared/components/ActionConfirmationDialog.vue';
import LoginPage from '../platform/auth/LoginPage.vue';
import { authReady, authSession, invalidateAuth, restoreAuth } from '../platform/auth/auth-state';

const startupError = ref('');
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
  void restore();
});
onBeforeUnmount(() => window.removeEventListener('richi:auth-required', invalidateAuth));
</script>

<template>
  <template v-if="authSession && !checking">
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
