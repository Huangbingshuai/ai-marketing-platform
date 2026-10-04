import { randomUUID } from 'node:crypto';
import { Agent } from 'node:https';

import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Client } from 'minio';

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
import { tosS3Endpoint } from './tos-endpoint';

export type MinioClient = Pick<
  Client,
  | 'bucketExists'
  | 'makeBucket'
  | 'putObject'
  | 'statObject'
  | 'getObject'
  | 'getPartialObject'
  | 'removeObject'
  | 'presignedGetObject'
>;

export const MINIO_CLIENT = Symbol('MinioClient');

export const createMinioClient = (config: ConfigService): MinioClient | null => {
  if (config.get<string>('STORAGE_DRIVER') === 'tos') {
    const region = config.getOrThrow<string>('TOS_REGION').trim();
    return new Client({
      endPoint: tosS3Endpoint(config.getOrThrow<string>('TOS_ENDPOINT').trim(), region),
      region,
      port: 443,
      useSSL: true,
      pathStyle: false,
      accessKey: config.getOrThrow<string>('TOS_ACCESS_KEY_ID').trim(),
      secretKey: config.getOrThrow<string>('TOS_SECRET_ACCESS_KEY').trim(),
      transportAgent: new Agent({
        keepAlive: true,
        timeout: 120000,
        maxSockets: 32,
        maxFreeSockets: 32,
        maxVersion: 'TLSv1.2',
      }),
    });
  }
  if (config.get<string>('STORAGE_DRIVER') !== 'minio') return null;
  return new Client({
    endPoint: config.getOrThrow<string>('MINIO_ENDPOINT'),
    port: config.getOrThrow<number>('MINIO_PORT'),
    useSSL: config.getOrThrow<boolean>('MINIO_USE_SSL'),
    accessKey: config.getOrThrow<string>('MINIO_ACCESS_KEY'),
    secretKey: config.getOrThrow<string>('MINIO_SECRET_KEY'),
  });
};

@Injectable()
export class MinioStorageAdapter implements StoragePort, OnModuleInit {
  private readonly bucket: string | null;
  private readonly isTos: boolean;
  private initialization: Promise<void> | null = null;

  constructor(
    @Inject(ConfigService) config: ConfigService,
    @Inject(MINIO_CLIENT) private readonly client: MinioClient | null,
  ) {
    this.isTos = config.get<string>('STORAGE_DRIVER') === 'tos';
    this.bucket = this.isTos
      ? config.getOrThrow<string>('TOS_BUCKET').trim()
      : config.get<string>('STORAGE_DRIVER') === 'minio'
        ? config.getOrThrow<string>('MINIO_BUCKET')
        : null;
  }

  async onModuleInit(): Promise<void> {
    if (this.client) await this.ensureBucket();
  }

  private active(): { client: MinioClient; bucket: string } {
    if (!this.client || !this.bucket) throw new Error('S3 storage adapter is not configured');
    return { client: this.client, bucket: this.bucket };
  }

  private ensureBucket(): Promise<void> {
    if (!this.initialization) {
      this.initialization = (async () => {
        const { client, bucket } = this.active();
        if (!(await client.bucketExists(bucket))) {
          if (this.isTos) throw new Error('TOS 桶不存在或没有访问权限，请先创建并授权');
          await client.makeBucket(bucket);
        }
      })();
    }
    return this.initialization;
  }

  async put(input: StoragePutInput): Promise<StoredObject> {
    await this.ensureBucket();
    const { client, bucket } = this.active();
    const objectId = randomUUID();
    const key = buildStorageObjectKey(input, objectId);
    let uploaded = false;
    try {
      await client.putObject(bucket, key, input.stream, input.sizeBytes, {
        'Content-Type': input.contentType ?? 'application/octet-stream',
        'x-amz-meta-project-id': input.projectId,
      });
      uploaded = true;
      const metadata = await client.statObject(bucket, key);
      if (metadata.size !== input.sizeBytes) {
        throw new Error('Stored file size does not match upload metadata');
      }
      return { key, sizeBytes: metadata.size };
    } catch (error) {
      if (uploaded) await client.removeObject(bucket, key).catch(() => undefined);
      throw error;
    }
  }

  async putShared(input: SharedStoragePutInput): Promise<StoredObject> {
    await this.ensureBucket();
    const { client, bucket } = this.active();
    const key = buildSharedStorageObjectKey(input, randomUUID());
    let uploaded = false;
    try {
      await client.putObject(bucket, key, input.stream, input.sizeBytes, {
        'Content-Type': input.contentType ?? 'application/octet-stream',
        'x-amz-meta-collection': input.collection,
        'x-amz-meta-asset-id': input.assetId,
        'x-amz-meta-version': input.version,
      });
      uploaded = true;
      const metadata = await client.statObject(bucket, key);
      if (metadata.size !== input.sizeBytes)
        throw new Error('Stored file size does not match upload metadata');
      return { key, sizeBytes: metadata.size };
    } catch (error) {
      if (uploaded) await client.removeObject(bucket, key).catch(() => undefined);
      throw error;
    }
  }

  async open(key: string, range?: StorageRange): Promise<StoredStream> {
    await this.ensureBucket();
    const { client, bucket } = this.active();
    const metadata = await client.statObject(bucket, key);
    const start = range?.start ?? 0;
    const end = range?.end ?? metadata.size - 1;
    if (start < 0 || end < start || end >= metadata.size)
      throw new RangeError('Invalid storage range');
    const contentLength = end - start + 1;
    const stream = range
      ? await client.getPartialObject(bucket, key, start, contentLength)
      : await client.getObject(bucket, key);
    return { stream, sizeBytes: metadata.size, start, end, contentLength };
  }

  async delete(key: string): Promise<void> {
    await this.ensureBucket();
    const { client, bucket } = this.active();
    await client.removeObject(bucket, key);
  }

  async signedReadUrl(
    key: string,
    expiresSeconds: number,
    expectedSizeBytes: number,
  ): Promise<string | null> {
    // A local MinIO address must not be returned to an external provider.
    if (!this.isTos) return null;
    if (!Number.isInteger(expiresSeconds) || expiresSeconds < 1 || expiresSeconds > 3600)
      throw new RangeError('Invalid provider URL expiry');
    await this.ensureBucket();
    const { client, bucket } = this.active();
    const metadata = await client.statObject(bucket, key);
    if (metadata.size !== expectedSizeBytes)
      throw new Error('Provider reference file size mismatch');
    return client.presignedGetObject(bucket, key, expiresSeconds);
  }
}

export const selectStorageAdapter = (
  config: ConfigService,
  local: LocalStorageAdapter,
  minio: MinioStorageAdapter,
): StoragePort =>
  ['minio', 'tos'].includes(config.get<string>('STORAGE_DRIVER') ?? '') ? minio : local;
