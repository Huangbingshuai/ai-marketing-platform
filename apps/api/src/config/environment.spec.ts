import { describe, expect, it } from 'vitest';

import { validateEnvironment } from './environment';

const validEnvironment = {
  DATABASE_URL: 'postgresql://localhost/test',
  REDIS_URL: 'redis://localhost:6379',
  RABBITMQ_URL: 'amqp://localhost:5672',
};

describe('validateEnvironment', () => {
  it('applies safe local defaults', () => {
    expect(validateEnvironment(validEnvironment)).toMatchObject({
      APP_ENV: 'development',
      API_PORT: 3000,
      WEB_ORIGIN: 'http://localhost:5173',
      MAX_UPLOAD_BYTES: 512 * 1024 * 1024,
    });
  });

  it('rejects an invalid upload size', () => {
    expect(() => validateEnvironment({ ...validEnvironment, MAX_UPLOAD_BYTES: '0' })).toThrow(
      'MAX_UPLOAD_BYTES',
    );
  });

  it('rejects an invalid API port', () => {
    expect(() => validateEnvironment({ ...validEnvironment, API_PORT: '70000' })).toThrow(
      'API_PORT',
    );
  });

  it('requires MinIO credentials only when the MinIO driver is selected', () => {
    expect(() => validateEnvironment({ ...validEnvironment, STORAGE_DRIVER: 'minio' })).toThrow(
      'MINIO_ENDPOINT',
    );

    expect(
      validateEnvironment({
        ...validEnvironment,
        STORAGE_DRIVER: 'minio',
        MINIO_ENDPOINT: 'localhost',
        MINIO_PORT: '9000',
        MINIO_USE_SSL: 'false',
        MINIO_BUCKET: 'ai-marketing-assets',
        MINIO_ACCESS_KEY: 'local-access',
        MINIO_SECRET_KEY: 'local-secret',
      }),
    ).toMatchObject({
      STORAGE_DRIVER: 'minio',
      MINIO_ENDPOINT: 'localhost',
      MINIO_PORT: 9000,
      MINIO_USE_SSL: false,
      MINIO_BUCKET: 'ai-marketing-assets',
    });
  });

  it('rejects invalid storage driver and MinIO boolean values', () => {
    expect(() => validateEnvironment({ ...validEnvironment, STORAGE_DRIVER: 's3' })).toThrow(
      'STORAGE_DRIVER',
    );
    expect(() =>
      validateEnvironment({
        ...validEnvironment,
        STORAGE_DRIVER: 'minio',
        MINIO_ENDPOINT: 'localhost',
        MINIO_USE_SSL: 'yes',
        MINIO_BUCKET: 'bucket',
        MINIO_ACCESS_KEY: 'access',
        MINIO_SECRET_KEY: 'secret',
      }),
    ).toThrow('MINIO_USE_SSL');
    expect(() =>
      validateEnvironment({
        ...validEnvironment,
        STORAGE_DRIVER: 'minio',
        MINIO_ENDPOINT: 'localhost',
        MINIO_PORT: '70000',
        MINIO_BUCKET: 'bucket',
        MINIO_ACCESS_KEY: 'access',
        MINIO_SECRET_KEY: 'secret',
      }),
    ).toThrow('MINIO_PORT');
  });

  it('requires dedicated extraction and prompt worker tokens in production', () => {
    expect(() => validateEnvironment({ ...validEnvironment, APP_ENV: 'production' })).toThrow(
      'EFFECT_EXTRACTION_WORKER_TOKEN',
    );

    expect(() =>
      validateEnvironment({
        ...validEnvironment,
        APP_ENV: 'production',
        EFFECT_EXTRACTION_WORKER_TOKEN: 'production-worker-secret',
      }),
    ).toThrow('EFFECT_PROMPT_WORKER_TOKEN');

    expect(
      validateEnvironment({
        ...validEnvironment,
        APP_ENV: 'production',
        EFFECT_EXTRACTION_WORKER_TOKEN: 'production-worker-secret',
        EFFECT_PROMPT_WORKER_TOKEN: 'production-prompt-worker-secret',
      }),
    ).toMatchObject({
      APP_ENV: 'production',
      EFFECT_EXTRACTION_WORKER_TOKEN: 'production-worker-secret',
      EFFECT_PROMPT_WORKER_TOKEN: 'production-prompt-worker-secret',
    });
  });

  it('aligns local worker token defaults with Docker Compose', () => {
    expect(validateEnvironment(validEnvironment)).toMatchObject({
      EFFECT_EXTRACTION_WORKER_TOKEN: 'local-effect-extraction-worker-token',
      EFFECT_PROMPT_WORKER_TOKEN: 'local-effect-prompt-worker-token',
    });
  });
});
