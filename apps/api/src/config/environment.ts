export type AppEnvironment = 'development' | 'test' | 'production';
export type StorageDriver = 'local' | 'minio';

export type EnvironmentVariables = {
  APP_ENV: AppEnvironment;
  API_PORT: number;
  WEB_ORIGIN: string;
  STORAGE_DRIVER: StorageDriver;
  LOCAL_STORAGE_ROOT: string | undefined;
  MAX_UPLOAD_BYTES: number;
  WORKING_FILE_CLEANUP_GRACE_HOURS: number;
  MINIO_ENDPOINT: string | undefined;
  MINIO_PORT: number;
  MINIO_USE_SSL: boolean;
  MINIO_BUCKET: string | undefined;
  MINIO_ACCESS_KEY: string | undefined;
  MINIO_SECRET_KEY: string | undefined;
  DATABASE_URL: string;
  REDIS_URL: string;
  RABBITMQ_URL: string;
  EFFECT_EXTRACTION_WORKER_TOKEN: string | undefined;
  EFFECT_PROMPT_WORKER_TOKEN: string | undefined;
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

const parsePort = (value: unknown, key: string, defaultValue: number): number => {
  const port = Number(value ?? defaultValue);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`环境变量 ${key} 必须是 1 到 65535 之间的整数`);
  }

  return port;
};

const parseStorageDriver = (value: unknown): StorageDriver => {
  const driver = value ?? 'local';
  if (driver !== 'local' && driver !== 'minio') {
    throw new Error('环境变量 STORAGE_DRIVER 必须是 local 或 minio');
  }
  return driver;
};

const parseBoolean = (value: unknown, key: string, defaultValue: boolean): boolean => {
  const normalized = String(value ?? defaultValue)
    .trim()
    .toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  throw new Error(`环境变量 ${key} 必须是 true 或 false`);
};

const parsePositiveInteger = (value: unknown, key: string, defaultValue: number): number => {
  const parsed = Number(value ?? defaultValue);

  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`环境变量 ${key} 必须是正整数`);
  }

  return parsed;
};

const parseEnvironment = (value: unknown): AppEnvironment => {
  const environment = value ?? 'development';

  if (environment !== 'development' && environment !== 'test' && environment !== 'production') {
    throw new Error('环境变量 APP_ENV 必须是 development、test 或 production');
  }

  return environment;
};

export const validateEnvironment = (raw: Record<string, unknown>): EnvironmentVariables => {
  const appEnvironment = parseEnvironment(raw.APP_ENV);
  const storageDriver = parseStorageDriver(raw.STORAGE_DRIVER);
  const minioEndpoint = optionalString(raw.MINIO_ENDPOINT);
  const minioBucket = optionalString(raw.MINIO_BUCKET);
  const minioAccessKey = optionalString(raw.MINIO_ACCESS_KEY);
  const minioSecretKey = optionalString(raw.MINIO_SECRET_KEY);

  if (storageDriver === 'minio') {
    requiredString(minioEndpoint, 'MINIO_ENDPOINT');
    requiredString(minioBucket, 'MINIO_BUCKET');
    requiredString(minioAccessKey, 'MINIO_ACCESS_KEY');
    requiredString(minioSecretKey, 'MINIO_SECRET_KEY');
  }

  const effectExtractionWorkerToken = optionalString(raw.EFFECT_EXTRACTION_WORKER_TOKEN);
  const effectPromptWorkerToken = optionalString(raw.EFFECT_PROMPT_WORKER_TOKEN);
  if (appEnvironment === 'production') {
    requiredString(effectExtractionWorkerToken, 'EFFECT_EXTRACTION_WORKER_TOKEN');
    requiredString(effectPromptWorkerToken, 'EFFECT_PROMPT_WORKER_TOKEN');
  }

  return {
    APP_ENV: appEnvironment,
    API_PORT: parsePort(raw.API_PORT, 'API_PORT', 3000),
    WEB_ORIGIN: requiredString(raw.WEB_ORIGIN ?? 'http://localhost:5173', 'WEB_ORIGIN'),
    STORAGE_DRIVER: storageDriver,
    LOCAL_STORAGE_ROOT: optionalString(raw.LOCAL_STORAGE_ROOT),
    MAX_UPLOAD_BYTES: parsePositiveInteger(
      raw.MAX_UPLOAD_BYTES,
      'MAX_UPLOAD_BYTES',
      512 * 1024 * 1024,
    ),
    WORKING_FILE_CLEANUP_GRACE_HOURS: parsePositiveInteger(
      raw.WORKING_FILE_CLEANUP_GRACE_HOURS,
      'WORKING_FILE_CLEANUP_GRACE_HOURS',
      24,
    ),
    MINIO_ENDPOINT: minioEndpoint,
    MINIO_PORT: parsePort(raw.MINIO_PORT, 'MINIO_PORT', 9000),
    MINIO_USE_SSL: parseBoolean(raw.MINIO_USE_SSL, 'MINIO_USE_SSL', false),
    MINIO_BUCKET: minioBucket,
    MINIO_ACCESS_KEY: minioAccessKey,
    MINIO_SECRET_KEY: minioSecretKey,
    DATABASE_URL: requiredString(raw.DATABASE_URL, 'DATABASE_URL'),
    REDIS_URL: requiredString(raw.REDIS_URL, 'REDIS_URL'),
    RABBITMQ_URL: requiredString(raw.RABBITMQ_URL, 'RABBITMQ_URL'),
    EFFECT_EXTRACTION_WORKER_TOKEN: effectExtractionWorkerToken,
    EFFECT_PROMPT_WORKER_TOKEN: effectPromptWorkerToken,
    TOS_ENDPOINT: optionalString(raw.TOS_ENDPOINT),
    TOS_REGION: optionalString(raw.TOS_REGION),
    TOS_BUCKET: optionalString(raw.TOS_BUCKET),
    TOS_ACCESS_KEY_ID: optionalString(raw.TOS_ACCESS_KEY_ID),
    TOS_SECRET_ACCESS_KEY: optionalString(raw.TOS_SECRET_ACCESS_KEY),
    SEEDANCE_BASE_URL: optionalString(raw.SEEDANCE_BASE_URL),
    SEEDANCE_API_KEY: optionalString(raw.SEEDANCE_API_KEY),
  };
};
