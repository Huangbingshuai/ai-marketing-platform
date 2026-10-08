import { PrismaPg } from '@prisma/adapter-pg';
import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { PrismaClient, type Prisma } from '../generated/prisma/client';

@Injectable()
export class PrismaService
  extends PrismaClient<
    Prisma.PrismaClientOptions & {
      log: Array<{ emit: 'event'; level: 'query' }>;
    }
  >
  implements OnModuleDestroy
{
  private readonly timingLogger = new Logger('DatabaseReadMetrics');
  private readonly queryDurations: number[] = [];

  constructor(@Inject(ConfigService) config: ConfigService) {
    const adapter = new PrismaPg({ connectionString: config.getOrThrow<string>('DATABASE_URL') });
    const measure = config.get<boolean>('EFFECT_READ_CACHE_LOG_METRICS') === true;
    super({ adapter, log: measure ? [{ emit: 'event', level: 'query' }] : [] });
    if (measure)
      this.$on('query', (event) => {
        // Never log query text, bind parameters or result bodies. Batch numeric timings only.
        this.queryDurations.push(event.duration);
        if (this.queryDurations.length >= 100) this.flushQueryMetrics();
      });
  }

  private flushQueryMetrics(): void {
    if (!this.queryDurations.length) return;
    const times = this.queryDurations.splice(0).sort((a, b) => a - b);
    this.timingLogger.log(
      JSON.stringify({
        event: 'database_query_timings',
        queries: times.length,
        totalMs: times.reduce((sum, duration) => sum + duration, 0),
        p50Ms: times[Math.ceil(times.length * 0.5) - 1],
        p95Ms: times[Math.ceil(times.length * 0.95) - 1],
      }),
    );
  }

  async onModuleDestroy(): Promise<void> {
    this.flushQueryMetrics();
    await this.$disconnect();
  }
}
