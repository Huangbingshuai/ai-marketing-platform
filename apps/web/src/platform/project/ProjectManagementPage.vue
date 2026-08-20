<script setup lang="ts">
import type { CreateProjectRequest } from '@ai-marketing/contracts';
import { AlertTriangle, CheckCircle2, Layers3, LoaderCircle, Plus, Target, X } from '@lucide/vue';
import { onBeforeUnmount, reactive, ref } from 'vue';

import { createProject } from './api/project.api';

type SubmitState = 'idle' | 'submitting';

const modalOpen = ref(false);
const submitState = ref<SubmitState>('idle');
const errorMessage = ref('');
const toastMessage = ref('');
const form = reactive({ name: '', description: '' });
let toastTimer: ReturnType<typeof setTimeout> | undefined;

const resetForm = (): void => {
  form.name = '';
  form.description = '';
  errorMessage.value = '';
  submitState.value = 'idle';
};

const openCreateModal = (): void => {
  resetForm();
  modalOpen.value = true;
};

const closeCreateModal = (): void => {
  if (submitState.value === 'submitting') return;
  modalOpen.value = false;
};

const showToast = (message: string): void => {
  toastMessage.value = message;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastMessage.value = '';
  }, 3200);
};

const submitCreate = async (): Promise<void> => {
  const name = form.name.trim();
  if (!name) {
    errorMessage.value = '请输入项目名称';
    return;
  }

  submitState.value = 'submitting';
  errorMessage.value = '';

  const payload: CreateProjectRequest = {
    name,
    ...(form.description.trim() ? { description: form.description.trim() } : {}),
  };

  try {
    const response = await createProject(payload);
    if (!response.success) throw new Error(response.message || '创建项目失败');
    modalOpen.value = false;
    showToast(`项目“${response.data.name}”创建成功`);
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '创建项目失败，请稍后重试';
  } finally {
    submitState.value = 'idle';
  }
};

onBeforeUnmount(() => {
  if (toastTimer) clearTimeout(toastTimer);
});
</script>

<template>
  <div class="project-create-page">
    <header class="system-header">
      <div class="system-brand">
        <span class="system-brand-mark"><Layers3 :size="23" /></span>
        <strong>AI 营销素材智能生成系统</strong>
      </div>

      <nav class="system-routes" aria-label="业务模块">
        <span class="system-route system-route--active">效果类</span>
        <span class="system-route">定制类</span>
        <span class="system-route">裂变类</span>
      </nav>

      <button class="create-button" type="button" @click="openCreateModal">
        <Plus :size="16" />
        <span>创建项目</span>
      </button>
    </header>

    <div class="system-context">
      <span class="context-icon"><Target :size="18" /></span>
      <strong>效果类 AI 素材批量生成</strong>
    </div>

    <main aria-label="项目创建" />

    <Transition name="fade">
      <div v-if="modalOpen" class="modal-backdrop" @mousedown.self="closeCreateModal">
        <section
          class="create-modal"
          role="dialog"
          aria-modal="true"
          aria-labelledby="create-project-title"
          @keydown.esc="closeCreateModal"
        >
          <header class="modal-header">
            <div>
              <span>PROJECT</span>
              <h1 id="create-project-title">创建项目</h1>
              <p>填写项目基础信息，创建后将真实写入 PostgreSQL。</p>
            </div>
            <button
              class="icon-button"
              type="button"
              aria-label="关闭创建项目弹窗"
              :disabled="submitState === 'submitting'"
              @click="closeCreateModal"
            >
              <X :size="18" />
            </button>
          </header>

          <form class="create-form" @submit.prevent="submitCreate">
            <label>
              <span>项目名称 <b>*</b></span>
              <!-- prettier-ignore -->
              <input
                v-model="form.name"
                autofocus
                maxlength="120"
                placeholder="例如：广味食品 · 夏季投放"
                :disabled="submitState === 'submitting'"
              >
            </label>

            <label>
              <span>项目说明</span>
              <textarea
                v-model="form.description"
                maxlength="500"
                rows="4"
                placeholder="可选，简要说明项目目标"
                :disabled="submitState === 'submitting'"
              />
              <small>{{ form.description.length }} / 500</small>
            </label>

            <div v-if="errorMessage" class="error-message" role="alert">
              <AlertTriangle :size="17" />
              <span>{{ errorMessage }}</span>
            </div>

            <footer class="modal-actions">
              <button
                class="secondary-button"
                type="button"
                :disabled="submitState === 'submitting'"
                @click="closeCreateModal"
              >
                取消
              </button>
              <button class="primary-button" type="submit" :disabled="submitState === 'submitting'">
                <LoaderCircle v-if="submitState === 'submitting'" class="spinner" :size="17" />
                <Plus v-else :size="17" />
                {{ submitState === 'submitting' ? '创建中...' : '确认创建' }}
              </button>
            </footer>
          </form>
        </section>
      </div>
    </Transition>

    <Transition name="toast">
      <div v-if="toastMessage" class="success-toast" role="status">
        <CheckCircle2 :size="18" />
        <span>{{ toastMessage }}</span>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.project-create-page {
  --system-blue: #2563eb;
  --system-blue-dark: #1d4ed8;
  --system-ink: #0f1b33;
  --system-muted: #64748b;
  --system-border: #dbe4f6;
  min-height: 100vh;
  color: var(--system-ink);
  background:
    radial-gradient(circle at 4% 30%, rgb(255 232 232 / 60%), transparent 23%),
    linear-gradient(135deg, #fbfdff 0%, #f3f7ff 100%);
}

.system-header {
  display: flex;
  height: 68px;
  padding: 0 35px;
  align-items: center;
  gap: 54px;
  background: rgb(255 255 255 / 96%);
  border-bottom: 1px solid #d9e3f7;
  box-shadow: 0 5px 22px rgb(29 78 216 / 4%);
}

.system-brand {
  display: flex;
  align-items: center;
  gap: 14px;
  font-size: 20px;
  white-space: nowrap;
}

.system-brand-mark {
  display: grid;
  width: 50px;
  height: 50px;
  place-items: center;
  color: #fff;
  background: var(--system-blue);
  border-radius: 16px;
  box-shadow: 0 10px 24px rgb(37 99 235 / 22%);
}

.system-routes {
  display: flex;
  align-self: stretch;
  gap: 40px;
}

.system-route {
  position: relative;
  display: flex;
  align-items: center;
  color: #64748b;
  font-size: 18px;
  font-weight: 700;
}

.system-route--active {
  color: var(--system-blue);
}

.system-route--active::after {
  position: absolute;
  right: 0;
  bottom: 0;
  left: 0;
  height: 4px;
  background: var(--system-blue);
  border-radius: 4px 4px 0 0;
  content: '';
}

.create-button {
  display: inline-flex;
  min-height: 44px;
  margin-left: auto;
  padding: 0 18px;
  align-items: center;
  gap: 8px;
  color: #fff;
  background: var(--system-blue);
  border: 1px solid var(--system-blue);
  border-radius: 14px;
  font-weight: 700;
  box-shadow: 0 9px 20px rgb(37 99 235 / 18%);
  transition:
    background 160ms ease,
    transform 160ms ease;
}

.create-button:hover,
.primary-button:hover:not(:disabled) {
  background: var(--system-blue-dark);
  transform: translateY(-1px);
}

.system-context {
  display: flex;
  height: 64px;
  padding: 0 35px;
  align-items: center;
  gap: 14px;
  background: rgb(250 252 255 / 92%);
  border-bottom: 1px solid #dbe4f6;
}

.context-icon {
  display: grid;
  width: 46px;
  height: 46px;
  place-items: center;
  color: var(--system-blue);
  background: #eef3ff;
  border: 1px solid #c7d7ff;
  border-radius: 14px;
}

.system-context strong {
  font-size: 17px;
}

main {
  min-height: calc(100vh - 132px);
}

.modal-backdrop {
  position: fixed;
  z-index: 20;
  inset: 0;
  display: grid;
  padding: 24px;
  place-items: center;
  background: rgb(15 23 42 / 48%);
  backdrop-filter: blur(5px);
}

.create-modal {
  width: min(560px, 100%);
  overflow: hidden;
  background: #fff;
  border: 1px solid #dbe4f6;
  border-radius: 24px;
  box-shadow: 0 26px 70px rgb(15 23 42 / 24%);
}

.modal-header {
  display: flex;
  padding: 28px 30px 24px;
  align-items: flex-start;
  justify-content: space-between;
  background: linear-gradient(135deg, #f7faff, #fff);
  border-bottom: 1px solid #e5ebf8;
}

.modal-header span {
  color: var(--system-blue);
  font-size: 12px;
  font-weight: 800;
  letter-spacing: 0.16em;
}

.modal-header h1 {
  margin: 6px 0;
  font-size: 25px;
}

.modal-header p {
  margin: 0;
  color: var(--system-muted);
  font-size: 14px;
}

.icon-button {
  display: grid;
  width: 36px;
  height: 36px;
  flex: 0 0 auto;
  place-items: center;
  color: #64748b;
  background: #fff;
  border: 1px solid var(--system-border);
  border-radius: 50%;
}

.create-form {
  display: grid;
  padding: 26px 30px 30px;
  gap: 22px;
}

.create-form label {
  position: relative;
  display: grid;
  gap: 9px;
}

.create-form label > span {
  color: #334155;
  font-size: 14px;
  font-weight: 700;
}

.create-form b {
  color: #ef4444;
}

.create-form input,
.create-form textarea {
  width: 100%;
  padding: 13px 14px;
  color: var(--system-ink);
  background: #fff;
  border: 1px solid #d7e0f0;
  border-radius: 12px;
  outline: none;
  resize: vertical;
  transition:
    border-color 150ms ease,
    box-shadow 150ms ease;
}

.create-form input:focus,
.create-form textarea:focus {
  border-color: #7ca3ff;
  box-shadow: 0 0 0 4px rgb(37 99 235 / 10%);
}

.create-form input:disabled,
.create-form textarea:disabled {
  background: #f8fafc;
}

.create-form small {
  position: absolute;
  right: 10px;
  bottom: 9px;
  color: #94a3b8;
  font-size: 11px;
}

.error-message {
  display: flex;
  padding: 11px 13px;
  align-items: center;
  gap: 9px;
  color: #b42318;
  background: #fff2f0;
  border: 1px solid #ffd0cb;
  border-radius: 11px;
  font-size: 13px;
}

.modal-actions {
  display: flex;
  padding-top: 4px;
  justify-content: flex-end;
  gap: 10px;
}

.secondary-button,
.primary-button {
  display: inline-flex;
  min-height: 42px;
  padding: 0 18px;
  align-items: center;
  justify-content: center;
  gap: 8px;
  border-radius: 12px;
  font-weight: 700;
}

.secondary-button {
  color: #475569;
  background: #fff;
  border: 1px solid #d7e0f0;
}

.primary-button {
  min-width: 122px;
  color: #fff;
  background: var(--system-blue);
  border: 1px solid var(--system-blue);
  transition:
    background 160ms ease,
    transform 160ms ease;
}

button:disabled {
  cursor: not-allowed;
  opacity: 0.6;
}

.spinner {
  animation: spin 0.8s linear infinite;
}

.success-toast {
  position: fixed;
  z-index: 30;
  right: 28px;
  bottom: 28px;
  display: flex;
  padding: 14px 18px;
  align-items: center;
  gap: 9px;
  color: #166534;
  background: #f0fdf4;
  border: 1px solid #bbf7d0;
  border-radius: 13px;
  box-shadow: 0 16px 40px rgb(15 23 42 / 14%);
  font-weight: 700;
}

.fade-enter-active,
.fade-leave-active,
.toast-enter-active,
.toast-leave-active {
  transition: opacity 160ms ease;
}

.fade-enter-from,
.fade-leave-to,
.toast-enter-from,
.toast-leave-to {
  opacity: 0;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

@media (max-width: 820px) {
  .system-header {
    height: 62px;
    padding: 0 16px;
    gap: 18px;
  }

  .system-brand strong,
  .system-routes {
    display: none;
  }

  .system-brand-mark {
    width: 42px;
    height: 42px;
    border-radius: 13px;
  }

  .system-context {
    height: 58px;
    padding: 0 16px;
  }

  main {
    min-height: calc(100vh - 120px);
  }

  .create-modal {
    border-radius: 18px;
  }

  .modal-header,
  .create-form {
    padding-right: 20px;
    padding-left: 20px;
  }
}
</style>
