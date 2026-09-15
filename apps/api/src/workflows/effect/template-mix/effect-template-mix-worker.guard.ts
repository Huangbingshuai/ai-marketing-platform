import { timingSafeEqual } from 'node:crypto';
import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class EffectTemplateMixWorkerGuard implements CanActivate {
  constructor(@Inject(ConfigService) private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const expected = this.config.get<string>('EFFECT_TEMPLATE_MIX_WORKER_TOKEN')?.trim();
    const request = context.switchToHttp().getRequest<{ headers: Record<string, unknown> }>();
    const actual = request.headers['x-worker-token'];
    if (typeof actual !== 'string' || !expected)
      throw new UnauthorizedException('Worker token 无效');
    const left = Buffer.from(actual);
    const right = Buffer.from(expected);
    if (left.length !== right.length || !timingSafeEqual(left, right))
      throw new UnauthorizedException('Worker token 无效');
    return true;
  }
}
