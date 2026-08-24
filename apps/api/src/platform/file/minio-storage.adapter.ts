import { randomUUID } from 'node:crypto';

import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Client } from 'minio';

import type { LocalStorageAdapter } from './local-storage.adapter';
import type {
  StoragePort,
  StoragePutInput,
  StorageRange,
  StoredObject,
  StoredStream,
} from './storage.port';
import { buildStorageObjectKey } from './storage-object-key';

export type MinioClient = Pick<
  Client,
  | 'bucketExists'
  | 'makeBucket'
  | 'putObject'
  | 'statObject'
  | 'getObject'
  | 'getPartialObject'
  | 'removeObject'
>;

export const MINIO_CLIENT = Symbol('MinioClient');

export const createMinioClient = (config: ConfigService): MinioClient | null => {
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
  private initialization: Promise<void> | null = null;

  constructor(
    @Inject(ConfigService) config: ConfigService,
    @Inject(MINIO_CLIENT) private readonly client: MinioClient | null,
  ) {
    this.bucket =
      config.get<string>('STORAGE_DRIVER') === 'minio'
        ? config.getOrThrow<string>('MINIO_BUCKET')
        : null;
  }

  async onModuleInit(): Promise<void> {
    if (this.client) await this.ensureBucket();
  }

  private active(): { client: MinioClient; bucket: string } {
    if (!this.client || !this.bucket) throw new Error('MinIO storage adapter is not configured');
    return { client: this.client, bucket: this.bucket };
  }

  private ensureBucket(): Promise<void> {
    if (!this.initialization) {
      this.initialization = (async () => {
        const { client, bucket } = this.active();
        if (!(await client.bucketExists(bucket))) await client.makeBucket(bucket);
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
}

export const selectStorageAdapter = (
  config: ConfigService,
  local: LocalStorageAdapter,
  minio: MinioStorageAdapter,
): StoragePort => (config.get<string>('STORAGE_DRIVER') === 'minio' ? minio : local);
