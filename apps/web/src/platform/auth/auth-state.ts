import type { ApiResponse, AuthSession, LoginRequest } from '@ai-marketing/contracts';
import { readonly, ref } from 'vue';
import { ApiClientError, requestJson } from '../../api/http-client';
import { advanceAuthGeneration } from '../../api/auth-events';

const session = ref<AuthSession | null>(null);
const ready = ref(false);
export const authSession = readonly(session);
export const authReady = readonly(ready);

export const invalidateAuth = (): void => {
  advanceAuthGeneration();
  session.value = null;
};

export const restoreAuth = async (): Promise<void> => {
  try {
    session.value = (await requestJson<ApiResponse<AuthSession>>('/auth/session')).data;
  } catch (error) {
    if (!(error instanceof ApiClientError) || error.status !== 401) throw error;
    session.value = null;
  } finally {
    ready.value = true;
  }
};

export const login = async (input: LoginRequest): Promise<void> => {
  session.value = (
    await requestJson<ApiResponse<AuthSession>>('/auth/login', { method: 'POST', body: input })
  ).data;
  advanceAuthGeneration();
};

export const logout = async (): Promise<void> => {
  await requestJson('/auth/logout', { method: 'POST' });
  advanceAuthGeneration();
  session.value = null;
};
