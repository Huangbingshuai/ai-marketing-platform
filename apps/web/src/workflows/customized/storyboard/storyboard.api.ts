import type {
  ApiResponse,
  StoryboardWorkspace,
  StoryboardSettings,
  StoryboardTask,
  StoryboardDetail,
  CustomizedStoryboardScript,
  DeleteStoryboardScriptResult,
} from '@ai-marketing/contracts';
import { requestJson } from '../../../api/http-client';
const base = (p: string) => `/projects/${encodeURIComponent(p)}/workflows/customized/storyboard`;
async function call<T>(
  p: string,
  path: string,
  method: 'GET' | 'PUT' | 'POST' | 'DELETE',
  body?: unknown,
  signal?: AbortSignal,
) {
  return (await requestJson<ApiResponse<T>>(`${base(p)}${path}`, { method, body, signal })).data;
}
export const storyboardApi = {
  remove: (
    p: string,
    scriptId: string,
    workflowRunId: string,
    expectedRevision: number,
    signal?: AbortSignal,
  ) =>
    call<DeleteStoryboardScriptResult>(
      p,
      `/scripts/${scriptId}`,
      'DELETE',
      { workflowRunId, expectedRevision },
      signal,
    ),
  workspace: (p: string, run: string, signal?: AbortSignal) =>
    call<StoryboardWorkspace>(
      p,
      `?workflowRunId=${encodeURIComponent(run)}`,
      'GET',
      undefined,
      signal,
    ),
  settings: (
    p: string,
    run: string,
    revision: number,
    settings: StoryboardSettings,
    selectedScriptId: string | null,
    signal?: AbortSignal,
  ) =>
    call<{ revision: number }>(
      p,
      '/settings',
      'PUT',
      { workflowRunId: run, expectedRevision: revision, settings, selectedScriptId },
      signal,
    ),
  start: (p: string, run: string, revision: number, key: string, signal?: AbortSignal) =>
    call<StoryboardTask>(
      p,
      '/tasks',
      'POST',
      { workflowRunId: run, expectedRevision: revision, idempotencyKey: key },
      signal,
    ),
  retry: (p: string, task: string, cancel: boolean, signal?: AbortSignal) =>
    call(p, `/tasks/${task}/${cancel ? 'cancel' : 'retry'}`, 'POST', {}, signal),
  detail: (
    p: string,
    task: string,
    node: string,
    script: string,
    page: number,
    signal?: AbortSignal,
  ) =>
    call<StoryboardDetail>(
      p,
      `/tasks/${task}/nodes/${node}?page=${page}${script ? `&scriptId=${script}` : ''}`,
      'GET',
      undefined,
      signal,
    ),
  manual: (
    p: string,
    run: string,
    script: CustomizedStoryboardScript,
    origin: 'MANUAL' | 'IMPORT',
    signal?: AbortSignal,
  ) =>
    call<{ revision: number }>(
      p,
      '/scripts',
      'POST',
      { workflowRunId: run, script, origin },
      signal,
    ),
  edit: (
    p: string,
    scriptId: string,
    action: 'begin' | 'draft' | 'cancel' | 'save' | 'discard',
    revision: number,
    script?: CustomizedStoryboardScript,
    signal?: AbortSignal,
  ) =>
    call<{ revision?: number; workflowRunId?: string; unchanged?: boolean }>(
      p,
      `/scripts/${scriptId}`,
      'PUT',
      { action, expectedRevision: revision, script },
      signal,
    ),
};
