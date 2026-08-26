import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  addEffectPromptItem,
  deleteEffectPromptItem,
  getEffectPromptResult,
  updateEffectPromptItem,
  validateEffectPromptResult,
} from './effect-prompt-generation.api';

const ok = (data: unknown = {}): Response =>
  new Response(JSON.stringify({ success: true, data }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

afterEach(() => vi.unstubAllGlobals());

describe('effect prompt generation API', () => {
  it('encodes product pagination and the server-side query', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(ok()));
    vi.stubGlobal('fetch', fetchMock);
    await getEffectPromptResult(
      'project / 1',
      'workflow / 1',
      'product / 1',
      2,
      '家庭 场景',
      'HOOK',
    );
    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toContain(
      '/projects/project%20%2F%201/workflows/effect/prompt-generation/products/product%20%2F%201/result',
    );
    expect(url).toContain('page=2');
    expect(url).toContain('pageSize=10');
    expect(url).toContain('workflowRunId=workflow+%2F+1');
    expect(url).toContain('query=%E5%AE%B6%E5%BA%AD+%E5%9C%BA%E6%99%AF');
    expect(url).toContain('fragmentType=HOOK');
  });

  it('uses result CAS for edit, delete and validation mutations', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(ok()));
    vi.stubGlobal('fetch', fetchMock);
    const dimensions = {
      narrative: '痛点前置型',
      scene: '家庭',
      persona: '都市白领',
      sellingPoint: '锁鲜',
      camera: '慢推近景',
      emotion: '温馨治愈',
    };

    await addEffectPromptItem('project-1', 'result-1', {
      content: 'Prompt',
      fragmentType: 'HOOK',
      materialTags: ['首帧'],
      dimensions,
      expectedRevision: 7,
    });
    await updateEffectPromptItem('project-1', 'result-1', 'item-1', {
      content: 'Prompt',
      fragmentType: 'HOOK',
      materialTags: ['首帧'],
      dimensions,
      expectedRevision: 8,
    });
    await deleteEffectPromptItem('project-1', 'result-1', 'item-1', 9);
    await validateEffectPromptResult('project-1', 'result-1', { expectedRevision: 10 });

    expect((fetchMock.mock.calls[0]![1] as RequestInit).headers).toMatchObject({ 'If-Match': '7' });
    expect((fetchMock.mock.calls[1]![1] as RequestInit).headers).toMatchObject({ 'If-Match': '8' });
    expect((fetchMock.mock.calls[2]![1] as RequestInit).method).toBe('DELETE');
    expect((fetchMock.mock.calls[2]![1] as RequestInit).headers).toMatchObject({ 'If-Match': '9' });
    expect((fetchMock.mock.calls[3]![1] as RequestInit).headers).toMatchObject({
      'If-Match': '10',
    });
  });
});
