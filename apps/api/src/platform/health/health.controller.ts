import type { HealthData } from '@ai-marketing/contracts';
import { Controller, Get, Inject } from '@nestjs/common';

import { HealthService } from './health.service';

@Controller('health')
export class HealthController {
  constructor(@Inject(HealthService) private readonly healthService: HealthService) {}

  @Get()
  getHealth(): HealthData {
    return this.healthService.getHealth();
  }
}
