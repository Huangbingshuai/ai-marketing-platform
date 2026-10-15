import { afterEach, describe, expect, it, vi } from 'vitest';

import { createProject, deleteProject, listProjects } from './project.api';

const project = {
  id: '5db5821d-10ac-4dc0-88d3-3cd33f48fc97',
  name: '夏季投放',
  description: null,
  status: 'ACTIVE',
  createdAt: '2026-08-20T02:00:00.000Z',
  updatedAt: '2026-08-20T02:00:00.000Z',
} as const;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('project API', () => {
  it('permanently deletes only the explicitly selected project', async () => {
    const result = {
      projectId: project.id,
      deleted: false,
      status: 'QUEUED',
      storageCleanup: 'PENDING',
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ success: true, data: result })));
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      deleteProject(project.id, { currentProjectId: 'other-project' }),
    ).resolves.toMatchObject({ data: result });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`/api/projects/${project.id}`);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: 'DELETE',
      body: JSON.stringify({ currentProjectId: 'other-project' }),
    });
  });

  it('preserves the server rejection message for an active project', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            success: false,
            message: '项目仍有生成或上传任务，请等待任务结束后再删除。',
          }),
          { status: 409 },
        ),
      ),
    );
    await expect(deleteProject(project.id)).rejects.toThrow('项目仍有生成或上传任务');
  });
  it('loads projects from the shared project endpoint', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ success: true, data: [project] })));
    vi.stubGlobal('fetch', fetchMock);

    await expect(listProjects()).resolves.toMatchObject({ data: [project] });
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/projects');
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: 'GET' });
  });

  it('serializes project library workflow and space filters', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ success: true, data: [project] })));
    vi.stubGlobal('fetch', fetchMock);

    await listProjects({ keyword: '夏季 投放', workflow: 'FISSION', space: 'FISSION_CLONE' });

    const url = new URL(String(fetchMock.mock.calls[0]?.[0]), 'http://test.local');
    expect(url.pathname).toBe('/api/projects');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      keyword: '夏季 投放',
      workflow: 'FISSION',
      space: 'FISSION_CLONE',
    });
  });

  it('posts a project payload as JSON', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ success: true, data: project })));
    vi.stubGlobal('fetch', fetchMock);

    await expect(createProject({ name: project.name })).resolves.toMatchObject({ data: project });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/projects');
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      body: JSON.stringify({ name: project.name }),
    });
  });

  it('uses the API error message when creation fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ success: false, data: null, message: '项目名称不能为空' }), {
          status: 400,
        }),
      ),
    );

    await expect(createProject({ name: '' })).rejects.toThrow('项目名称不能为空');
  });
});
