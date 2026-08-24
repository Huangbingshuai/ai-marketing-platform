import { afterEach, describe, expect, it, vi } from 'vitest';
import { listWorkingArtifacts, putWorkflowNodeState } from './workflow-working.api';

afterEach(() => vi.unstubAllGlobals());

const ok = (): Response =>
  new Response(JSON.stringify({ success: true, data: { items: [], total: 0 } }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

describe('workflow working API', () => {
  it('saves node state with the expected revision and keepalive option', async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok());
    vi.stubGlobal('fetch', fetchMock);

    await putWorkflowNodeState(
      'project/one',
      'run-one',
      'SOURCE_IMPORT',
      { expectedRevision: 3, state: { name: '产品 A' } },
      { keepalive: true },
    );

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain(
      '/projects/project%2Fone/workflow-runs/run-one/nodes/SOURCE_IMPORT/state',
    );
    expect(init.method).toBe('PUT');
    expect(init.keepalive).toBe(true);
    expect(JSON.parse(String(init.body))).toEqual({
      expectedRevision: 3,
      state: { name: '产品 A' },
    });
  });

  it('loads only working artifacts through the dedicated endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok());
    vi.stubGlobal('fetch', fetchMock);

    await listWorkingArtifacts('project-one', { workflow: 'EFFECT', space: 'EFFECT' });

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/projects/project-one/working-artifacts?');
    expect(url).toContain('workflow=EFFECT');
    expect(url).toContain('space=EFFECT');
    expect(url).not.toContain('/assets');
  });
});
