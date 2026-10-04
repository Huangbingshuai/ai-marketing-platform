import { Readable } from 'node:stream';

import type { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';

import type { LocalStorageAdapter } from './local-storage.adapter';
import {
  MinioStorageAdapter,
  createMinioClient,
  selectStorageAdapter,
  type MinioClient,
} from './minio-storage.adapter';
import { tosS3Endpoint } from './tos-endpoint';

const keyContext = {
  projectName: '项目甲',
  workflow: 'EFFECT',
  lifecycle: 'assets' as const,
  productId: 'product-a',
  productName: '产品甲',
  category: '商品图片',
  originalFileName: '主图.png',
};

const config = (driver: 'local' | 'minio' | 'tos' = 'minio') =>
  ({
    get: (key: string) =>
      ({
        STORAGE_DRIVER: driver,
        MINIO_BUCKET: 'ai-marketing-assets',
        TOS_BUCKET: 'private-tos-assets',
      })[key],
    getOrThrow: (key: string) =>
      ({
        STORAGE_DRIVER: driver,
        MINIO_BUCKET: 'ai-marketing-assets',
        TOS_BUCKET: 'private-tos-assets',
        TOS_ENDPOINT: 'tos-cn-beijing.volces.com',
        TOS_REGION: 'cn-beijing',
        TOS_ACCESS_KEY_ID: 'fake-access',
        TOS_SECRET_ACCESS_KEY: 'fake-secret',
      })[key],
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
    presignedGetObject: vi
      .fn()
      .mockResolvedValue('https://private-assets.example.test/file?signed=fixture'),
    ...overrides,
  }) as unknown as MinioClient;

const readAll = async (stream: Readable): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks).toString('utf8');
};

describe('MinioStorageAdapter', () => {
  it('normalizes TOS endpoints and creates an HTTPS regional S3 client without sending requests', () => {
    expect(tosS3Endpoint('tos-cn-beijing.volces.com', 'cn-beijing')).toBe(
      'tos-s3-cn-beijing.volces.com',
    );
    expect(tosS3Endpoint('https://tos-s3-cn-beijing.volces.com/', 'cn-beijing')).toBe(
      'tos-s3-cn-beijing.volces.com',
    );
    expect(createMinioClient(config('local'))).toBeNull();
    expect(createMinioClient(config('tos'))).toMatchObject({
      host: 'tos-s3-cn-beijing.volces.com',
      port: 443,
      protocol: 'https:',
      region: 'cn-beijing',
      pathStyle: false,
    });
  });

  it('requires an existing TOS bucket instead of silently creating a cloud resource', async () => {
    const tos = client({ bucketExists: vi.fn().mockResolvedValue(false) });
    const adapter = new MinioStorageAdapter(config('tos'), tos);
    await expect(adapter.onModuleInit()).rejects.toThrow('TOS');
    expect(tos.makeBucket).not.toHaveBeenCalled();
  });

  it('selects TOS and provides short private URLs only for size-verified provider files', async () => {
    const tos = client();
    const adapter = new MinioStorageAdapter(config('tos'), tos);
    expect(selectStorageAdapter(config('tos'), {} as LocalStorageAdapter, adapter)).toBe(adapter);
    const stored = await adapter.put({
      projectId: 'project-a',
      stream: Readable.from('abcdef'),
      sizeBytes: 6,
      keyContext,
    });
    expect(tos.putObject).toHaveBeenCalledWith(
      'private-tos-assets',
      stored.key,
      expect.any(Readable),
      6,
      expect.any(Object),
    );
    const partial = await adapter.open(stored.key, { start: 1, end: 3 });
    expect(await readAll(partial.stream)).toBe('bcd');
    await expect(adapter.signedReadUrl(stored.key, 1800, 6)).resolves.toContain('https://');
    expect(tos.presignedGetObject).toHaveBeenCalledWith('private-tos-assets', stored.key, 1800);
    await expect(adapter.signedReadUrl(stored.key, 1800, 7)).rejects.toThrow('size');
    for (const expires of [0, -1, 3601, 1.5])
      await expect(adapter.signedReadUrl(stored.key, expires, 6)).rejects.toThrow('expiry');
    expect(tos.presignedGetObject).toHaveBeenCalledTimes(1);
    await expect(
      new MinioStorageAdapter(config(), tos).signedReadUrl(stored.key, 1800, 6),
    ).resolves.toBeNull();
  });
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

  it('writes shared samples without attaching project ownership metadata', async () => {
    const minio = client();
    const adapter = new MinioStorageAdapter(config(), minio);
    const stored = await adapter.putShared({
      collection: 'effect-voices',
      assetId: 'vivi',
      version: 'seed-tts-2.0-1',
      extension: 'wav',
      stream: Readable.from('abcdef'),
      sizeBytes: 6,
      contentType: 'audio/wav',
    });
    expect(stored.key).toMatch(/^shared\/effect-voices\/vivi\/seed-tts-2.0-1\//);
    expect(minio.putObject).toHaveBeenCalledWith(
      'ai-marketing-assets',
      stored.key,
      expect.any(Readable),
      6,
      expect.objectContaining({
        'Content-Type': 'audio/wav',
        'x-amz-meta-asset-id': 'vivi',
      }),
    );
    expect(vi.mocked(minio.putObject).mock.calls[0]?.[4]).not.toHaveProperty(
      'x-amz-meta-project-id',
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
