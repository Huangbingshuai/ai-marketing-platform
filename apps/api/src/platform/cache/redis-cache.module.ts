import { Global, Module } from '@nestjs/common';
import { ProjectModule } from '../project/project.module';
import { RedisConnectionService } from './redis-connection.service';
import { EffectCacheRevisionService } from './effect-cache-revision.service';
import { EffectReadCacheService } from './effect-read-cache.service';

@Global()
@Module({
  imports: [ProjectModule],
  providers: [RedisConnectionService, EffectCacheRevisionService, EffectReadCacheService],
  exports: [RedisConnectionService, EffectReadCacheService],
})
export class RedisCacheModule {}
