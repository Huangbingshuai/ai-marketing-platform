<script setup lang="ts">
import type { HealthData } from '@ai-marketing/contracts';
import { BaseButton } from '@ai-marketing/ui';
import { computed, ref } from 'vue';

import { fetchHealth } from '../platform/health/api/health.api';

type RequestState = 'initial' | 'loading' | 'success' | 'failure';

const state = ref<RequestState>('initial');
const health = ref<HealthData | null>(null);
const errorMessage = ref('');

const statusLabel = computed(() => {
  if (state.value === 'loading') return '检查中';
  if (state.value === 'success') return '服务正常';
  if (state.value === 'failure') return '连接失败';
  return '等待检查';
});

const checkHealth = async (): Promise<void> => {
  state.value = 'loading';
  errorMessage.value = '';

  try {
    const response = await fetchHealth();
    health.value = response.data;
    state.value = 'success';
  } catch (error) {
    health.value = null;
    errorMessage.value = error instanceof Error ? error.message : '发生未知错误';
    state.value = 'failure';
  }
};
</script>

<template>
  <main class="page-shell">
    <section class="hero" aria-labelledby="page-title">
      <p class="eyebrow">AI MARKETING PLATFORM</p>
      <h1 id="page-title">正式工程底座</h1>
      <p class="hero__summary">
        Web、API、共享契约和本地基础设施已经接入同一套工程工具链，可在此基础上开始公共项目与任务底座开发。
      </p>
    </section>

    <section class="status-card" aria-live="polite">
      <div>
        <p class="status-card__label">API 状态</p>
        <div class="status-card__value">
          <span class="status-dot" :class="`status-dot--${state}`" />
          {{ statusLabel }}
        </div>
      </div>

      <p v-if="state === 'initial'" class="status-card__detail">
        启动本地服务后，检查 Web 到 NestJS API 的完整调用链路。
      </p>
      <p v-else-if="state === 'loading'" class="status-card__detail">正在请求 /api/health…</p>
      <p v-else-if="state === 'success' && health" class="status-card__detail">
        {{ health.service }} · {{ health.status }} · {{ health.timestamp }}
      </p>
      <p v-else class="status-card__detail status-card__detail--error">{{ errorMessage }}</p>

      <BaseButton :loading="state === 'loading'" @click="checkHealth">
        {{ state === 'initial' ? '检查连接' : '重新检查' }}
      </BaseButton>
    </section>
  </main>
</template>
