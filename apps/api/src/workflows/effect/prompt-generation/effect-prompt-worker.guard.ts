import { timingSafeEqual } from 'node:crypto';

import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const safeEquals = (left: string, right: string): boolean => {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};

@Injectable()
export class EffectPromptWorkerGuard implements CanActivate {
  constructor(@Inject(ConfigService) private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const expected = this.config.get<string>('EFFECT_PROMPT_WORKER_TOKEN')?.trim();
    const request = context.switchToHttp().getRequest<{ headers: Record<string, unknown> }>();
    const actual = request.headers['x-worker-token'];
    if (!expected || typeof actual !== 'string' || !safeEquals(actual, expected))
      throw new UnauthorizedException('Worker token 无效');
    return true;
  }
}
