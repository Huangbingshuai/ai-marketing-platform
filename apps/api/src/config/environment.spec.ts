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

  it('requires the extraction worker token in production', () => {
    expect(() => validateEnvironment({ ...validEnvironment, APP_ENV: 'production' })).toThrow(
      'EFFECT_EXTRACTION_WORKER_TOKEN',
    );

    expect(
      validateEnvironment({
        ...validEnvironment,
        APP_ENV: 'production',
        EFFECT_EXTRACTION_WORKER_TOKEN: 'production-worker-secret',
      }),
    ).toMatchObject({
      APP_ENV: 'production',
      EFFECT_EXTRACTION_WORKER_TOKEN: 'production-worker-secret',
    });
  });
});
