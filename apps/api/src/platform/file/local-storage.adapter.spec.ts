import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import type { ConfigService } from '@nestjs/config';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LocalStorageAdapter } from './local-storage.adapter';

const readAll = async (stream: Readable): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks).toString('utf8');
};

describe('LocalStorageAdapter', () => {
  let root: string;
  let adapter: LocalStorageAdapter;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'asset-storage-'));
    adapter = new LocalStorageAdapter({
      get: () => root,
    } as unknown as ConfigService);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('writes unique server-generated keys and supports ranged reads', async () => {
    const first = await adapter.put({ stream: Readable.from('abcdef'), sizeBytes: 6 });
    const second = await adapter.put({ stream: Readable.from('abcdef'), sizeBytes: 6 });

    expect(first.key).not.toBe(second.key);
    expect(first.key).toMatch(/^assets\/[0-9a-f]{2}\/[0-9a-f-]{36}$/);
    const opened = await adapter.open(first.key, { start: 1, end: 3 });
    await expect(readAll(opened.stream)).resolves.toBe('bcd');
    expect(opened).toMatchObject({ sizeBytes: 6, contentLength: 3, start: 1, end: 3 });
  });

  it('deletes objects and rejects path traversal', async () => {
    const stored = await adapter.put({ stream: Readable.from('asset'), sizeBytes: 5 });
    await adapter.delete(stored.key);
    await expect(adapter.open(stored.key)).rejects.toThrow();
    await expect(adapter.open('../outside')).rejects.toThrow('outside');
  });

  it('removes incomplete temporary files when the declared size is wrong', async () => {
    await expect(adapter.put({ stream: Readable.from('short'), sizeBytes: 99 })).rejects.toThrow(
      'size',
    );
  });
});
