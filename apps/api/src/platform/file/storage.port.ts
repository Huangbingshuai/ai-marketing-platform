import type { Readable } from 'node:stream';

export type StoragePutInput = {
  projectId: string;
  stream: Readable;
  sizeBytes: number;
  contentType?: string;
  keyContext: {
    projectName: string;
    workflow: string;
    lifecycle: 'staging' | 'assets' | 'manifest';
    productId?: string;
    productName?: string;
    category: string;
    originalFileName: string;
  };
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
