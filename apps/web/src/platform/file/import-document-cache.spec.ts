import { afterEach, describe, expect, it, vi } from 'vitest';
import { ImportDocumentCache } from './import-document-cache';
afterEach(() => vi.useRealTimers());
describe('parsed imported document reuse', () => {
  it('skips download and parsing for unchanged text, including empty text', async () => {
    const cache = new ImportDocumentCache();
    const load = vi.fn().mockResolvedValue('');
    const signal = new AbortController().signal;
    await cache.read('/project/a/doc', 'v1', 'DOCX', signal, load);
    await cache.read('/project/a/doc', 'v1', 'DOCX', signal, load);
    expect(load).toHaveBeenCalledTimes(1);
    await cache.read('/project/a/doc', 'v2', 'DOCX', signal, load);
    await cache.read('/project/b/doc', 'v1', 'DOCX', signal, load);
    await cache.read('/project/a/doc', 'v1', 'TEXT', signal, load);
    expect(load).toHaveBeenCalledTimes(4);
  });
  it('expires and respects memory budget and missing versions', async () => {
    vi.useFakeTimers();
    const cache = new ImportDocumentCache(8, 1000);
    const load = vi.fn().mockResolvedValue('text');
    const signal = new AbortController().signal;
    await cache.read('/a', '1', 'DOCX', signal, load);
    await cache.read('/b', '1', 'DOCX', signal, load);
    await cache.read('/a', '1', 'DOCX', signal, load);
    expect(load).toHaveBeenCalledTimes(3);
    vi.advanceTimersByTime(1001);
    await cache.read('/a', '1', 'DOCX', signal, load);
    expect(load).toHaveBeenCalledTimes(4);
    await cache.read('/a', undefined, 'DOCX', signal, load);
    await cache.read('/a', undefined, 'DOCX', signal, load);
    expect(load).toHaveBeenCalledTimes(6);
  });
  it('never retains failed, canceled or oversized parses', async () => {
    const cache = new ImportDocumentCache();
    const controller = new AbortController();
    const bad = vi.fn().mockRejectedValue(new Error('bad parse'));
    await expect(cache.read('/a', '1', 'DOCX', controller.signal, bad)).rejects.toThrow();
    const cancelled = vi.fn(async () => {
      controller.abort();
      return 'old';
    });
    await expect(cache.read('/a', '1', 'DOCX', controller.signal, cancelled)).rejects.toThrow();
    const load = vi.fn().mockResolvedValue('new');
    expect(await cache.read('/a', '1', 'DOCX', new AbortController().signal, load)).toBe('new');
    const tooLarge = vi.fn().mockResolvedValue('x'.repeat(1_000_001));
    await expect(
      cache.read('/big', '1', 'DOCX', new AbortController().signal, tooLarge),
    ).rejects.toThrow('文档正文过大');
  });
});
