import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';

@Injectable()
export class AuthRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async countAttempt(key: string, expiresAt: Date): Promise<number> {
    const attempt = await this.prisma.authLoginAttempt.upsert({
      where: { key },
      create: { key, count: 1, expiresAt },
      update: { count: { increment: 1 } },
    });
    return attempt.count;
  }

  createSession(data: {
    tokenHash: string;
    username: string;
    credentialFingerprint: string;
    expiresAt: Date;
  }) {
    return this.prisma.authSession.create({ data });
  }

  findSession(tokenHash: string) {
    return this.prisma.authSession.findUnique({ where: { tokenHash } });
  }

  async deleteSession(tokenHash: string): Promise<void> {
    await this.prisma.authSession.deleteMany({ where: { tokenHash } });
  }

  async cleanup(now: Date): Promise<void> {
    await this.prisma.authSession.deleteMany({ where: { expiresAt: { lte: now } } });
    await this.prisma.authLoginAttempt.deleteMany({ where: { expiresAt: { lte: now } } });
  }
}
