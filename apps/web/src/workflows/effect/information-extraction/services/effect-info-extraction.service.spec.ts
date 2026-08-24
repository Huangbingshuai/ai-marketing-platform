import type { EffectExtractionRun } from '@ai-marketing/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { pollEffectExtractionRun } from './effect-info-extraction.service';

const run = (status: EffectExtractionRun['status'], progress: number): EffectExtractionRun => ({
  id: 'run-1',
  projectId: 'project-1',
  draftId: 'draft-1',
  productId: 'product-1',
  status,
  progress,
  currentNode: status === 'RUNNING' ? '文档解析' : null,
  warnings: [],
  errorMessage: null,
  extractResultId: status === 'COMPLETED' ? 'result-1' : null,
  nodes: [],
  createdAt: '2026-08-21T00:00:00.000Z',
  updatedAt: '2026-08-21T00:00:01.000Z',
});

const response = (value: EffectExtractionRun): Response =>
  new Response(JSON.stringify({ success: true, data: { run: value } }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('effect info extraction polling service', () => {
  it('reports progress until the run reaches a terminal status', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(run('RUNNING', 35)))
      .mockResolvedValueOnce(response(run('COMPLETED', 100)));
    vi.stubGlobal('fetch', fetchMock);
    const updates: number[] = [];

    const polling = pollEffectExtractionRun('project-1', 'run-1', {
      intervalMs: 100,
      onUpdate: (value) => updates.push(value.progress),
    });
    await vi.advanceTimersByTimeAsync(100);

    await expect(polling).resolves.toMatchObject({ status: 'COMPLETED', progress: 100 });
    expect(updates).toEqual([35, 100]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('cancels the delay and stops polling when its signal is aborted', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(run('RUNNING', 20))));
    const controller = new AbortController();
    const polling = pollEffectExtractionRun('project-1', 'run-1', {
      intervalMs: 5_000,
      signal: controller.signal,
    });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();

    await expect(polling).rejects.toMatchObject({ name: 'AbortError' });
  });
});
