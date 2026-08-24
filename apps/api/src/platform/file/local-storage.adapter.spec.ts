import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import type { ConfigService } from '@nestjs/config';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LocalStorageAdapter } from './local-storage.adapter';

const keyContext = {
  projectName: '项目甲',
  workflow: 'EFFECT',
  lifecycle: 'assets' as const,
  productId: 'product-a',
  productName: '产品甲',
  category: '商品图片',
  originalFileName: '主图.png',
};

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
    const first = await adapter.put({
      projectId: 'project-a',
      stream: Readable.from('abcdef'),
      sizeBytes: 6,
      keyContext,
    });
    const second = await adapter.put({
      projectId: 'project-a',
      stream: Readable.from('abcdef'),
      sizeBytes: 6,
      keyContext,
    });

    expect(first.key).not.toBe(second.key);
    expect(first.key).toMatch(
      /^projects\/项目甲__project-\/effect\/02-assets\/产品甲__product-\/商品图片\/主图__[0-9a-f-]{36}\.png$/,
    );
    const opened = await adapter.open(first.key, { start: 1, end: 3 });
    await expect(readAll(opened.stream)).resolves.toBe('bcd');
    expect(opened).toMatchObject({ sizeBytes: 6, contentLength: 3, start: 1, end: 3 });
  });

  it('deletes objects and rejects path traversal', async () => {
    const stored = await adapter.put({
      projectId: 'project-a',
      stream: Readable.from('asset'),
      sizeBytes: 5,
      keyContext,
    });
    await adapter.delete(stored.key);
    await expect(adapter.open(stored.key)).rejects.toThrow();
    await expect(adapter.open('../outside')).rejects.toThrow('outside');
  });

  it('removes incomplete temporary files when the declared size is wrong', async () => {
    await expect(
      adapter.put({
        projectId: 'project-a',
        stream: Readable.from('short'),
        sizeBytes: 99,
        keyContext,
      }),
    ).rejects.toThrow('size');
  });
});
