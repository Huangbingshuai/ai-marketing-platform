import { randomUUID } from 'node:crypto';
import { Prisma } from '../../generated/prisma/client';

type Tx = Prisma.TransactionClient;

const json = (value: unknown): Prisma.InputJsonValue =>
  (value === undefined || value === null ? {} : value) as Prisma.InputJsonValue;

/**
 * Every key a branch remaps is either a row id (UUID) or a content hash (64 hex chars), so one
 * pass over the payload is enough. Rewriting the payload once per key instead makes a fork
 * quadratic in the size of the id map, which costs minutes on a project with a few hundred films.
 */
const REMAPPABLE_ID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{64}/g;

export const remapIds = <T>(value: T, replacements: Record<string, string>): T => {
  if (value === undefined || value === null) return value;
  const serialized = JSON.stringify(value);
  if (serialized === undefined) return value;
  const replaced = serialized.replace(REMAPPABLE_ID, (match) => replacements[match] ?? match);
  return replaced === serialized ? value : (JSON.parse(replaced) as T);
};

export type PackagingCloneOptions = {
  /** Only templates in this set are cloned. Omitted means every template. */
  templateIds?: ReadonlySet<string>;
  /** Only variants in this set are cloned. Omitted means every variant. */
  variantIds?: ReadonlySet<string>;
  /** Namespace for the cloned runs' idempotency keys. */
  keyPrefix?: string;
  /**
   * Replacements for the snapshot/checkpoint JSON, defaulting to `ids`. Callers that clone the
   * artifacts a snapshot points at *before* the runs can hand over the complete map here and skip
   * `remapClonedPackagingRunsInTransaction`; the rest leave it out and run that second pass.
   */
  snapshotIds?: Record<string, string>;
};

export type ClonedPackagingRun = Prisma.EffectPackagingRunGetPayload<{
  include: { items: { include: { files: true } } };
}>;

/**
 * Copy completed packaging runs of a parent Run into a branch.
 *
 * Rows are inserted with client-generated ids so the whole subtree goes in four statements. A
 * project with a few hundred films has thousands of items and tens of thousands of files, and one
 * insert per row does not fit in the transaction budget that guards the fork.
 *
 * Snapshot and checkpoint JSON reference parent artifact ids, so they are re-written here with
 * `snapshotIds`. When that map is still incomplete the caller re-writes them once every artifact
 * has been cloned (see `remapClonedPackagingRunsInTransaction`); the source runs are returned for
 * exactly that.
 */
export async function clonePackagingRunsInTransaction(
  tx: Tx, projectId: string, parentRunId: string, childRunId: string,
  ids: Record<string, string>, options: PackagingCloneOptions = {},
): Promise<ClonedPackagingRun[]> {
  const runs = await tx.effectPackagingRun.findMany({
    where: {
      projectId, workflowRunId: parentRunId, status: 'COMPLETED',
      ...(options.templateIds ? { templateId: { in: [...options.templateIds] } } : {}),
    },
    include: { items: { include: { files: true } } },
  });
  const cloned = runs.filter((run) =>
    run.items.some((item) => !options.variantIds || options.variantIds.has(item.variantId)));
  if (!cloned.length) return runs;
  const snapshotIds = options.snapshotIds ?? ids;
  const prefix = options.keyPrefix ?? 'manual';
  const runRows: Prisma.EffectPackagingRunCreateManyInput[] = cloned.map((source) => {
    const id = randomUUID();
    ids[source.id] = id;
    return { id, projectId, workflowRunId: childRunId, templateId: source.templateId,
      idempotencyKey: `${prefix}:${childRunId}:package:${source.id}`,
      requestHash: source.requestHash, status: 'COMPLETED',
      completedAt: source.completedAt, startedAt: source.startedAt };
  });
  const itemRows: Prisma.EffectPackagingItemCreateManyInput[] = [];
  const fileRows: Prisma.EffectPackagingFileCreateManyInput[] = [];
  for (const source of cloned) {
    for (const item of source.items.filter((entry) => entry.status === 'COMPLETED' &&
      (!options.variantIds || options.variantIds.has(entry.variantId)))) {
      const id = randomUUID();
      itemRows.push({ id, projectId, runId: ids[source.id]!, variantId: item.variantId,
        name: item.name, shardIndex: item.shardIndex,
        sourceTimelineHash: item.sourceTimelineHash,
        snapshot: json(remapIds(item.snapshot, snapshotIds)), status: 'COMPLETED',
        stage: item.stage, checkpoint: json(remapIds(item.checkpoint, snapshotIds)),
        startedAt: item.startedAt, completedAt: item.completedAt });
      ids[item.id] = id;
      for (const file of item.files) fileRows.push({ projectId, itemId: id,
        fileObjectId: file.fileObjectId, role: file.role });
    }
  }
  await tx.effectPackagingRun.createMany({ data: runRows });
  if (itemRows.length) await tx.effectPackagingItem.createMany({ data: itemRows });
  if (fileRows.length) await tx.effectPackagingFile.createMany({ data: fileRows });
  return runs;
}

/** Second pass: re-point cloned packaging snapshots at cloned artifacts and files. */
export async function remapClonedPackagingRunsInTransaction(
  tx: Tx, projectId: string, runs: readonly ClonedPackagingRun[],
  ids: Record<string, string>,
): Promise<void> {
  for (const run of runs) {
    const copyRunId = ids[run.id];
    if (!copyRunId) continue;
    for (const item of run.items) {
      const copyItemId = ids[item.id];
      if (!copyItemId) continue;
      await tx.effectPackagingItem.update({ where: { id: copyItemId }, data: {
        snapshot: json(remapIds(item.snapshot, ids)),
        checkpoint: json(remapIds(item.checkpoint, ids)),
      } });
    }
  }
}
