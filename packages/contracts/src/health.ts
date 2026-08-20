export type HealthStatus = 'ok';

export type HealthData = {
  service: 'api';
  status: HealthStatus;
  timestamp: string;
};
