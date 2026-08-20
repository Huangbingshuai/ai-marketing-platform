import type { Project as ProjectRecord } from '../../generated/prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProjectRepository } from './project.repository';
import { ProjectService } from './project.service';

const timestamp = new Date('2026-08-20T02:00:00.000Z');
const record: ProjectRecord = {
  id: '5db5821d-10ac-4dc0-88d3-3cd33f48fc97',
  name: '夏季投放',
  description: '食品短视频项目',
  status: 'ACTIVE',
  createdAt: timestamp,
  updatedAt: timestamp,
};

describe('ProjectService', () => {
  let repository: { create: ReturnType<typeof vi.fn> };
  let service: ProjectService;

  beforeEach(() => {
    repository = { create: vi.fn() };
    service = new ProjectService(repository as unknown as ProjectRepository);
  });

  it('creates a normalized active project and returns shared contract dates', async () => {
    repository.create.mockResolvedValue(record);

    await expect(
      service.create({ name: '  夏季投放  ', description: '  食品短视频项目  ' }),
    ).resolves.toEqual({
      ...record,
      createdAt: timestamp.toISOString(),
      updatedAt: timestamp.toISOString(),
    });
    expect(repository.create).toHaveBeenCalledWith({
      name: '夏季投放',
      description: '食品短视频项目',
      status: 'ACTIVE',
    });
  });

  it('stores an omitted description as null', async () => {
    repository.create.mockResolvedValue({ ...record, description: null });

    await service.create({ name: record.name });

    expect(repository.create).toHaveBeenCalledWith({
      name: record.name,
      description: null,
      status: 'ACTIVE',
    });
  });
});
