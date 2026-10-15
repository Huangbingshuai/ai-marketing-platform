import { readonly, ref } from 'vue';

/** In-flight submission only; durable cleanup status always comes from the API. */
export function useProjectDeletionRequests() {
  const pendingIds = ref<string[]>([]);
  const isPending = (projectId: string): boolean => pendingIds.value.includes(projectId);

  async function submit<T>(projectId: string, request: () => Promise<T>): Promise<T | undefined> {
    if (isPending(projectId)) return undefined;
    pendingIds.value = [...pendingIds.value, projectId];
    try {
      return await request();
    } finally {
      pendingIds.value = pendingIds.value.filter((id) => id !== projectId);
    }
  }

  return { pendingIds: readonly(pendingIds), isPending, submit };
}
