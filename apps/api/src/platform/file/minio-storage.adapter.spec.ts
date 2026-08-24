import { Readable } from 'node:stream';

import type { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';

import type { LocalStorageAdapter } from './local-storage.adapter';
import {
  MinioStorageAdapter,
  selectStorageAdapter,
  type MinioClient,
} from './minio-storage.adapter';

const keyContext = {
  projectName: '项目甲',
  workflow: 'EFFECT',
  lifecycle: 'assets' as const,
  productId: 'product-a',
  productName: '产品甲',
  category: '商品图片',
  originalFileName: '主图.png',
};

const config = (driver: 'local' | 'minio' = 'minio') =>
  ({
    get: (key: string) => ({ STORAGE_DRIVER: driver, MINIO_BUCKET: 'ai-marketing-assets' })[key],
    getOrThrow: (key: string) =>
      ({ STORAGE_DRIVER: driver, MINIO_BUCKET: 'ai-marketing-assets' })[key],
  }) as unknown as ConfigService;

const client = (overrides: Partial<MinioClient> = {}) =>
  ({
    bucketExists: vi.fn().mockResolvedValue(true),
    makeBucket: vi.fn().mockResolvedValue(undefined),
    putObject: vi.fn().mockResolvedValue({ etag: 'etag', versionId: null }),
    statObject: vi.fn().mockResolvedValue({ size: 6 }),
    getObject: vi.fn().mockResolvedValue(Readable.from('abcdef')),
    getPartialObject: vi.fn().mockResolvedValue(Readable.from('bcd')),
    removeObject: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }) as unknown as MinioClient;

const readAll = async (stream: Readable): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks).toString('utf8');
};

describe('MinioStorageAdapter', () => {
  it('creates a missing bucket during initialization', async () => {
    const minio = client({ bucketExists: vi.fn().mockResolvedValue(false) });
    const adapter = new MinioStorageAdapter(config(), minio);

    await adapter.onModuleInit();

    expect(minio.makeBucket).toHaveBeenCalledWith('ai-marketing-assets');
  });

  it('uploads project-scoped objects and verifies the stored size', async () => {
    const minio = client();
    const adapter = new MinioStorageAdapter(config(), minio);

    const stored = await adapter.put({
      projectId: 'project-a',
      stream: Readable.from('abcdef'),
      sizeBytes: 6,
      contentType: 'image/png',
      keyContext,
    });

    expect(stored.key).toMatch(
      /^projects\/项目甲__project-\/effect\/02-assets\/产品甲__product-\/商品图片\/主图__[0-9a-f-]{36}\.png$/,
    );
    expect(minio.putObject).toHaveBeenCalledWith(
      'ai-marketing-assets',
      stored.key,
      expect.any(Readable),
      6,
      expect.objectContaining({
        'Content-Type': 'image/png',
        'x-amz-meta-project-id': 'project-a',
      }),
    );
  });

  it('removes the uploaded object when post-upload size verification fails', async () => {
    const minio = client({ statObject: vi.fn().mockResolvedValue({ size: 5 }) });
    const adapter = new MinioStorageAdapter(config(), minio);

    await expect(
      adapter.put({
        projectId: 'project-a',
        stream: Readable.from('abcdef'),
        sizeBytes: 6,
        keyContext,
      }),
    ).rejects.toThrow('size');
    expect(minio.removeObject).toHaveBeenCalledWith(
      'ai-marketing-assets',
      expect.stringMatching(/^projects\/项目甲__project-\/effect\/02-assets\//),
    );
  });

  it('supports complete and ranged reads with strict bounds', async () => {
    const minio = client();
    const adapter = new MinioStorageAdapter(config(), minio);

    const complete = await adapter.open('assets/object');
    await expect(readAll(complete.stream)).resolves.toBe('abcdef');
    const partial = await adapter.open('assets/object', { start: 1, end: 3 });
    await expect(readAll(partial.stream)).resolves.toBe('bcd');
    expect(minio.getPartialObject).toHaveBeenCalledWith(
      'ai-marketing-assets',
      'assets/object',
      1,
      3,
    );
    await expect(adapter.open('assets/object', { start: 6, end: 6 })).rejects.toThrow('range');
  });

  it('deletes objects and selects the configured adapter', async () => {
    const minio = client();
    const minioAdapter = new MinioStorageAdapter(config(), minio);
    const localAdapter = {} as LocalStorageAdapter;

    await minioAdapter.delete('assets/object');

    expect(minio.removeObject).toHaveBeenCalledWith('ai-marketing-assets', 'assets/object');
    expect(selectStorageAdapter(config('minio'), localAdapter, minioAdapter)).toBe(minioAdapter);
    expect(selectStorageAdapter(config('local'), localAdapter, minioAdapter)).toBe(localAdapter);
  });
});
