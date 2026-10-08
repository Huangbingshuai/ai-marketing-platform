import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { emptyCustomizedImportDraft } from '@ai-marketing/contracts';
import { WorkflowWorkingService } from './workflow-working.service';

describe('customized source confirmation file boundary', () => {
  const setup = () => {
    const draft = {
      ...emptyCustomizedImportDraft(),
      materials: [{ assetId: 'asset', assetVersion: 1, category: 'BRIEF' }],
    };
    const repository = {
      assertCustomizedImportEditableForConfirmation: vi.fn().mockResolvedValue(undefined),
      findNodeState: vi.fn().mockResolvedValue({ revision: 2, state: draft }),
      findCustomizedSourceFiles: vi
        .fn()
        .mockResolvedValue([{ storageKey: 'frozen', sizeBytes: 4, status: 'AVAILABLE' }]),
      saveCustomizedSourceVersion: vi.fn().mockResolvedValue({
        run: {
          id: 'run',
          projectId: 'p',
          workflow: 'CUSTOMIZED',
          workflowSpace: 'CUSTOMIZED_PROJECT',
          status: 'ACTIVE',
          lastActiveAt: new Date(),
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        unchanged: false,
        createdBranch: false,
      }),
    };
    const storage = {
      open: vi
        .fn()
        .mockImplementation(async () => ({ stream: Readable.from('data'), sizeBytes: 4 })),
    };
    const service = new WorkflowWorkingService(
      repository as never,
      { get: vi.fn() } as never,
      storage as never,
    );
    return { service, repository, storage };
  };
  it('only commits after confirming all frozen file versions are readable', async () => {
    const f = setup();
    await f.service.saveCustomizedSourceVersion('p', 'run', 2);
    expect(f.storage.open).toHaveBeenCalledWith('frozen');
    expect(f.repository.saveCustomizedSourceVersion).toHaveBeenCalledWith('p', 'run', 2);
  });
  it('rejects a stale draft revision without accessing storage or committing', async () => {
    const f = setup();
    await expect(f.service.saveCustomizedSourceVersion('p', 'run', 1)).rejects.toThrow(
      '草稿已更新',
    );
    expect(f.storage.open).not.toHaveBeenCalled();
    expect(f.repository.saveCustomizedSourceVersion).not.toHaveBeenCalled();
  });
  it.each(['MISSING', 'SIZE', 'READ_ERROR'])(
    'does not publish incomplete files: %s',
    async (failure) => {
      const f = setup();
      if (failure === 'MISSING') f.storage.open.mockRejectedValue(new Error('MISSING'));
      if (failure === 'SIZE')
        f.storage.open.mockResolvedValue({ stream: Readable.from('data'), sizeBytes: 3 });
      if (failure === 'READ_ERROR')
        f.storage.open.mockResolvedValue({
          stream: new Readable({
            read() {
              this.destroy(new Error('READ_ERROR'));
            },
          }),
          sizeBytes: 4,
        });
      await expect(f.service.saveCustomizedSourceVersion('p', 'run', 2)).rejects.toThrow(
        '读取失败',
      );
      expect(f.repository.saveCustomizedSourceVersion).not.toHaveBeenCalled();
    },
  );
});
