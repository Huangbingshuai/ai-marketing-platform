import type {
  ApiResponse,
  ProductionDocument,
  ProductionOperation,
  ProductionTask,
  ProductionWorkspace,
  ProductionPrompt,
  CustomizedImageSettings,
  Asset,
} from '@ai-marketing/contracts';
import { requestJson } from '../../../api/http-client';
const base = (p: string) => `/projects/${encodeURIComponent(p)}/workflows/customized/production`;
async function call<T>(
  p: string,
  path: string,
  method: 'GET' | 'PUT' | 'POST',
  body?: unknown,
  signal?: AbortSignal,
) {
  return (await requestJson<ApiResponse<T>>(base(p) + path, { method, body, signal })).data;
}
export const productionApi = {
  uploadImageReference: (p: string, r: string, file: File, signal?: AbortSignal) => {
    const form = new FormData();
    form.set('workflowRunId', r);
    form.set('image', file);
    return call<Asset>(p, '/image-references', 'POST', form, signal);
  },
  prompt: (
    p: string,
    r: string,
    expectedRevision: number,
    prompt: ProductionPrompt,
    signal?: AbortSignal,
  ) => call(p, '/prompt', 'PUT', { workflowRunId: r, expectedRevision, prompt }, signal),
  workspace: (p: string, r: string, signal?: AbortSignal) =>
    call<ProductionWorkspace>(p, `?workflowRunId=${r}`, 'GET', undefined, signal),
  save: (
    p: string,
    r: string,
    expectedRevision: number,
    document: ProductionDocument,
    section: 'ASSETS' | 'SHOTS',
    confirm: boolean,
    signal?: AbortSignal,
  ) =>
    call<{ revision: number }>(
      p,
      '',
      'PUT',
      { workflowRunId: r, expectedRevision, document, section, confirm },
      signal,
    ),
  start: (
    p: string,
    r: string,
    expectedRevision: number,
    operation: ProductionOperation,
    shotId?: string,
    signal?: AbortSignal,
    targetAssetId?: string,
    imageSettings?: CustomizedImageSettings,
  ) =>
    call<ProductionTask>(
      p,
      '/tasks',
      'POST',
      {
        workflowRunId: r,
        expectedRevision,
        operation,
        shotId,
        targetAssetId,
        imageSettings,
        idempotencyKey: crypto.randomUUID(),
      },
      signal,
    ),
  task: (p: string, id: string, signal?: AbortSignal) =>
    call<ProductionTask>(p, `/tasks/${id}`, 'GET', undefined, signal),
};
