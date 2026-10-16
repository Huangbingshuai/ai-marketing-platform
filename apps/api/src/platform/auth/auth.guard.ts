import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { IncomingMessage } from 'node:http';
import { AUTH_ACCESS } from './auth-access.decorator';
import { AuthService } from './auth.service';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(AuthService) private readonly auth: AuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const access = this.reflector.getAllAndOverride<string>(AUTH_ACCESS, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (access === 'public' || access === 'independent') return true;
    const request = context.switchToHttp().getRequest<IncomingMessage>();
    await this.auth.session(this.auth.readToken(request.headers.cookie));
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method ?? ''))
      this.auth.checkOrigin(request.headers.origin);
    return true;
  }
}
