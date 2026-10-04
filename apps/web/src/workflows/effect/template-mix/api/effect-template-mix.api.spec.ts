import { afterEach, describe, expect, it, vi } from 'vitest';

import { createEmptyEffectTemplateMixVariant, saveEffectTemplateMixDraft } from './effect-template-mix.api';

afterEach(() => vi.unstubAllGlobals());

describe('effect template mix API', () => {
  it.each([false, true])('preserves the draft save envelope and keepalive with compact=%s', async (compact) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      success: true, data: { draftRevision: 8 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
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
      workflowRunId: 'run-1', expectedRevision: 7, draft,
      ...(compact ? { compactResponse: true } : {}),
    });
  });

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
