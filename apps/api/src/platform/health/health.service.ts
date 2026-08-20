import type { HealthData } from '@ai-marketing/contracts';
import { Injectable } from '@nestjs/common';

@Injectable()
export class HealthService {
  getHealth(): HealthData {
    return {
      service: 'api',
      status: 'ok',
      timestamp: new Date().toISOString(),
    };
  }
}
