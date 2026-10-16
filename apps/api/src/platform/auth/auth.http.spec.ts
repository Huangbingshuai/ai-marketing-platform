import { randomBytes, scryptSync } from 'node:crypto';
import { Controller, Get, Module, Post, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD, NestFactory, Reflector } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { HttpExceptionFilter } from '../../common/http-exception.filter';
import { ResponseEnvelopeInterceptor } from '../../common/response-envelope.interceptor';
import { AuthAccess } from './auth-access.decorator';
import { AuthController } from './auth.controller';
import { AuthGuard } from './auth.guard';
import { AuthRepository } from './auth.repository';
import { AuthService } from './auth.service';

const password = 'isolated-auth-test-password';
const salt = randomBytes(16).toString('hex');
const passwordHash = `scrypt$${salt}$${scryptSync(password, salt, 64).toString('hex')}`;
const origin = 'http://localhost:5173';
type Stored = {
  tokenHash: string;
  username: string;
  credentialFingerprint: string;
  expiresAt: Date;
};
const sessions = new Map<string, Stored>();
const attempts = new Map<string, number>();
const repository = {
  async countAttempt(key: string) {
    const count = (attempts.get(key) ?? 0) + 1;
    attempts.set(key, count);
    return count;
  },
  async createSession(data: Stored) {
    sessions.set(data.tokenHash, data);
    return data;
  },
  async findSession(hash: string) {
    return sessions.get(hash) ?? null;
  },
  async deleteSession(hash: string) {
    sessions.delete(hash);
  },
  async cleanup() {},
};
const config = new ConfigService({
  AUTH_USERNAME: 'operator-test',
  AUTH_PASSWORD_HASH: passwordHash,
  AUTH_COOKIE_SECURE: true,
  WEB_ORIGIN: origin,
});

@Controller('projects')
class BusinessProbe {
  @Get() list() {
    return [];
  }
  @Post() write() {
    return { saved: true };
  }
}
@Controller('health')
@AuthAccess('public')
class HealthProbe {
  @Get() health() {
    return { status: 'ok' };
  }
}
@Module({
  controllers: [AuthController, BusinessProbe, HealthProbe],
  providers: [
    AuthService,
    Reflector,
    { provide: ConfigService, useValue: config },
    { provide: AuthRepository, useValue: repository },
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
class AuthProbeModule {}

describe('operator authentication HTTP boundary (isolated repository)', () => {
  let app: NestExpressApplication;
  let base: string;
  beforeAll(async () => {
    app = await NestFactory.create<NestExpressApplication>(AuthProbeModule, { logger: false });
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }),
    );
    app.useGlobalFilters(new HttpExceptionFilter());
    app.useGlobalInterceptors(new ResponseEnvelopeInterceptor());
    await app.listen(0, '127.0.0.1');
    base = `${await app.getUrl()}/api`;
  });
  beforeEach(() => {
    sessions.clear();
    attempts.clear();
  });
  afterAll(async () => {
    await app.close();
  });
  const signIn = (
    body: unknown = { username: 'operator-test', password },
    requestOrigin: string | undefined = origin,
  ) =>
    fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(requestOrigin ? { origin: requestOrigin } : {}),
      },
      body: JSON.stringify(body),
    });
  const validCookie = async () => {
    const response = await signIn();
    expect(response.status).toBe(200);
    return response.headers.get('set-cookie')!.split(';')[0]!;
  };

  it('protects both anonymous business reads and writes, leaving health public', async () => {
    for (const method of ['GET', 'POST']) {
      const response = await fetch(`${base}/projects`, { method });
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ code: 'AUTH_REQUIRED', success: false });
    }
    expect((await fetch(`${base}/health`)).status).toBe(200);
  });
  it('creates an opaque secure HttpOnly cookie and restores a session without exposing credentials', async () => {
    const response = await signIn();
    const cookie = response.headers.get('set-cookie')!;
    expect(cookie).toContain('HttpOnly; SameSite=Lax; Max-Age=43200; Secure');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toMatchObject({
      success: true,
      data: { username: 'operator-test' },
    });
    const stored = [...sessions.values()][0]!;
    expect(cookie).not.toContain(stored.tokenHash);
    const headers = { cookie: cookie.split(';')[0]! };
    expect((await fetch(`${base}/auth/session`, { headers })).status).toBe(200);
    expect((await fetch(`${base}/projects`, { headers })).status).toBe(200);
    expect(
      (await fetch(`${base}/projects`, { method: 'POST', headers: { ...headers, origin } })).status,
    ).toBe(201);
  });
  it('reports the same error for wrong username and password and validates request bounds', async () => {
    for (const input of [
      { username: 'unknown', password },
      { username: 'operator-test', password: 'incorrect' },
    ]) {
      const response = await signIn(input);
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({
        code: 'AUTH_INVALID_CREDENTIALS',
        message: '用户名或密码不正确',
      });
    }
    for (const input of [
      { password },
      { username: 'operator-test' },
      { username: 123, password },
      { username: 'operator-test', password: 'x'.repeat(257) },
      { username: 'operator-test', password, unexpected: true },
    ])
      expect((await signIn(input)).status).toBe(400);
    expect(sessions.size).toBe(0);
  });
  it('rejects missing and hostile origins for login, logout and authenticated writes', async () => {
    const cookie = await validCookie();
    for (const requestOrigin of ['', 'https://untrusted.example']) {
      expect((await signIn(undefined, requestOrigin)).status).toBe(403);
      for (const path of ['/projects', '/auth/logout'])
        expect(
          (
            await fetch(base + path, {
              method: 'POST',
              headers: { cookie, ...(requestOrigin ? { origin: requestOrigin } : {}) },
            })
          ).status,
        ).toBe(403);
    }
    expect((await fetch(`${base}/auth/session`, { headers: { cookie } })).status).toBe(200);
  });
  it('revokes logout on the server and makes repeated logout safe', async () => {
    const cookie = await validCookie();
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await fetch(`${base}/auth/logout`, {
        method: 'POST',
        headers: { cookie, origin },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
    }
    expect((await fetch(`${base}/projects`, { headers: { cookie } })).status).toBe(401);
  });
  it('rejects forged, expired and obsolete-credential sessions', async () => {
    const cookie = await validCookie();
    const stored = [...sessions.values()][0]!;
    expect(
      (await fetch(`${base}/projects`, { headers: { cookie: 'richi_session=invalid' } })).status,
    ).toBe(401);
    expect(
      (await fetch(`${base}/projects`, { headers: { cookie: `richi_session=${'a'.repeat(64)}` } }))
        .status,
    ).toBe(401);
    stored.expiresAt = new Date(0);
    expect((await fetch(`${base}/projects`, { headers: { cookie } })).status).toBe(401);
    stored.expiresAt = new Date(Date.now() + 100000);
    stored.credentialFingerprint = 'obsolete';
    expect((await fetch(`${base}/projects`, { headers: { cookie } })).status).toBe(401);
  });
  it('limits parallel attempts before password verification without trusting spoofed headers', async () => {
    const responses = await Promise.all(
      Array.from({ length: 12 }, () => signIn({ username: 'operator-test', password: 'wrong' })),
    );
    expect(responses.filter((response) => response.status === 429)).toHaveLength(2);
    expect(responses.filter((response) => response.status === 401)).toHaveLength(10);
  });
  it('fails closed when login credentials are absent or malformed', () => {
    for (const values of [{}, { AUTH_USERNAME: 'test', AUTH_PASSWORD_HASH: 'plaintext' }])
      expect(
        () => new AuthService(new ConfigService(values), repository as unknown as AuthRepository),
      ).toThrow('AUTH_USERNAME');
  });
});
