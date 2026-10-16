import { afterEach, describe, expect, it, vi } from 'vitest';
import { cancelEffectTemplateMixAppend } from './effect-template-mix.api';

import {
  createEffectTemplateMixAiRun,
  createEmptyEffectTemplateMixVariant,
  deleteEffectTemplateMixVariant,
  resumeEffectTemplateMixAppend,
  saveEffectTemplateMixDraft,
  loadMixFinalOutputRuns,
  updateMixSourceProjects,
  getMixSourceUpdateRun,
} from './effect-template-mix.api';

afterEach(() => vi.unstubAllGlobals());

describe('effect template mix API', () => {
  it('cancels only the requested task in the requested project', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ data: { status: 'CANCELLED' } })));
    vi.stubGlobal('fetch', fetchMock);
    await cancelEffectTemplateMixAppend('project/1', 'task/1');
    expect(fetchMock.mock.calls[0]![0]).toBe(
      '/api/projects/project%2F1/workflows/effect/template-mix/ai-fill-runs/task%2F1/cancel',
    );
    expect(fetchMock.mock.calls[0]![1].method).toBe('POST');
  });
  it('sends a full-batch request without the currently selected film or append mode', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(async () => new Response(JSON.stringify({ data: {} })));
    vi.stubGlobal('fetch', fetchMock);
    await createEffectTemplateMixAiRun('project', 'parent-run', 9, 'template');
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1].body));
    expect(body).toMatchObject({ workflowRunId: 'parent-run', expectedRevision: 9 });
    expect(body).not.toHaveProperty('targetVariantId');
    expect(body).not.toHaveProperty('appendNewMaterials');
    expect(body).not.toHaveProperty('refreshAffectedSlots');
    await createEffectTemplateMixAiRun('project', 'parent-run', 9, 'template', 'film-1');
    expect(JSON.parse(String(fetchMock.mock.calls[1]![1].body))).toHaveProperty(
      'targetVariantId',
      'film-1',
    );
  });
  it('updates all affected projects using the existing scoped local output task', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(async () => new Response(JSON.stringify({ data: {} })));
    vi.stubGlobal('fetch', fetchMock);
    await loadMixFinalOutputRuns('project/1', 'run/1');
    expect(fetchMock.mock.calls[0]![0]).toContain(
      '/projects/project%2F1/workflows/effect/final-output?workflowRunId=run%2F1',
    );
    const body = {
      workflowRunId: 'run/1',
      templateId: 'template/1',
      expectedDraftRevision: 9,
      variantIds: ['film-2', 'film-4', 'film-5'],
    };
    await updateMixSourceProjects('project/1', body);
    expect(fetchMock.mock.calls[1]![0]).toContain('/final-output/source-update');
    expect(JSON.parse(String(fetchMock.mock.calls[1]![1].body))).toEqual(body);
    await getMixSourceUpdateRun('project/1', 'output/1');
    expect(fetchMock.mock.calls[2]![0]).toContain(
      '/projects/project%2F1/workflows/effect/final-output/output%2F1',
    );
  });
  it('scopes project deletion to the template and Run using the current draft revision', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: {} })));
    vi.stubGlobal('fetch', fetchMock);
    await deleteEffectTemplateMixVariant('p/1', 'current-run', 9, 't/1', 'v/1');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(
      '/api/projects/p%2F1/workflows/effect/template-mix/templates/t%2F1/variants/v%2F1/delete',
    );
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({
      workflowRunId: 'current-run',
      expectedRevision: 9,
    });
  });
  it('distinguishes same-branch append requests from a full fill and resumes the same task', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(async () => new Response(JSON.stringify({ data: {} })));
    vi.stubGlobal('fetch', fetchMock);
    await createEffectTemplateMixAiRun('p', 'current-run', 7, 't', undefined, false, true);
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1].body))).toMatchObject({
      workflowRunId: 'current-run',
      appendNewMaterials: true,
    });
    await resumeEffectTemplateMixAppend('p', 'append-id');
    expect(fetchMock.mock.calls[1]![0]).toBe(
      '/api/projects/p/workflows/effect/template-mix/ai-fill-runs/append-id/resume-append',
    );
    await createEffectTemplateMixAiRun('p', 'current-run', 7, 't');
    expect(JSON.parse(String(fetchMock.mock.calls[2]![1].body))).not.toHaveProperty(
      'appendNewMaterials',
    );
  });
  it.each([false, true])(
    'preserves the draft save envelope and keepalive with compact=%s',
    async (compact) => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            success: true,
            data: { draftRevision: 8 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );
      vi.stubGlobal('fetch', fetchMock);
      const draft = { schemaVersion: 1 as const, activeTemplateId: '', templates: [] };
      const result = compact
        ? await saveEffectTemplateMixDraft('project/1', 'run-1', 7, draft, true, true)
        : await saveEffectTemplateMixDraft('project/1', 'run-1', 7, draft, true);
      expect(result.data.draftRevision).toBe(8);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toContain('/projects/project%2F1/workflows/effect/template-mix/draft');
      expect(init.method).toBe('PUT');
      expect(init.keepalive).toBe(true);
      expect(JSON.parse(String(init.body))).toEqual({
        workflowRunId: 'run-1',
        expectedRevision: 7,
        draft,
        ...(compact ? { compactResponse: true } : {}),
      });
    },
  );

  it('creates an empty film project without starting an AI fill run', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true, data: {} }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await createEmptyEffectTemplateMixVariant('project/1', 'run-1', 7, 'template/1');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      '/api/projects/project%2F1/workflows/effect/template-mix/templates/template%2F1/empty-variants',
    );
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({
      workflowRunId: 'run-1',
      expectedRevision: 7,
    });
    expect(url).not.toContain('/ai-runs');
  });
});
