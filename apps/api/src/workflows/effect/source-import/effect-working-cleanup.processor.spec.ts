import { describe, expect, it, vi } from 'vitest';

import type { StoragePort } from '../../../platform/file/storage.port';
import type { EffectSourceImportRepository } from './effect-source-import.repository';
import { EffectWorkingCleanupProcessor } from './effect-working-cleanup.processor';

const runTick = (processor: EffectWorkingCleanupProcessor): Promise<void> =>
  (
    processor as unknown as {
      tick: () => Promise<void>;
    }
  ).tick();

describe('EffectWorkingCleanupProcessor', () => {
  it('purges expired products and deletes only unreferenced storage objects', async () => {
    const repository = {
      dueRemovedProducts: vi.fn().mockResolvedValue([{ projectId: 'project-a', id: 'product-a' }]),
      purgeRemovedProduct: vi.fn().mockResolvedValue(true),
      storageCleanupTasksAcrossProjects: vi
        .fn()
        .mockResolvedValue([
          { id: 'cleanup-a', projectId: 'project-a', storageKey: '01-working/old.png' },
        ]),
      isStorageHeld: vi.fn().mockResolvedValue(false),
      deleteOrphanedFileObject: vi.fn().mockResolvedValue({ count: 1 }),
      deleteStorageCleanup: vi.fn().mockResolvedValue({ count: 1 }),
      failStorageCleanup: vi.fn(),
    } as unknown as EffectSourceImportRepository;
    const storage = { delete: vi.fn().mockResolvedValue(undefined) } as unknown as StoragePort;
    const processor = new EffectWorkingCleanupProcessor(repository, storage);

    await runTick(processor);

    expect(repository.purgeRemovedProduct).toHaveBeenCalledWith('project-a', 'product-a');
    expect(storage.delete).toHaveBeenCalledWith('01-working/old.png');
    expect(repository.deleteStorageCleanup).toHaveBeenCalledWith('project-a', 'cleanup-a');
  });

  it('keeps an object while any hold or business reference still exists', async () => {
    const repository = {
      dueRemovedProducts: vi.fn().mockResolvedValue([]),
      storageCleanupTasksAcrossProjects: vi
        .fn()
        .mockResolvedValue([
          { id: 'cleanup-a', projectId: 'project-a', storageKey: '01-working/held.docx' },
        ]),
      isStorageHeld: vi.fn().mockResolvedValue(true),
      deleteOrphanedFileObject: vi.fn(),
      deleteStorageCleanup: vi.fn(),
      failStorageCleanup: vi.fn(),
    } as unknown as EffectSourceImportRepository;
    const storage = { delete: vi.fn() } as unknown as StoragePort;
    const processor = new EffectWorkingCleanupProcessor(repository, storage);

    await runTick(processor);

    expect(storage.delete).not.toHaveBeenCalled();
    expect(repository.deleteOrphanedFileObject).not.toHaveBeenCalled();
    expect(repository.deleteStorageCleanup).not.toHaveBeenCalled();
  });
});
