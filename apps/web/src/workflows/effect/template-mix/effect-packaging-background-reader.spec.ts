import { describe, expect, it, vi } from 'vitest';
import { PackagingBackgroundReader } from './effect-packaging-background-reader';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('packaging background discovery', () => {
  it('merges initial, history and focus discovery while a read is pending', async () => {
    const reader = new PackagingBackgroundReader(),
      pending = deferred();
    const action = vi.fn(() => pending.promise);
    const first = reader.read(action);
    expect(reader.read(action)).toBe(first);
    expect(reader.read(action)).toBe(first);
    await Promise.resolve();
    expect(action).toHaveBeenCalledOnce();
    pending.resolve();
    await first;
    await reader.read(async () => {});
    expect(action).toHaveBeenCalledOnce();
  });
  it.each(['scope change', 'unmount', 'accepted task'])(
    'discards late discovery after %s',
    async () => {
      const reader = new PackagingBackgroundReader(),
        pending = deferred();
      const installed: string[] = [];
      let signal!: AbortSignal;
      const first = reader.read(async (s, current) => {
        signal = s;
        await pending.promise;
        if (current()) installed.push('old');
      });
      await Promise.resolve();
      reader.invalidate();
      expect(signal.aborted).toBe(true);
      await reader.read(async (_signal, current) => {
        if (current()) installed.push('new');
      });
      pending.resolve();
      await first;
      expect(installed).toEqual(['new']);
    },
  );
  it('releases a failed read and allows a new discovery', async () => {
    const reader = new PackagingBackgroundReader();
    await expect(
      reader.read(async () => {
        throw Error('offline');
      }),
    ).rejects.toThrow('offline');
    const fresh = vi.fn(async () => {});
    await reader.read(fresh);
    expect(fresh).toHaveBeenCalledOnce();
  });
  it('does not start an old scope that was invalidated before its microtask', async () => {
    const reader = new PackagingBackgroundReader();
    const action = vi.fn(async () => {});
    const pending = reader.read(action);
    reader.invalidate();
    await pending;
    expect(action).not.toHaveBeenCalled();
  });
});
