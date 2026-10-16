import { AuthAccess } from '../auth/auth-access.decorator';
import type { HealthData } from '@ai-marketing/contracts';
import { Controller, Get, Inject } from '@nestjs/common';

import { HealthService } from './health.service';

@AuthAccess('public')
@Controller('health')
export class HealthController {
  constructor(@Inject(HealthService) private readonly healthService: HealthService) {}

  @Get()
  getHealth(): HealthData {
    return this.healthService.getHealth();
  }
}
