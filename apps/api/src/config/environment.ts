export type AppEnvironment = 'development' | 'test' | 'production';

export type EnvironmentVariables = {
  APP_ENV: AppEnvironment;
  API_PORT: number;
  WEB_ORIGIN: string;
  DATABASE_URL: string;
  REDIS_URL: string;
  RABBITMQ_URL: string;
  TOS_ENDPOINT: string | undefined;
  TOS_REGION: string | undefined;
  TOS_BUCKET: string | undefined;
  TOS_ACCESS_KEY_ID: string | undefined;
  TOS_SECRET_ACCESS_KEY: string | undefined;
  SEEDANCE_BASE_URL: string | undefined;
  SEEDANCE_API_KEY: string | undefined;
};

const requiredString = (value: unknown, key: string): string => {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`环境变量 ${key} 未配置`);
  }

  return value;
};

const optionalString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value : undefined;

const parsePort = (value: unknown): number => {
  const port = Number(value ?? 3000);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('环境变量 API_PORT 必须是 1 到 65535 之间的整数');
  }

  return port;
};

const parseEnvironment = (value: unknown): AppEnvironment => {
  const environment = value ?? 'development';

  if (environment !== 'development' && environment !== 'test' && environment !== 'production') {
    throw new Error('环境变量 APP_ENV 必须是 development、test 或 production');
  }

  return environment;
};

export const validateEnvironment = (raw: Record<string, unknown>): EnvironmentVariables => ({
  APP_ENV: parseEnvironment(raw.APP_ENV),
  API_PORT: parsePort(raw.API_PORT),
  WEB_ORIGIN: requiredString(raw.WEB_ORIGIN ?? 'http://localhost:5173', 'WEB_ORIGIN'),
  DATABASE_URL: requiredString(raw.DATABASE_URL, 'DATABASE_URL'),
  REDIS_URL: requiredString(raw.REDIS_URL, 'REDIS_URL'),
  RABBITMQ_URL: requiredString(raw.RABBITMQ_URL, 'RABBITMQ_URL'),
  TOS_ENDPOINT: optionalString(raw.TOS_ENDPOINT),
  TOS_REGION: optionalString(raw.TOS_REGION),
  TOS_BUCKET: optionalString(raw.TOS_BUCKET),
  TOS_ACCESS_KEY_ID: optionalString(raw.TOS_ACCESS_KEY_ID),
  TOS_SECRET_ACCESS_KEY: optionalString(raw.TOS_SECRET_ACCESS_KEY),
  SEEDANCE_BASE_URL: optionalString(raw.SEEDANCE_BASE_URL),
  SEEDANCE_API_KEY: optionalString(raw.SEEDANCE_API_KEY),
});
