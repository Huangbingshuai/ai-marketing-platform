import type { AuthSession, LoginRequest } from '@ai-marketing/contracts';
import { Body, Controller, Get, Headers, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import { IsString, MaxLength, MinLength } from 'class-validator';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { AuthAccess } from './auth-access.decorator';
import { AuthService } from './auth.service';

export class LoginDto implements LoginRequest {
  @IsString() @MinLength(1) @MaxLength(120) username!: string;
  @IsString() @MinLength(1) @MaxLength(256) password!: string;
}

@Controller('auth')
@AuthAccess('public')
export class AuthController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  @Post('login')
  @HttpCode(200)
  async login(
    @Body() input: LoginDto,
    @Req() request: IncomingMessage & { ip?: string },
    @Res({ passthrough: true }) response: ServerResponse,
  ): Promise<AuthSession> {
    this.auth.checkOrigin(request.headers.origin);
    const result = await this.auth.login(
      input,
      request.ip ?? request.socket.remoteAddress ?? 'unknown',
      this.auth.readToken(request.headers.cookie),
    );
    response.setHeader('set-cookie', this.auth.cookie(result.token));
    response.setHeader('cache-control', 'no-store');
    return result.session;
  }

  @Get('session')
  async session(
    @Headers('cookie') cookie: string | undefined,
    @Res({ passthrough: true }) response: ServerResponse,
  ): Promise<AuthSession> {
    response.setHeader('cache-control', 'no-store');
    return this.auth.session(this.auth.readToken(cookie));
  }

  @Post('logout')
  @HttpCode(200)
  async logout(
    @Headers('origin') origin: string | undefined,
    @Headers('cookie') cookie: string | undefined,
    @Res({ passthrough: true }) response: ServerResponse,
  ): Promise<null> {
    this.auth.checkOrigin(origin);
    await this.auth.logout(this.auth.readToken(cookie));
    response.setHeader('set-cookie', this.auth.cookie('', true));
    response.setHeader('cache-control', 'no-store');
    return null;
  }
}
