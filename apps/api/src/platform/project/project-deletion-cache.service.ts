import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisConnectionService } from '../cache/redis-connection.service';

const deletePage = `
local page = redis.call('SCAN', ARGV[1], 'MATCH', ARGV[2], 'COUNT', 200)
for _, key in ipairs(page[2]) do redis.call('DEL', key) end
return page[1]`;
const escapeGlob = (value: string): string => value.replace(/[\\*?[\]]/g, '\\$&');

@Injectable()
export class ProjectDeletionCacheService {
  constructor(
    @Inject(RedisConnectionService) private readonly redis: RedisConnectionService,
    @Inject(ConfigService) private readonly config: ConfigService,
  ) {}

  async clear(projectId: string): Promise<void> {
    const namespace =
      this.config.get<string>('EFFECT_READ_CACHE_NAMESPACE') ?? 'amp:effect-read:v1';
    for (const pattern of [
      `${escapeGlob(namespace)}:${projectId}:*`,
      `job:effect-extraction:${projectId}:*`,
    ]) {
      let cursor = '0';
      do {
        cursor = String(
          await this.redis.execute((client) =>
            client.eval(deletePage, { keys: [], arguments: [cursor, pattern] }),
          ),
        );
      } while (cursor !== '0');
    }
  }
}
