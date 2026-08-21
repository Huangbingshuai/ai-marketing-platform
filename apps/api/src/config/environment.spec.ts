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
});
