import type {
  ApiResponse,
  ProductionDocument,
  ProductionOperation,
  ProductionTask,
  ProductionWorkspace,
  ProductionPromptValue,
  VideoDurationPolicy,
  VideoCandidate,
  CustomizedImageSettings,
  CustomizedVideoRenderSettings,
  CustomizedVideoSettingsDraft,
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
    prompt: ProductionPromptValue,
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
    videoSettings?: { durationPolicy?: VideoDurationPolicy; target?: { kind: 'CLIP'; id: string }; renderSettings?: CustomizedVideoRenderSettings },
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
        ...videoSettings,
        idempotencyKey: crypto.randomUUID(),
      },
      signal,
    ),
  task: (p: string, id: string, signal?: AbortSignal) =>
    call<ProductionTask>(p, `/tasks/${id}`, 'GET', undefined, signal),
  promptTask: (p: string, r: string, clipId: string, signal?: AbortSignal) =>
    call<ProductionTask | null>(
      p,
      `/prompt-task?workflowRunId=${encodeURIComponent(r)}&clipId=${encodeURIComponent(clipId)}`,
      'GET',
      undefined,
      signal,
    ),
  videoSettings: (p: string, r: string, clipId: string, revision: number, settings: CustomizedVideoRenderSettings, signal?: AbortSignal) => call<CustomizedVideoSettingsDraft>(p, '/video-settings', 'PUT', { workflowRunId: r, clipId, expectedRevision: revision, settings }, signal),
  candidate: (p: string, id: string, signal?: AbortSignal) =>
    call<VideoCandidate>(p, `/tasks/${id}/candidate`, 'GET', undefined, signal),
  reviewDraft: (
    p: string,
    id: string,
    expectedRevision: number,
    candidateHash: string,
    signal?: AbortSignal,
  ) => call(p, `/tasks/${id}/review-draft`, 'POST', { expectedRevision, candidateHash }, signal),
};
