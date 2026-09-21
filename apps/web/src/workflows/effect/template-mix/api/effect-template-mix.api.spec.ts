import { afterEach, describe, expect, it, vi } from 'vitest';

import { createEmptyEffectTemplateMixVariant } from './effect-template-mix.api';

afterEach(() => vi.unstubAllGlobals());

describe('effect template mix API', () => {
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
