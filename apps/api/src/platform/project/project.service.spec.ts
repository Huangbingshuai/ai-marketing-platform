import type { Project as ProjectRecord } from '../../generated/prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProjectRepository } from './project.repository';
import { ProjectService } from './project.service';

const timestamp = new Date('2026-08-20T02:00:00.000Z');
const record: ProjectRecord = {
  id: '5db5821d-10ac-4dc0-88d3-3cd33f48fc97',
  name: '夏季投放',
  description: '食品短视频项目',
  client: null,
  productName: null,
  iconKey: null,
  defaultWorkflow: null,
  defaultSpace: null,
  status: 'ACTIVE',
  createdAt: timestamp,
  updatedAt: timestamp,
};

describe('ProjectService', () => {
  let repository: {
    create: ReturnType<typeof vi.fn>;
    find: ReturnType<typeof vi.fn>;
  };
  let service: ProjectService;

  beforeEach(() => {
    repository = { create: vi.fn(), find: vi.fn() };
    service = new ProjectService(repository as unknown as ProjectRepository);
  });

  it('creates a normalized active project and returns shared contract dates', async () => {
    repository.create.mockResolvedValue(record);

    await expect(
      service.create({ name: '  夏季投放  ', description: '  食品短视频项目  ' }),
    ).resolves.toEqual({
      id: record.id,
      name: record.name,
      description: record.description,
      status: record.status,
      client: null,
      productName: null,
      iconKey: null,
      workflowSpaces: {
        effect: false,
        customized: false,
        fission: { clone: false, avatar: false, localReplace: false },
      },
      createdAt: timestamp.toISOString(),
      updatedAt: timestamp.toISOString(),
    });
    expect(repository.create).toHaveBeenCalledWith({
      name: '夏季投放',
      description: '食品短视频项目',
      status: 'ACTIVE',
      client: null,
      productName: null,
      iconKey: null,
      defaultWorkflow: null,
      defaultSpace: null,
    });
  });

  it('stores an omitted description as null', async () => {
    repository.create.mockResolvedValue({ ...record, description: null });

    await service.create({ name: record.name });

    expect(repository.create).toHaveBeenCalledWith({
      name: record.name,
      description: null,
      status: 'ACTIVE',
      client: null,
      productName: null,
      iconKey: null,
      defaultWorkflow: null,
      defaultSpace: null,
    });
  });

  it('gets one project by id and derives counts from only its active assets', async () => {
    repository.find.mockResolvedValue({
      ...record,
      defaultSpace: 'EFFECT',
      assets: [
        { storageWorkflow: 'EFFECT', workflowSpace: 'EFFECT' },
        { storageWorkflow: 'FISSION', workflowSpace: 'FISSION_CLONE' },
      ],
    });

    await expect(service.get(record.id)).resolves.toMatchObject({
      id: record.id,
      workflowSpaces: {
        effect: true,
        customized: false,
        fission: { clone: true, avatar: false, localReplace: false },
      },
      assetCounts: { EFFECT: 1, FISSION_CLONE: 1 },
    });
    expect(repository.find).toHaveBeenCalledWith(record.id);
  });

  it('does not expose whether an unknown project has assets', async () => {
    repository.find.mockResolvedValue(null);

    await expect(service.get('unknown-project')).rejects.toMatchObject({
      status: 404,
      response: { code: 'PROJECT_NOT_FOUND' },
    });
  });
});
