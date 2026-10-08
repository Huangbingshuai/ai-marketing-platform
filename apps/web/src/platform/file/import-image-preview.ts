export type ImportImageFile = {
  id: string;
  projectId: string;
  groupId?: string;
  name: string;
  contentUrl: string;
  updatedAt: string;
  mimeType?: string | null;
  ready: boolean;
};
import { computed, onScopeDispose, ref, watch } from 'vue';

const RETRY_DELAYS = [500, 1500, 3000];

/** Read-only preview state; never modifies the imported material or its revision. */
export const useImportImagePreview = (material: () => ImportImageFile) => {
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
      item.ready &&
      !!item.contentUrl &&
      !/\.psd$/i.test(item.name) &&
      item.mimeType !== 'image/vnd.adobe.photoshop'
    );
  });
  // A replacement keeps the material ID and route but changes updatedAt.
  watch(
    () =>
      JSON.stringify([
        material().projectId,
        material().groupId,
        material().id,
        material().contentUrl,
        material().updatedAt,
        material().ready,
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
    // Keep the first URL stable across mounts. Only failed attempts need a fresh request.
    const suffix = attempt.value || generation.value > 1 ? `:${requestKey.value}` : '';
    const version = encodeURIComponent(`${item.updatedAt}${suffix}`);
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
