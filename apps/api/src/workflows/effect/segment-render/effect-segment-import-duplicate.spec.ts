import { describe, expect, it, vi } from 'vitest';
import { EffectSegmentImportRepository } from './effect-segment-import.repository';
import { findDuplicateSegmentImport } from './effect-segment-import-duplicate';

const hash = 'a'.repeat(64);
const manual = {
  promptId: 'original-draft',
  renderCode: 'R-021',
  outputContentHash: hash,
  generationRequestSnapshot: { importedMaterial: { schemaVersion: 1 } },
};
function fixture() {
  const reader = {
    effectSegmentRenderTask: { findMany: vi.fn().mockResolvedValue([]) },
    effectSegmentImportDraft: {
      findUnique: vi.fn().mockResolvedValue(null),
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockImplementation(async ({ data }) => ({ id: 'new', ...data })),
    },
    $queryRaw: vi.fn().mockResolvedValue([]),
  };
  const repo = new EffectSegmentImportRepository({
    ...reader,
    $transaction: async (operation: (tx: typeof reader) => unknown) => operation(reader),
  } as never);
  const duplicate = (pending = true) =>
    findDuplicateSegmentImport(reader as never, 'project', 'batch', hash, pending);
  return { reader, repo, duplicate };
}

describe('manual import exact-content identity', () => {
  it('blocks confirmed manual media independently of file names', async () => {
    const { reader, duplicate } = fixture();
    reader.effectSegmentRenderTask.findMany.mockResolvedValue([manual]);
    expect((await duplicate())?.message).toContain('R-021');
    expect(reader.effectSegmentImportDraft.findFirst).not.toHaveBeenCalled();
  });
  it('uses original draft identity across copied branches and repairs', async () => {
    const { reader, duplicate } = fixture();
    reader.effectSegmentRenderTask.findMany.mockResolvedValue([
      { ...manual, outputContentHash: 'b'.repeat(64) },
    ]);
    reader.effectSegmentImportDraft.findMany.mockResolvedValue([{ id: manual.promptId }]);
    expect((await duplicate())?.message).toContain('人工素材');
    expect(reader.effectSegmentImportDraft.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          projectId: 'project',
          id: { in: ['original-draft'] },
          status: 'IMPORTED',
          sha256: hash,
        },
      }),
    );
  });
  it('does not block AI-generated media with the same hash', async () => {
    const { reader, duplicate } = fixture();
    reader.effectSegmentRenderTask.findMany.mockResolvedValue([
      { ...manual, generationRequestSnapshot: {} },
    ]);
    expect(await duplicate()).toBeNull();
    expect(reader.effectSegmentImportDraft.findMany).not.toHaveBeenCalled();
  });
  it('ignores cancelled/expired drafts and removed tasks, isolating project and batch', async () => {
    const { reader, duplicate } = fixture();
    expect(await duplicate()).toBeNull();
    expect(reader.effectSegmentRenderTask.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { projectId: 'project', batchId: 'batch' },
      }),
    );
    expect(reader.effectSegmentImportDraft.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          projectId: 'project',
          batchId: 'batch',
          sha256: hash,
          status: 'READY',
          expiresAt: { gt: expect.any(Date) },
        },
      }),
    );
  });
  it('rejects pending duplicates but does not treat itself as a duplicate at confirmation', async () => {
    const { reader, duplicate } = fixture();
    reader.effectSegmentImportDraft.findFirst.mockResolvedValue({ id: 'pending' });
    expect((await duplicate())?.message).toContain('待确认');
    reader.effectSegmentImportDraft.findFirst.mockClear();
    expect(await duplicate(false)).toBeNull();
    expect(reader.effectSegmentImportDraft.findFirst).not.toHaveBeenCalled();
  });
  it('prioritizes upload idempotency before duplicate detection', async () => {
    const { reader, repo } = fixture();
    reader.effectSegmentImportDraft.findUnique.mockResolvedValue({ id: 'same-key' });
    expect(await repo.checkUpload('project', 'batch', 'key', hash)).toMatchObject({
      id: 'same-key',
    });
    expect(reader.effectSegmentRenderTask.findMany).not.toHaveBeenCalled();
  });
  it('rechecks content under the owning batch lock before creating a draft', async () => {
    const { reader, repo } = fixture();
    expect(await repo.checkUpload('project', 'batch', 'key', hash)).toBeNull();
    reader.effectSegmentImportDraft.findFirst.mockResolvedValue({ id: 'concurrent-upload' });
    await expect(
      repo.stage({
        projectId: 'project',
        workflowRunId: 'run',
        batchId: 'batch',
        uploadKey: 'key',
        sha256: hash,
        fileName: '改名.mp4',
        sizeBytes: 100,
        storageKey: 'fixture/video',
        mimeType: 'video/mp4',
        durationSeconds: 6,
        width: 720,
        height: 1280,
        expiresAt: new Date(Date.now() + 60000),
      }),
    ).rejects.toThrow('待确认');
    expect(reader.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      reader.effectSegmentImportDraft.findFirst.mock.invocationCallOrder[1]!,
    );
    expect(reader.effectSegmentImportDraft.create).not.toHaveBeenCalled();
  });
});
