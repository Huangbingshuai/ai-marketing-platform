import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { AuthSession, LoginRequest } from '@ai-marketing/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiHttpException } from '../../common/api-http-exception';
import { AuthRepository } from './auth.repository';

const deriveKey = promisify(scrypt);
const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
export const AUTH_COOKIE = 'richi_session';
const SESSION_SECONDS = 12 * 60 * 60;
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;

export const authRequired = () =>
  new ApiHttpException('登录已过期，请重新登录', 401, 'AUTH_REQUIRED');

@Injectable()
export class AuthService {
  private readonly username: string;
  private readonly passwordHash: string;
  private readonly fingerprint: string;
  private readonly secure: boolean;
  private readonly origins: Set<string>;
  private cleanupAfter = 0;

  constructor(
    @Inject(ConfigService) config: ConfigService,
    @Inject(AuthRepository) private readonly repository: AuthRepository,
  ) {
    this.username = config.get<string>('AUTH_USERNAME')?.trim() ?? '';
    this.passwordHash = config.get<string>('AUTH_PASSWORD_HASH') ?? '';
    if (!this.username || !/^scrypt\$[a-f0-9]{32}\$[a-f0-9]{128}$/.test(this.passwordHash))
      throw new Error('请配置 AUTH_USERNAME 和有效的 AUTH_PASSWORD_HASH，参见登录部署指南');
    this.fingerprint = digest(`${this.username}\0${this.passwordHash}`);
    this.secure = config.get<boolean>('AUTH_COOKIE_SECURE') ?? true;
    this.origins = new Set(
      config
        .getOrThrow<string>('WEB_ORIGIN')
        .split(',')
        .map((origin) => new URL(origin.trim()).origin),
    );
  }

  checkOrigin(origin: string | undefined): void {
    if (!origin || !this.origins.has(origin))
      throw new ApiHttpException('请求来源无效，请从系统页面重试', 403, 'AUTH_ORIGIN_REJECTED');
  }

  cookie(token: string, clear = false): string {
    return `${AUTH_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${clear ? 0 : SESSION_SECONDS}${this.secure ? '; Secure' : ''}`;
  }

  readToken(cookie: string | undefined): string | null {
    const value = cookie
      ?.split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${AUTH_COOKIE}=`))
      ?.slice(AUTH_COOKIE.length + 1);
    return value && /^[a-f0-9]{64}$/.test(value) ? value : null;
  }

  async login(
    input: LoginRequest,
    peer: string,
    previousToken: string | null,
  ): Promise<{ token: string; session: AuthSession }> {
    const now = Date.now();
    const bucket = Math.floor(now / ATTEMPT_WINDOW_MS);
    // Ignore untrusted forwarding headers. Reverse proxies are configured explicitly by deployment.
    const count = await this.repository.countAttempt(
      digest(`${peer}:${bucket}`),
      new Date((bucket + 1) * ATTEMPT_WINDOW_MS),
    );
    if (count > 10)
      throw new ApiHttpException('登录尝试过于频繁，请 15 分钟后重试', 429, 'AUTH_RATE_LIMITED');
    const [, salt, expected] = this.passwordHash.split('$');
    const actual = (await deriveKey(input.password, salt!, 64)) as Buffer;
    const passwordValid = timingSafeEqual(actual, Buffer.from(expected!, 'hex'));
    const usernameValid = timingSafeEqual(
      Buffer.from(digest(input.username)),
      Buffer.from(digest(this.username)),
    );
    if (!passwordValid || !usernameValid)
      throw new ApiHttpException('用户名或密码不正确', 401, 'AUTH_INVALID_CREDENTIALS');
    if (previousToken) await this.logout(previousToken);
    const token = randomBytes(32).toString('hex');
    const expiresAt = new Date(now + SESSION_SECONDS * 1000);
    await this.repository.createSession({
      tokenHash: digest(token),
      username: this.username,
      credentialFingerprint: this.fingerprint,
      expiresAt,
    });
    if (now >= this.cleanupAfter) {
      this.cleanupAfter = now + 60 * 60 * 1000;
      await this.repository.cleanup(new Date(now));
    }
    return { token, session: { username: this.username, expiresAt: expiresAt.toISOString() } };
  }

  async session(token: string | null): Promise<AuthSession> {
    if (!token) throw authRequired();
    const stored = await this.repository.findSession(digest(token));
    if (
      !stored ||
      stored.expiresAt.getTime() <= Date.now() ||
      stored.credentialFingerprint !== this.fingerprint ||
      stored.username !== this.username
    )
      throw authRequired();
    return { username: stored.username, expiresAt: stored.expiresAt.toISOString() };
  }

  async logout(token: string | null): Promise<void> {
    if (token) await this.repository.deleteSession(digest(token));
  }
}
