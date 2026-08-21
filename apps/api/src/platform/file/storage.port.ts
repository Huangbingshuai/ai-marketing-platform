import type { Readable } from 'node:stream';

export type StoragePutInput = {
  stream: Readable;
  sizeBytes: number;
};

export type StoredObject = {
  key: string;
  sizeBytes: number;
};

export type StorageRange = {
  start: number;
  end: number;
};

export type StoredStream = {
  stream: Readable;
  sizeBytes: number;
  start: number;
  end: number;
  contentLength: number;
};

export interface StoragePort {
  put(input: StoragePutInput): Promise<StoredObject>;
  open(key: string, range?: StorageRange): Promise<StoredStream>;
  delete(key: string): Promise<void>;
}

export const STORAGE_PORT = Symbol('StoragePort');
