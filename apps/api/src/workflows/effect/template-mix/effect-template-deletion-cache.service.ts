import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisConnectionService } from '../../../platform/cache/redis-connection.service';

export const DELETE_TEMPLATE_CACHE_PAGE = `
local page = redis.call('SCAN', ARGV[1], 'MATCH', ARGV[2], 'COUNT', 100)
for _, key in ipairs(page[2]) do redis.call('UNLINK', key) end
return page[1]`;

@Injectable()
export class EffectTemplateDeletionCache {
  constructor(
    @Inject(RedisConnectionService) private readonly redis: RedisConnectionService,
    @Inject(ConfigService) private readonly config: ConfigService,
  ) {}
  async clear(projectId: string): Promise<void> {
    // These are aggregate projections, not template-specific keys. Other workflows/projects
    // and job queues remain untouched. New keys have a tombstone-aware database version.
    const namespace = (
      this.config.get<string>('EFFECT_READ_CACHE_NAMESPACE') ?? 'amp:effect-read:v1'
    ).replace(/[\\*?[\]]/g, '\\$&');
    let cursor = '0';
    do {
      cursor = String(
        await this.redis.execute((client) =>
          client.eval(DELETE_TEMPLATE_CACHE_PAGE, {
            keys: [],
            arguments: [cursor, `${namespace}:${projectId}:EFFECT:*`],
          }),
        ),
      );
    } while (cursor !== '0');
  }
}
