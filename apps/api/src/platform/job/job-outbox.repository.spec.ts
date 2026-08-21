import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../database/prisma.service';
import { JobOutboxRepository } from './job-outbox.repository';

describe('JobOutboxRepository dispatch ownership', () => {
  it('marks a message published only for the current dispatch token', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const repository = new JobOutboxRepository({
      jobOutbox: { updateMany },
    } as unknown as PrismaService);

    await repository.markPublished('project-a', 'outbox-a', 'dispatch-a');

    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          projectId: 'project-a',
          id: 'outbox-a',
          status: 'PENDING',
          dispatchToken: 'dispatch-a',
        },
      }),
    );
  });

  it('cannot overwrite a worker-triggered retry after its dispatch token is cleared', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 0 });
    const repository = new JobOutboxRepository({
      jobOutbox: { updateMany },
    } as unknown as PrismaService);

    await expect(
      repository.markPublished('project-a', 'outbox-a', 'stale-dispatch'),
    ).resolves.toEqual({ count: 0 });
  });
});
