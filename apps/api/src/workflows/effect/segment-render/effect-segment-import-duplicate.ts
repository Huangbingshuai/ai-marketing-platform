import type { Prisma } from '../../../generated/prisma/client';

type ImportReader = Pick<
  Prisma.TransactionClient,
  'effectSegmentImportDraft' | 'effectSegmentRenderTask'
>;

export class DuplicateSegmentImportError extends Error {
  constructor(kind: 'PENDING' | 'IMPORTED', renderCode?: string) {
    super(
      kind === 'PENDING'
        ? '该视频已在待确认导入列表中，请勿重复添加'
        : `该视频已作为人工素材${renderCode ? ` ${renderCode}` : ''}导入，请勿重复导入`,
    );
  }
}

/** Exact file identity only. The current batch is the authority, not project-wide history. */
export async function findDuplicateSegmentImport(
  reader: ImportReader,
  projectId: string,
  batchId: string,
  sha256: string,
  includePending = true,
): Promise<DuplicateSegmentImportError | null> {
  const tasks = await reader.effectSegmentRenderTask.findMany({
    where: { projectId, batchId },
    select: {
      promptId: true,
      renderCode: true,
      outputContentHash: true,
      generationRequestSnapshot: true,
    },
    orderBy: [{ renderCode: 'asc' }, { id: 'asc' }],
  });
  const manualTasks = tasks.filter((task) => {
    const snapshot = task.generationRequestSnapshot;
    return (
      snapshot &&
      typeof snapshot === 'object' &&
      !Array.isArray(snapshot) &&
      !!snapshot.importedMaterial
    );
  });
  const current = manualTasks.find((task) => task.outputContentHash === sha256);
  if (current) return new DuplicateSegmentImportError('IMPORTED', current.renderCode);
  // promptId survives edit-branch copies. Keep original import identity after a repair
  // changes the active output hash; removed tasks no longer reserve that identity.
  if (manualTasks.length) {
    const originals = await reader.effectSegmentImportDraft.findMany({
      where: {
        projectId,
        id: { in: manualTasks.map((task) => task.promptId) },
        status: 'IMPORTED',
        sha256,
      },
      select: { id: true },
    });
    const originalIds = new Set(originals.map((draft) => draft.id));
    const original = manualTasks.find((task) => originalIds.has(task.promptId));
    if (original) return new DuplicateSegmentImportError('IMPORTED', original.renderCode);
  }
  if (
    includePending &&
    (await reader.effectSegmentImportDraft.findFirst({
      where: { projectId, batchId, sha256, status: 'READY', expiresAt: { gt: new Date() } },
      select: { id: true },
    }))
  )
    return new DuplicateSegmentImportError('PENDING');
  return null;
}
