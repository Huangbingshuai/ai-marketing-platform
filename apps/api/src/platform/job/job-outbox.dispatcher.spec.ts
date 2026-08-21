import { describe, expect, it, vi } from 'vitest';

import type { JobPublisher } from './job.ports';
import type { JobOutboxRepository } from './job-outbox.repository';
import { JobOutboxDispatcher } from './job-outbox.dispatcher';

describe('JobOutboxDispatcher', () => {
  it('publishes the claimed small message and marks it published', async () => {
    const entry = {
      id: 'outbox-a',
      projectId: 'project-a',
      routingKey: 'effect.extraction.requested',
      payload: {
        schemaVersion: 1,
        projectId: 'project-a',
        runId: 'run-a',
        requestId: 'request-a',
      },
      attempts: 1,
      dispatchToken: 'dispatch-a',
    };
    const repository = {
      claimPending: vi.fn().mockResolvedValue([entry]),
      markPublished: vi.fn().mockResolvedValue({ count: 1 }),
      markFailed: vi.fn(),
    } as unknown as JobOutboxRepository;
    const publisher = { publish: vi.fn().mockResolvedValue(undefined) } as JobPublisher;
    const dispatcher = new JobOutboxDispatcher(repository, publisher);

    await dispatcher.dispatchPending();

    expect(publisher.publish).toHaveBeenCalledWith(
      'effect.extraction.requested',
      'outbox-a',
      entry.payload,
    );
    expect(repository.markPublished).toHaveBeenCalledWith('project-a', 'outbox-a', 'dispatch-a');
    expect(repository.markFailed).not.toHaveBeenCalled();
  });

  it('keeps a failed publish pending with a later retry time', async () => {
    const repository = {
      claimPending: vi.fn().mockResolvedValue([
        {
          id: 'outbox-a',
          projectId: 'project-a',
          routingKey: 'effect.extraction.requested',
          payload: {
            schemaVersion: 1,
            projectId: 'project-a',
            runId: 'run-a',
            requestId: 'request-a',
          },
          attempts: 2,
          dispatchToken: 'dispatch-a',
        },
      ]),
      markPublished: vi.fn(),
      markFailed: vi.fn().mockResolvedValue({ count: 1 }),
    } as unknown as JobOutboxRepository;
    const publisher = {
      publish: vi.fn().mockRejectedValue(new Error('rabbit unavailable')),
    } as JobPublisher;
    const dispatcher = new JobOutboxDispatcher(repository, publisher);

    await dispatcher.dispatchPending();

    expect(repository.markPublished).not.toHaveBeenCalled();
    expect(repository.markFailed).toHaveBeenCalledWith(
      'project-a',
      'outbox-a',
      'dispatch-a',
      'rabbit unavailable',
      expect.any(Date),
    );
  });
});
