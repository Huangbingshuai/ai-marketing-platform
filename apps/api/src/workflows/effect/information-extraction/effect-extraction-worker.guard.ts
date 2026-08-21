import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { safeTokenEquals } from './effect-extraction.validation';

@Injectable()
export class EffectExtractionWorkerGuard implements CanActivate {
  constructor(@Inject(ConfigService) private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const expected = this.config.get<string>('EFFECT_EXTRACTION_WORKER_TOKEN')?.trim();
    const request = context.switchToHttp().getRequest<{ headers: Record<string, unknown> }>();
    const actual = request.headers['x-worker-token'];
    if (!expected || typeof actual !== 'string' || !safeTokenEquals(actual, expected))
      throw new UnauthorizedException('Worker token 无效');
    return true;
  }
}
