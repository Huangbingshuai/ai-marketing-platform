import { Readable } from 'node:stream';

import type { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';

import type { LocalStorageAdapter } from './local-storage.adapter';
import {
  TosStorageAdapter,
  createTosClient,
  selectStorageAdapter,
  type TosStorageClient,
} from './tos-storage.adapter';
import { tosEndpoint } from './tos-endpoint';

const keyContext = {
  projectName: '项目甲',
  workflow: 'EFFECT',
  lifecycle: 'assets' as const,
  productId: 'product-a',
  productName: '产品甲',
  category: '商品图片',
  originalFileName: '主图.png',
};
const config = (driver: 'local' | 'tos' = 'tos') =>
  ({
    get: (key: string) => ({ STORAGE_DRIVER: driver })[key],
    getOrThrow: (key: string) =>
      ({
        TOS_BUCKET: 'private-tos-assets',
        TOS_ENDPOINT: 'tos-cn-beijing.volces.com',
        TOS_REGION: 'cn-beijing',
        TOS_ACCESS_KEY_ID: 'fake-access',
        TOS_SECRET_ACCESS_KEY: 'fake-secret',
      })[key],
  }) as unknown as ConfigService;
const client = (overrides: Partial<TosStorageClient> = {}) =>
  ({
    headBucket: vi.fn().mockResolvedValue({ data: {} }),
    putObject: vi.fn().mockResolvedValue({ data: {} }),
    headObject: vi.fn().mockResolvedValue({ data: { 'content-length': '6' } }),
    getObjectV2: vi.fn().mockImplementation(async (input: { rangeStart?: number }) => ({
      data: { content: Readable.from(input.rangeStart !== undefined ? 'bcd' : 'abcdef') },
    })),
    deleteObject: vi.fn().mockResolvedValue({ data: {} }),
    getPreSignedUrl: vi
      .fn()
      .mockReturnValue('https://private-assets.example.test/file?signed=fixture'),
    ...overrides,
  }) as unknown as TosStorageClient;
const readAll = async (stream: Readable) => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks).toString('utf8');
};
const upload = {
  projectId: 'project-a',
  stream: Readable.from('abcdef'),
  sizeBytes: 6,
  keyContext,
};

describe('TosStorageAdapter', () => {
  it('normalizes native and historical S3 endpoints for the official HTTPS SDK', () => {
    expect(tosEndpoint('tos-cn-beijing.volces.com', 'cn-beijing')).toBe(
      'tos-cn-beijing.volces.com',
    );
    expect(tosEndpoint('https://tos-s3-cn-beijing.volces.com/', 'cn-beijing')).toBe(
      'tos-cn-beijing.volces.com',
    );
    for (const endpoint of [
      'http://tos-cn-beijing.volces.com',
      'https://tos-cn-shanghai.volces.com',
      'https://user:pass@tos-cn-beijing.volces.com',
      'https://tos-cn-beijing.volces.com/path',
      'https://tos-cn-beijing.volces.com?query=1',
    ]) {
      expect(() => tosEndpoint(endpoint, 'cn-beijing')).toThrow('TOS_ENDPOINT');
    }
    expect(createTosClient(config('local'))).toBeNull();
    const sdk = createTosClient(config('tos')) as unknown as {
      opts: object;
      axiosInst: { defaults: object };
    };
    expect(sdk.opts).toMatchObject({
      endpoint: 'tos-cn-beijing.volces.com',
      region: 'cn-beijing',
      secure: true,
      enableVerifySSL: true,
    });
    expect(sdk.axiosInst.defaults).toMatchObject({ proxy: false });
  });

  it('checks the existing bucket once and never creates a cloud resource', async () => {
    const tos = client();
    const adapter = new TosStorageAdapter(config(), tos);
    await Promise.all([adapter.onModuleInit(), adapter.put(upload)]);
    expect(tos.headBucket).toHaveBeenCalledExactlyOnceWith('private-tos-assets');
    const broken = new TosStorageAdapter(
      config(),
      client({ headBucket: vi.fn().mockRejectedValue(new Error('sensitive config')) }),
    );
    await expect(broken.onModuleInit()).rejects.toThrow('TOS 桶不可访问');
  });

  it('uploads scoped objects with private metadata and verifies stored size', async () => {
    const tos = client();
    const adapter = new TosStorageAdapter(config(), tos);
    const stored = await adapter.put({ ...upload, contentType: 'image/png' });
    expect(stored.key).toMatch(
      /^projects\/项目甲__project-\/effect\/02-assets\/产品甲__product-\/商品图片\/主图__[0-9a-f-]{36}\.png$/,
    );
    expect(tos.putObject).toHaveBeenCalledWith({
      bucket: 'private-tos-assets',
      key: stored.key,
      body: expect.any(Readable),
      contentLength: 6,
      contentType: 'image/png',
      meta: { 'project-id': 'project-a' },
      forbidOverwrite: true,
    });
    expect(stored.sizeBytes).toBe(6);
  });

  it('removes only its own successfully uploaded object if size verification fails', async () => {
    const tos = client({
      headObject: vi.fn().mockResolvedValue({ data: { 'content-length': '5' } }),
    });
    await expect(new TosStorageAdapter(config(), tos).put(upload)).rejects.toThrow('size');
    expect(tos.deleteObject).toHaveBeenCalledWith({
      bucket: 'private-tos-assets',
      key: expect.stringMatching(/^projects\//),
    });
    const rejected = client({ putObject: vi.fn().mockRejectedValue(new Error('upload rejected')) });
    await expect(new TosStorageAdapter(config(), rejected).put(upload)).rejects.toThrow(
      'StorageRequestFailed',
    );
    expect(rejected.deleteObject).not.toHaveBeenCalled();
  });

  it('uploads shared voice samples without project ownership', async () => {
    const tos = client();
    const stored = await new TosStorageAdapter(config(), tos).putShared({
      collection: 'effect-voices',
      assetId: 'vivi',
      version: 'seed-tts-2.0-1',
      extension: 'wav',
      stream: Readable.from('abcdef'),
      sizeBytes: 6,
      contentType: 'audio/wav',
    });
    expect(stored.key).toMatch(/^shared\/effect-voices\/vivi\/seed-tts-2.0-1\//);
    expect(tos.putObject).toHaveBeenCalledWith(
      expect.objectContaining({
        meta: { collection: 'effect-voices', 'asset-id': 'vivi', version: 'seed-tts-2.0-1' },
        contentType: 'audio/wav',
      }),
    );
  });

  it('supports streaming full and inclusive range reads with strict bounds', async () => {
    const tos = client();
    const adapter = new TosStorageAdapter(config(), tos);
    const full = await adapter.open('assets/object');
    expect(await readAll(full.stream)).toBe('abcdef');
    expect(full.contentLength).toBe(6);
    const partial = await adapter.open('assets/object', { start: 1, end: 3 });
    expect(await readAll(partial.stream)).toBe('bcd');
    expect(partial).toMatchObject({ sizeBytes: 6, start: 1, end: 3, contentLength: 3 });
    expect(tos.getObjectV2).toHaveBeenCalledWith({
      bucket: 'private-tos-assets',
      key: 'assets/object',
      dataType: 'stream',
      rangeStart: 1,
      rangeEnd: 3,
    });
    for (const range of [
      { start: -1, end: 1 },
      { start: 1, end: 0 },
      { start: 6, end: 6 },
      { start: 0.5, end: 2 },
      { start: 0, end: NaN },
    ]) {
      await expect(adapter.open('assets/object', range)).rejects.toThrow('range');
    }
    expect(tos.getObjectV2).toHaveBeenCalledTimes(2);
  });

  it('accepts zero-length full reads and rejects malformed object sizes', async () => {
    const empty = client({
      headObject: vi.fn().mockResolvedValue({ data: { 'content-length': '0' } }),
      getObjectV2: vi.fn().mockResolvedValue({ data: { content: Readable.from([]) } }),
    });
    const result = await new TosStorageAdapter(config(), empty).open('empty');
    expect(result.contentLength).toBe(0);
    expect(await readAll(result.stream)).toBe('');
    for (const size of ['bad', '-1', '1.5', '9007199254740992']) {
      const bad = client({
        headObject: vi.fn().mockResolvedValue({ data: { 'content-length': size } }),
      });
      await expect(new TosStorageAdapter(config(), bad).open('file')).rejects.toThrow('size');
    }
  });

  it('returns short provider URLs only after frozen file size verification', async () => {
    const tos = client();
    const adapter = new TosStorageAdapter(config(), tos);
    await expect(adapter.signedReadUrl('assets/file', 1800, 6)).resolves.toContain('https://');
    expect(tos.getPreSignedUrl).toHaveBeenCalledExactlyOnceWith({
      bucket: 'private-tos-assets',
      key: 'assets/file',
      expires: 1800,
      method: 'GET',
    });
    await expect(adapter.signedReadUrl('assets/file', 1800, 7)).rejects.toThrow('size');
    for (const expires of [0, -1, 3601, 1.5])
      await expect(adapter.signedReadUrl('file', expires, 6)).rejects.toThrow('expiry');
    await expect(
      new TosStorageAdapter(config('local'), null).signedReadUrl('file', 1800, 6),
    ).resolves.toBeNull();
  });

  it('deletes through the native SDK and preserves local adapter selection', async () => {
    const tos = client();
    const adapter = new TosStorageAdapter(config(), tos);
    await adapter.delete('assets/object');
    expect(tos.deleteObject).toHaveBeenCalledWith({
      bucket: 'private-tos-assets',
      key: 'assets/object',
    });
    const local = {} as LocalStorageAdapter;
    expect(selectStorageAdapter(config('tos'), local, adapter)).toBe(adapter);
    expect(selectStorageAdapter(config('local'), local, adapter)).toBe(local);
  });

  it('never exposes SDK network configuration or signing secrets through errors', async () => {
    const raw = Object.assign(new Error('Authorization=secret https://signed-url'), {
      code: 'ECONNRESET',
      config: { headers: { Authorization: 'secret' } },
      request: { signedUrl: 'secret' },
    });
    const tos = client({ headObject: vi.fn().mockRejectedValue(raw) });
    try {
      await new TosStorageAdapter(config(), tos).open('file');
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({ code: 'ECONNRESET' });
      expect(String(error)).not.toContain('secret');
      expect(error).not.toHaveProperty('config');
      expect(error).not.toHaveProperty('request');
      expect(error).not.toHaveProperty('cause');
    }
  });
});
