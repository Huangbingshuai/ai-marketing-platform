import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type {
  StoragePort,
  StoragePutInput,
  StorageRange,
  StoredObject,
  StoredStream,
} from './storage.port';

export const DEFAULT_LOCAL_STORAGE_ROOT = resolve(__dirname, '../../../../../.local-storage');

export const resolveLocalStorageRoot = (configuredRoot?: string): string =>
  resolve(configuredRoot ?? DEFAULT_LOCAL_STORAGE_ROOT);

const assertInside = (root: string, target: string): void => {
  const pathFromRoot = relative(root, target);
  if (pathFromRoot === '..' || pathFromRoot.startsWith(`..\\`) || isAbsolute(pathFromRoot)) {
    throw new Error('Storage key resolves outside the configured root');
  }
};

@Injectable()
export class LocalStorageAdapter implements StoragePort {
  private readonly root: string;

  constructor(@Inject(ConfigService) config: ConfigService) {
    this.root = resolveLocalStorageRoot(config.get<string>('LOCAL_STORAGE_ROOT'));
  }

  private objectPath(key: string): string {
    const target = resolve(this.root, key);
    assertInside(this.root, target);
    return target;
  }

  async put(input: StoragePutInput): Promise<StoredObject> {
    const objectId = randomUUID();
    const key = `assets/${objectId.slice(0, 2)}/${objectId}`;
    const finalPath = this.objectPath(key);
    const temporaryPath = this.objectPath(`tmp/storage-${randomUUID()}.part`);

    await mkdir(resolve(finalPath, '..'), { recursive: true });
    await mkdir(resolve(temporaryPath, '..'), { recursive: true });

    try {
      await pipeline(input.stream, createWriteStream(temporaryPath, { flags: 'wx' }));
      const written = await stat(temporaryPath);
      if (!written.isFile() || written.size !== input.sizeBytes) {
        throw new Error('Stored file size does not match upload metadata');
      }
      await rename(temporaryPath, finalPath);
      return { key, sizeBytes: written.size };
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async open(key: string, range?: StorageRange): Promise<StoredStream> {
    const path = this.objectPath(key);
    const metadata = await stat(path);
    if (!metadata.isFile()) throw new Error('Stored object is not a regular file');

    const start = range?.start ?? 0;
    const end = range?.end ?? metadata.size - 1;
    if (start < 0 || end < start || end >= metadata.size) {
      throw new RangeError('Invalid storage range');
    }

    return {
      stream: createReadStream(path, { start, end }),
      sizeBytes: metadata.size,
      start,
      end,
      contentLength: end - start + 1,
    };
  }

  async delete(key: string): Promise<void> {
    await rm(this.objectPath(key), { force: true });
  }
}
