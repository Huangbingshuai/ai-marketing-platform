import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  activateEffectWorkflowBranch,
  activateWorkflowNode,
  beginEffectNodeEdit,
  cancelEffectNodeEdit,
  getActiveWorkflowRunOverview,
  getEffectWorkflowBranchTree,
  listWorkingArtifacts,
  publishEffectNodeEdit,
  putWorkflowNodeState,
} from './workflow-working.api';

afterEach(() => vi.unstubAllGlobals());

const ok = (): Response =>
  new Response(JSON.stringify({ success: true, data: { items: [], total: 0 } }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

describe('workflow working API', () => {
  it('starts, cancels and publishes node edits within one project and Run', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => ok());
    vi.stubGlobal('fetch', fetchMock);

    await beginEffectNodeEdit('project/one', 'run/one', 'PROMPT_GENERATION');
    await cancelEffectNodeEdit('project/one', 'run/one', 'PROMPT_GENERATION');
    await publishEffectNodeEdit('project/one', 'run/one', 'PROMPT_GENERATION');

    const urls = fetchMock.mock.calls.map(([url]) => String(url));
    expect(urls[0]).toContain('/projects/project%2Fone/workflow-runs/effect/branches/run%2Fone/nodes/PROMPT_GENERATION/edit');
    expect(urls[1]).toBe(`${urls[0]}/cancel`);
    expect(urls[2]).toBe(`${urls[0]}/publish`);
    expect(fetchMock.mock.calls.every(([, init]) => (init as RequestInit).method === 'POST')).toBe(true);
  });
  it('loads and activates effect branches through project-scoped routes', async () => {
    const fetchMock = vi.fn().mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            success: true,
            data: { projectId: 'project/one', activeWorkflowRunId: null, branches: [] },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await getEffectWorkflowBranchTree('project/one');
    await activateEffectWorkflowBranch('project/one', 'run/one');

    expect(fetchMock.mock.calls[0]?.[0]).toContain(
      '/projects/project%2Fone/workflow-runs/effect/branches',
    );
    expect(fetchMock.mock.calls[1]?.[0]).toContain(
      '/projects/project%2Fone/workflow-runs/effect/branches/run%2Fone/activate',
    );
    expect((fetchMock.mock.calls[1]?.[1] as RequestInit).method).toBe('POST');
  });
  it('restores real revisions from authoritative artifacts when an older branch endpoint omits them', async () => {
    const branch = {
      workflowRunId: 'run-a',
      parentWorkflowRunId: null,
      forkNodeId: null,
      forkTemplateId: null,
      label: '主干',
      currentNodeId: 'PROMPT_GENERATION',
      createdAt: '2026-09-28T00:00:00Z',
      isActive: true,
      templates: [],
      nodes: [
        { nodeId: 'SOURCE_IMPORT', status: 'CONFIRMED', artifactCount: 2 },
        { nodeId: 'PROMPT_GENERATION', status: 'CONFIRMED', artifactCount: 1 },
      ],
    };
    const fetchMock = vi.fn().mockImplementation(
      async (url: string) =>
        new Response(
          JSON.stringify({
            success: true,
            data: url.includes('working-artifacts')
              ? {
                  items: [
                    {
                      artifactKey: 'source-package:a',
                      revision: 1,
                      createdAt: '2026-09-12T00:00:00Z',
                    },
                    {
                      artifactKey: 'prompt-batch:a',
                      revision: 3,
                      createdAt: '2026-09-13T00:00:00Z',
                    },
                  ],
                  total: 2,
                }
              : { projectId: 'project-a', activeWorkflowRunId: 'run-a', branches: [branch] },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await getEffectWorkflowBranchTree('project-a');

    expect(result.data.branches[0]?.nodes[0]).toMatchObject({
      revision: 1,
      revisions: [1],
      artifactCreatedAt: '2026-09-12T00:00:00.000Z',
    });
    expect(result.data.branches[0]?.nodes[1]).toMatchObject({
      revision: 3,
      revisions: [3],
      artifactCreatedAt: '2026-09-13T00:00:00.000Z',
    });
    expect(fetchMock.mock.calls[1]?.[0]).toContain('workflowRunId=run-a');
  });
  it('activates the visible node without writing a node draft', async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok());
    vi.stubGlobal('fetch', fetchMock);

    await activateWorkflowNode('project/one', 'run-one', 'INFORMATION_EXTRACTION');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain(
      '/projects/project%2Fone/workflow-runs/run-one/nodes/INFORMATION_EXTRACTION/activate',
    );
    expect(init.method).toBe('POST');
    expect(init.body).toBeUndefined();
  });

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

  it('loads the active run overview with an explicit workflow and space', async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok());
    vi.stubGlobal('fetch', fetchMock);

    await getActiveWorkflowRunOverview('project-one', 'EFFECT', 'EFFECT');

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/projects/project-one/workflow-runs/active/overview?');
    expect(url).toContain('workflow=EFFECT');
    expect(url).toContain('space=EFFECT');
  });
});
