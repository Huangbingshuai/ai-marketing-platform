import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MulterModule } from '@nestjs/platform-express';

import { LocalStorageAdapter, resolveLocalStorageRoot } from './local-storage.adapter';
import {
  createMinioClient,
  MINIO_CLIENT,
  MinioStorageAdapter,
  selectStorageAdapter,
} from './minio-storage.adapter';
import { STORAGE_PORT } from './storage.port';
import { UploadTemporaryFileCleanupInterceptor } from './upload-temporary-file-cleanup.interceptor';

@Module({
  imports: [
    MulterModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const temporaryRoot = resolve(
          resolveLocalStorageRoot(config.get<string>('LOCAL_STORAGE_ROOT')),
          'tmp',
        );
        mkdirSync(temporaryRoot, { recursive: true });
        return {
          dest: temporaryRoot,
          limits: { fileSize: config.getOrThrow<number>('MAX_UPLOAD_BYTES'), files: 20 },
        };
      },
    }),
  ],
  providers: [
    LocalStorageAdapter,
    MinioStorageAdapter,
    {
      provide: MINIO_CLIENT,
      inject: [ConfigService],
      useFactory: createMinioClient,
    },
    UploadTemporaryFileCleanupInterceptor,
    {
      provide: STORAGE_PORT,
      inject: [ConfigService, LocalStorageAdapter, MinioStorageAdapter],
      useFactory: selectStorageAdapter,
    },
  ],
  exports: [MulterModule, STORAGE_PORT, UploadTemporaryFileCleanupInterceptor],
})
export class FileModule {}
