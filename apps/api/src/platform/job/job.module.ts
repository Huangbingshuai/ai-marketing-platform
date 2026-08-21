import { Module } from '@nestjs/common';

import { JOB_PROGRESS_STORE, JOB_PUBLISHER } from './job.constants';
import { JobOutboxDispatcher } from './job-outbox.dispatcher';
import { JobOutboxRepository } from './job-outbox.repository';
import { RabbitMqJobPublisher } from './rabbitmq-job.publisher';
import { RedisJobProgressStore } from './redis-job-progress.store';

@Module({
  providers: [
    JobOutboxRepository,
    JobOutboxDispatcher,
    RabbitMqJobPublisher,
    RedisJobProgressStore,
    { provide: JOB_PUBLISHER, useExisting: RabbitMqJobPublisher },
    { provide: JOB_PROGRESS_STORE, useExisting: RedisJobProgressStore },
  ],
  exports: [JOB_PROGRESS_STORE, JobOutboxRepository],
})
export class JobModule {}
