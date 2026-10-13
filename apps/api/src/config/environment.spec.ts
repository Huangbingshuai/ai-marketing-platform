import { describe, expect, it } from 'vitest';

import { validateEnvironment } from './environment';

const validEnvironment = {
  DATABASE_URL: 'postgresql://localhost/test',
  REDIS_URL: 'redis://localhost:6379',
  RABBITMQ_URL: 'amqp://localhost:5672',
};

describe('validateEnvironment', () => {
  it('keeps the asset worker credential independent', () => {
    expect(
      validateEnvironment({
        ...validEnvironment,
        CUSTOMIZED_ASSETS_WORKER_TOKEN: 'assets-test-token',
        CUSTOMIZED_PRODUCTION_WORKER_TOKEN: 'video-test-token',
      }),
    ).toMatchObject({
      CUSTOMIZED_ASSETS_WORKER_TOKEN: 'assets-test-token',
      CUSTOMIZED_PRODUCTION_WORKER_TOKEN: 'video-test-token',
    });
  });
  it('keeps the independent production worker credential available to its guard', () => {
    expect(
      validateEnvironment({
        ...validEnvironment,
        CUSTOMIZED_PRODUCTION_WORKER_TOKEN: 'production-test-token',
      }).CUSTOMIZED_PRODUCTION_WORKER_TOKEN,
    ).toBe('production-test-token');
  });
  it('validates bounded cache options and supports a no-cache rollback', () => {
    expect(validateEnvironment(validEnvironment)).toMatchObject({
      EFFECT_READ_CACHE_ENABLED: true,
      EFFECT_READ_CACHE_LOG_METRICS: false,
      EFFECT_READ_CACHE_TIMEOUT_MS: 150,
      EFFECT_READ_CACHE_TTL_SECONDS: 1800,
      EFFECT_READ_CACHE_MAX_BYTES: 2097152,
      EFFECT_READ_CACHE_MIN_LOAD_MS: 0,
    });
    expect(
      validateEnvironment({ ...validEnvironment, EFFECT_READ_CACHE_ENABLED: 'false' })
        .EFFECT_READ_CACHE_ENABLED,
    ).toBe(false);
    for (const key of [
      'EFFECT_READ_CACHE_TIMEOUT_MS',
      'EFFECT_READ_CACHE_TTL_SECONDS',
      'EFFECT_READ_CACHE_MAX_BYTES',
    ])
      expect(() => validateEnvironment({ ...validEnvironment, [key]: '0' })).toThrow(key);
    expect(() =>
      validateEnvironment({ ...validEnvironment, EFFECT_READ_CACHE_ENABLED: 'maybe' }),
    ).toThrow('EFFECT_READ_CACHE_ENABLED');
    expect(
      validateEnvironment({ ...validEnvironment, EFFECT_READ_CACHE_MIN_LOAD_MS: '0' })
        .EFFECT_READ_CACHE_MIN_LOAD_MS,
    ).toBe(0);
    for (const invalid of ['-1', '1.5', 'invalid'])
      expect(() =>
        validateEnvironment({ ...validEnvironment, EFFECT_READ_CACHE_MIN_LOAD_MS: invalid }),
      ).toThrow('EFFECT_READ_CACHE_MIN_LOAD_MS');
  });
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

  it('rejects retired MinIO and other unsupported storage drivers', () => {
    expect(() => validateEnvironment({ ...validEnvironment, STORAGE_DRIVER: 's3' })).toThrow(
      'STORAGE_DRIVER',
    );
    expect(() => validateEnvironment({ ...validEnvironment, STORAGE_DRIVER: 'minio' })).toThrow(
      'STORAGE_DRIVER',
    );
  });

  it('requires TOS credentials and rejects non-regional or insecure endpoints', () => {
    const tos = {
      ...validEnvironment,
      STORAGE_DRIVER: 'tos',
      TOS_ENDPOINT: 'tos-cn-beijing.volces.com',
      TOS_REGION: 'cn-beijing',
      TOS_BUCKET: 'private-assets',
      TOS_ACCESS_KEY_ID: 'test-access',
      TOS_SECRET_ACCESS_KEY: 'test-secret',
    };
    expect(validateEnvironment(tos)).toMatchObject({
      STORAGE_DRIVER: 'tos',
      TOS_REGION: 'cn-beijing',
    });
    for (const key of [
      'TOS_ENDPOINT',
      'TOS_REGION',
      'TOS_BUCKET',
      'TOS_ACCESS_KEY_ID',
      'TOS_SECRET_ACCESS_KEY',
    ])
      expect(() => validateEnvironment({ ...tos, [key]: '' })).toThrow(key);
    for (const endpoint of [
      'http://tos-cn-beijing.volces.com',
      'localhost:9000',
      'https://tos-cn-guangzhou.volces.com',
      'https://tos-cn-beijing.volces.com/path',
      'https://tos-cn-beijing.volces.com?secret=bad',
      'https://user@tos-cn-beijing.volces.com',
    ])
      expect(() => validateEnvironment({ ...tos, TOS_ENDPOINT: endpoint })).toThrow();
    expect(
      validateEnvironment({ ...tos, TOS_ENDPOINT: 'https://tos-s3-cn-beijing.volces.com' })
        .STORAGE_DRIVER,
    ).toBe('tos');
  });

  it('requires dedicated workflow worker tokens in production', () => {
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

    expect(() =>
      validateEnvironment({
        ...validEnvironment,
        APP_ENV: 'production',
        EFFECT_EXTRACTION_WORKER_TOKEN: 'production-worker-secret',
        EFFECT_PROMPT_WORKER_TOKEN: 'production-prompt-worker-secret',
      }),
    ).toThrow('EFFECT_SEGMENT_RENDER_WORKER_TOKEN');

    expect(() =>
      validateEnvironment({
        ...validEnvironment,
        APP_ENV: 'production',
        EFFECT_EXTRACTION_WORKER_TOKEN: 'production-worker-secret',
        EFFECT_PROMPT_WORKER_TOKEN: 'production-prompt-worker-secret',
        EFFECT_SEGMENT_RENDER_WORKER_TOKEN: 'production-render-worker-secret',
      }),
    ).toThrow('EFFECT_TEMPLATE_MIX_WORKER_TOKEN');

    expect(
      validateEnvironment({
        ...validEnvironment,
        APP_ENV: 'production',
        EFFECT_EXTRACTION_WORKER_TOKEN: 'production-worker-secret',
        EFFECT_PROMPT_WORKER_TOKEN: 'production-prompt-worker-secret',
        EFFECT_SEGMENT_RENDER_WORKER_TOKEN: 'production-render-worker-secret',
        EFFECT_TEMPLATE_MIX_WORKER_TOKEN: 'production-template-mix-worker-secret',
      }),
    ).toMatchObject({
      APP_ENV: 'production',
      EFFECT_EXTRACTION_WORKER_TOKEN: 'production-worker-secret',
      EFFECT_PROMPT_WORKER_TOKEN: 'production-prompt-worker-secret',
      EFFECT_SEGMENT_RENDER_WORKER_TOKEN: 'production-render-worker-secret',
      EFFECT_TEMPLATE_MIX_WORKER_TOKEN: 'production-template-mix-worker-secret',
    });
  });

  it('aligns local worker token defaults with Docker Compose', () => {
    expect(validateEnvironment(validEnvironment)).toMatchObject({
      EFFECT_EXTRACTION_WORKER_TOKEN: 'local-effect-extraction-worker-token',
      EFFECT_PROMPT_WORKER_TOKEN: 'local-effect-prompt-worker-token',
      EFFECT_SEGMENT_RENDER_WORKER_TOKEN: 'local-effect-segment-render-worker-token',
      EFFECT_TEMPLATE_MIX_WORKER_TOKEN: 'local-effect-template-mix-worker-token',
    });
  });

  it('preserves a dedicated customized extraction token without inheriting effect credentials', () => {
    expect(
      validateEnvironment({
        ...validEnvironment,
        CUSTOMIZED_EXTRACTION_WORKER_TOKEN: 'customized-test-token',
        EFFECT_EXTRACTION_WORKER_TOKEN: 'effect-test-token',
      }),
    ).toMatchObject({
      CUSTOMIZED_EXTRACTION_WORKER_TOKEN: 'customized-test-token',
      EFFECT_EXTRACTION_WORKER_TOKEN: 'effect-test-token',
    });
    for (const token of [undefined, '', '   ']) {
      expect(
        validateEnvironment({
          ...validEnvironment,
          CUSTOMIZED_EXTRACTION_WORKER_TOKEN: token,
          EFFECT_EXTRACTION_WORKER_TOKEN: 'effect-test-token',
        }).CUSTOMIZED_EXTRACTION_WORKER_TOKEN,
      ).toBeUndefined();
    }
  });

  it('validates the optional reference-video signing secret', () => {
    expect(() =>
      validateEnvironment({
        ...validEnvironment,
        SEEDANCE_REFERENCE_SIGNING_SECRET: 'too-short',
      }),
    ).toThrow('SEEDANCE_REFERENCE_SIGNING_SECRET');

    expect(
      validateEnvironment({
        ...validEnvironment,
        SEEDANCE_REFERENCE_PUBLIC_BASE_URL: 'https://api.example.test/api',
        SEEDANCE_REFERENCE_SIGNING_SECRET: 'a-secure-signing-secret-with-32-characters',
      }),
    ).toMatchObject({
      SEEDANCE_REFERENCE_PUBLIC_BASE_URL: 'https://api.example.test/api',
      SEEDANCE_REFERENCE_SIGNING_SECRET: 'a-secure-signing-secret-with-32-characters',
    });
  });
});
