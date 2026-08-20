import { afterEach, describe, expect, it, vi } from 'vitest';

import { createProject } from './project.api';

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
