import type { ApiResponse, HealthData } from '@ai-marketing/contracts';

import { getJson } from '../../../api/http-client';

export const fetchHealth = (): Promise<ApiResponse<HealthData>> =>
  getJson<ApiResponse<HealthData>>('/health', '健康检查');
