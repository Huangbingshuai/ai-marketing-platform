import { describe, expect, it, vi } from 'vitest';
import type { ExtractionNodeDetail } from '@ai-marketing/contracts';
import { createLiveNodeDetail, type DetailSelection } from './live-node-detail';

const selection: DetailSelection = {
  projectId: 'p',
  workflowRunId: 'r',
  taskId: 't',
  nodeId: 'SEMANTIC_REFINEMENT',
};
const detail = (summary: string) => ({ summary }) as ExtractionNodeDetail;
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const setup = (
  load: (s: DetailSelection, signal: AbortSignal) => Promise<ExtractionNodeDetail>,
) => {
  const callbacks = { load, reset: vi.fn(), loading: vi.fn(), publish: vi.fn(), error: vi.fn() };
  return { ...callbacks, live: createLiveNodeDetail(callbacks) };
};

describe('customized live workflow details', () => {
  it('quietly refreshes on task updates and coalesces a final update arriving during a query', async () => {
    const pending = deferred<ExtractionNodeDetail>();
    const load = vi
      .fn()
      .mockResolvedValueOnce(detail('原文审校'))
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(detail('处理完成'));
    const state = setup(load);
    await state.live.select(selection);
    const query = state.live.refresh('t');
    await state.live.refresh('t');
    await state.live.refresh('t');
    expect(load).toHaveBeenCalledTimes(2);
    expect(state.reset).toHaveBeenCalledTimes(1);
    expect(state.loading.mock.calls.filter(([value]) => value)).toHaveLength(1);
    pending.resolve(detail('最终核对'));
    await query;
    await Promise.resolve();
    expect(load).toHaveBeenCalledTimes(3);
    expect(state.publish.mock.calls.map(([d]) => d.summary)).toEqual([
      '原文审校',
      '最终核对',
      '处理完成',
    ]);
  });
  it.each(['close', 'project', 'run', 'task', 'node'])(
    'rejects late data after %s changes',
    async (change) => {
      const pending = deferred<ExtractionNodeDetail>();
      const load = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(detail('新详情'));
      const state = setup(load);
      const old = state.live.select(selection);
      const signal = load.mock.calls[0]![1] as AbortSignal;
      if (change === 'close') state.live.cancel();
      else
        await state.live.select({
          ...selection,
          [{ project: 'projectId', run: 'workflowRunId', task: 'taskId', node: 'nodeId' }[change]!]:
            'new',
        });
      pending.resolve(detail('迟到旧详情'));
      await old;
      expect(signal.aborted).toBe(true);
      expect(state.publish.mock.calls.some(([d]) => d.summary === '迟到旧详情')).toBe(false);
      await state.live.refresh('another-task');
      expect(load).toHaveBeenCalledTimes(change === 'close' ? 1 : 2);
    },
  );
  it('keeps existing detail on a network error and can recover without marking the task failed', async () => {
    const load = vi
      .fn()
      .mockResolvedValueOnce(detail('已完成一份文档'))
      .mockRejectedValueOnce(new TypeError('offline'))
      .mockResolvedValueOnce(detail('最终核对'));
    const state = setup(load);
    await state.live.select(selection);
    await state.live.refresh('t');
    expect(state.reset).toHaveBeenCalledTimes(1);
    expect(state.error).toHaveBeenCalledOnce();
    expect(state.publish).toHaveBeenCalledTimes(1);
    await state.live.refresh('t');
    expect(state.publish).toHaveBeenLastCalledWith(detail('最终核对'));
  });
});
