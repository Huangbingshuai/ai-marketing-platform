import type { EffectImportMaterial } from '@ai-marketing/contracts';
import { computed, onScopeDispose, ref, watch } from 'vue';

const RETRY_DELAYS = [500, 1500, 3000];

/** Read-only preview state; never modifies the imported material or its revision. */
export const useEffectImportImagePreview = (material: () => EffectImportMaterial) => {
  const attempt = ref(0);
  const generation = ref(0);
  const state = ref<'loading' | 'ready' | 'retrying' | 'failed'>('loading');
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clearTimer = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  const supported = computed(() => {
    const item = material();
    return (
      item.type === 'PRODUCT_IMAGE' &&
      item.status === 'READY' &&
      !!item.contentUrl &&
      !/\.psd$/i.test(item.originalFileName ?? item.expectedFileName ?? '') &&
      item.mimeType !== 'image/vnd.adobe.photoshop'
    );
  });
  // A replacement keeps the material ID and route but changes updatedAt.
  watch(
    () =>
      JSON.stringify([
        material().projectId,
        material().productId,
        material().id,
        material().contentUrl,
        material().updatedAt,
        material().status,
        supported.value,
      ]),
    () => {
      clearTimer();
      generation.value++;
      attempt.value = 0;
      state.value = 'loading';
    },
    { immediate: true, flush: 'sync' },
  );
  const requestKey = computed(() => `${generation.value}:${attempt.value}`);
  const source = computed(() => {
    if (!supported.value) return null;
    const item = material();
    const [path, fragment] = item.contentUrl!.split('#');
    const version = encodeURIComponent(`${item.updatedAt}:${requestKey.value}`);
    return `${path}${path!.includes('?') ? '&' : '?'}preview=${version}${fragment === undefined ? '' : `#${fragment}`}`;
  });
  const loaded = (key: string): void => {
    if (key !== requestKey.value) return;
    clearTimer();
    state.value = 'ready';
  };
  const failed = (key: string): void => {
    if (key !== requestKey.value || !supported.value || state.value !== 'loading') return;
    const delay = RETRY_DELAYS[attempt.value];
    if (delay === undefined) {
      state.value = 'failed';
      return;
    }
    state.value = 'retrying';
    timer = setTimeout(() => {
      timer = undefined;
      attempt.value++;
      state.value = 'loading';
    }, delay);
  };
  const retry = (): void => {
    clearTimer();
    generation.value++;
    attempt.value = 0;
    state.value = 'loading';
  };
  onScopeDispose(clearTimer);
  return { source, supported, state, requestKey, loaded, failed, retry };
};
