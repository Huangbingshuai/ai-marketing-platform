import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';

import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TosClient } from '@volcengine/tos-sdk';

import type { LocalStorageAdapter } from './local-storage.adapter';
import type {
  SharedStoragePutInput,
  StoragePort,
  StoragePutInput,
  StorageRange,
  StoredObject,
  StoredStream,
} from './storage.port';
import { buildSharedStorageObjectKey, buildStorageObjectKey } from './storage-object-key';
import { tosEndpoint } from './tos-endpoint';

export type TosStorageClient = {
  [
    K in
      'headBucket' | 'putObject' | 'headObject' | 'getObjectV2' | 'deleteObject' | 'getPreSignedUrl'
  ]: OmitThisParameter<TosClient[K]>;
};
export const TOS_CLIENT = Symbol('TosClient');

export const createTosClient = (config: ConfigService): TosStorageClient | null => {
  if (config.get<string>('STORAGE_DRIVER') !== 'tos') return null;
  const region = config.getOrThrow<string>('TOS_REGION').trim();
  const client = new TosClient({
    endpoint: tosEndpoint(config.getOrThrow<string>('TOS_ENDPOINT').trim(), region),
    region,
    secure: true,
    enableVerifySSL: true,
    accessKeyId: config.getOrThrow<string>('TOS_ACCESS_KEY_ID').trim(),
    accessKeySecret: config.getOrThrow<string>('TOS_SECRET_ACCESS_KEY').trim(),
    requestTimeout: 120000,
    maxConnections: 32,
    maxRetryCount: 3,
  });
  // Object storage uses a direct regional connection. Axios's implicit HTTP proxy
  // conflicts with the SDK's HTTPS agent and must not inherit desktop proxy settings.
  client.axiosInst.defaults.proxy = false;
  return client;
};

@Injectable()
export class TosStorageAdapter implements StoragePort, OnModuleInit {
  private readonly bucket: string | null;
  private initialization: Promise<void> | null = null;

  constructor(
    @Inject(ConfigService) config: ConfigService,
    @Inject(TOS_CLIENT) private readonly client: TosStorageClient | null,
  ) {
    this.bucket =
      config.get<string>('STORAGE_DRIVER') === 'tos'
        ? config.getOrThrow<string>('TOS_BUCKET').trim()
        : null;
  }

  async onModuleInit(): Promise<void> {
    if (this.client) await this.ensureBucket();
  }

  private active(): { client: TosStorageClient; bucket: string } {
    if (!this.client || !this.bucket) throw new Error('TOS storage adapter is not configured');
    return { client: this.client, bucket: this.bucket };
  }

  private ensureBucket(): Promise<void> {
    if (!this.initialization) {
      this.initialization = (async () => {
        const { client, bucket } = this.active();
        try {
          await client.headBucket(bucket);
        } catch {
          // Do not include SDK request/config objects or signed headers in errors.
          throw new Error('TOS 桶不可访问，请检查桶、地域、权限和网络配置');
        }
      })();
    }
    return this.initialization;
  }

  private async size(key: string): Promise<number> {
    const { client, bucket } = this.active();
    const result = await this.request(() => client.headObject({ bucket, key }));
    const length = result.data['content-length'];
    if (!/^\d+$/u.test(length)) throw new Error('Invalid stored file size');
    const size = Number(length);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error('Invalid stored file size');
    return size;
  }

  private async request<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      // Network errors may contain Axios config, credentials and signed headers.
      // Keep only bounded diagnostic codes, never the SDK error as a cause.
      const detail = error as { code?: unknown; statusCode?: unknown } | null;
      const code =
        typeof detail?.code === 'string' && /^[A-Za-z0-9_]{1,64}$/u.test(detail.code)
          ? detail.code
          : 'StorageRequestFailed';
      const status = typeof detail?.statusCode === 'number' ? detail.statusCode : undefined;
      throw Object.assign(
        new Error(`TOS 对象请求失败：${code}${status ? ` (HTTP ${status})` : ''}`),
        { code, statusCode: status },
      );
    }
  }

  private async upload(
    key: string,
    input: StoragePutInput | SharedStoragePutInput,
    meta: Record<string, string>,
  ): Promise<StoredObject> {
    await this.ensureBucket();
    const { client, bucket } = this.active();
    let uploaded = false;
    try {
      await this.request(() =>
        client.putObject({
          bucket,
          key,
          body: input.stream,
          contentLength: input.sizeBytes,
          contentType: input.contentType ?? 'application/octet-stream',
          meta,
          forbidOverwrite: true,
        }),
      );
      uploaded = true;
      const sizeBytes = await this.size(key);
      if (sizeBytes !== input.sizeBytes)
        throw new Error('Stored file size does not match upload metadata');
      return { key, sizeBytes };
    } catch (error) {
      if (uploaded) await client.deleteObject({ bucket, key }).catch(() => undefined);
      throw error;
    }
  }

  put(input: StoragePutInput): Promise<StoredObject> {
    return this.upload(buildStorageObjectKey(input, randomUUID()), input, {
      'project-id': input.projectId,
    });
  }

  putShared(input: SharedStoragePutInput): Promise<StoredObject> {
    return this.upload(buildSharedStorageObjectKey(input, randomUUID()), input, {
      collection: input.collection,
      'asset-id': input.assetId,
      version: input.version,
    });
  }

  async open(key: string, range?: StorageRange): Promise<StoredStream> {
    await this.ensureBucket();
    const { client, bucket } = this.active();
    const sizeBytes = await this.size(key);
    const start = range?.start ?? 0;
    const end = range?.end ?? sizeBytes - 1;
    if (
      range &&
      (!Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start < 0 ||
        end < start ||
        end >= sizeBytes)
    )
      throw new RangeError('Invalid storage range');
    const result = await this.request(() =>
      client.getObjectV2({
        bucket,
        key,
        dataType: 'stream',
        ...(range ? { rangeStart: start, rangeEnd: end } : {}),
      }),
    );
    const content = result.data.content;
    const stream = content instanceof Readable ? content : new Readable().wrap(content);
    return { stream, sizeBytes, start, end, contentLength: sizeBytes === 0 ? 0 : end - start + 1 };
  }

  async delete(key: string): Promise<void> {
    await this.ensureBucket();
    const { client, bucket } = this.active();
    await this.request(() => client.deleteObject({ bucket, key }));
  }

  async signedReadUrl(
    key: string,
    expiresSeconds: number,
    expectedSizeBytes: number,
  ): Promise<string | null> {
    if (!this.bucket) return null;
    if (!Number.isInteger(expiresSeconds) || expiresSeconds < 1 || expiresSeconds > 3600)
      throw new RangeError('Invalid provider URL expiry');
    await this.ensureBucket();
    const { client, bucket } = this.active();
    if ((await this.size(key)) !== expectedSizeBytes)
      throw new Error('Provider reference file size mismatch');
    return client.getPreSignedUrl({ bucket, key, expires: expiresSeconds, method: 'GET' });
  }
}

export const selectStorageAdapter = (
  config: ConfigService,
  local: LocalStorageAdapter,
  tos: TosStorageAdapter,
): StoragePort => (config.get<string>('STORAGE_DRIVER') === 'tos' ? tos : local);
