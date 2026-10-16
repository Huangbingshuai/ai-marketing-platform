import { randomUUID } from 'node:crypto';
import { Prisma } from '../../generated/prisma/client';

type Tx = Prisma.TransactionClient;

const json = (value: unknown): Prisma.InputJsonValue =>
  (value === undefined || value === null ? {} : value) as Prisma.InputJsonValue;

/** A nullable Json column takes `DbNull`, never a plain `null`. */
const nullableJson = (
  value: unknown,
  ids: Record<string, string>,
): Prisma.InputJsonValue | typeof Prisma.DbNull =>
  value === null || value === undefined
    ? Prisma.DbNull
    : (remapIds(value, ids) as Prisma.InputJsonValue);

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
  tx: Tx,
  projectId: string,
  parentRunId: string,
  childRunId: string,
  ids: Record<string, string>,
  options: PackagingCloneOptions = {},
): Promise<ClonedPackagingRun[]> {
  const runs = await tx.effectPackagingRun.findMany({
    where: {
      projectId,
      workflowRunId: parentRunId,
      items: { some: { status: 'COMPLETED' } },
      ...(options.templateIds ? { templateId: { in: [...options.templateIds] } } : {}),
    },
    include: { items: { include: { files: true } } },
  });
  const cloned = runs.filter((run) =>
    run.items.some(
      (item) =>
        item.status === 'COMPLETED' &&
        (!options.variantIds || options.variantIds.has(item.variantId)),
    ),
  );
  if (!cloned.length) return runs;
  const snapshotIds = options.snapshotIds ?? ids;
  const prefix = options.keyPrefix ?? 'manual';
  const runRows: Prisma.EffectPackagingRunCreateManyInput[] = cloned.map((source) => {
    const id = randomUUID();
    ids[source.id] = id;
    return {
      id,
      projectId,
      workflowRunId: childRunId,
      templateId: source.templateId,
      idempotencyKey: `${prefix}:${childRunId}:package:${source.id}`,
      requestHash: source.requestHash,
      status: 'COMPLETED',
      completedAt: source.completedAt,
      startedAt: source.startedAt,
      createdAt: source.createdAt,
    };
  });
  const itemRows: Prisma.EffectPackagingItemCreateManyInput[] = [];
  const fileRows: Prisma.EffectPackagingFileCreateManyInput[] = [];
  for (const source of cloned) {
    for (const item of source.items.filter(
      (entry) =>
        entry.status === 'COMPLETED' &&
        (!options.variantIds || options.variantIds.has(entry.variantId)),
    )) {
      const id = randomUUID();
      itemRows.push({
        id,
        projectId,
        runId: ids[source.id]!,
        variantId: item.variantId,
        name: item.name,
        shardIndex: item.shardIndex,
        sourceTimelineHash: item.sourceTimelineHash,
        snapshot: json(remapIds(item.snapshot, snapshotIds)),
        status: 'COMPLETED',
        stage: item.stage,
        checkpoint: json(remapIds(item.checkpoint, snapshotIds)),
        startedAt: item.startedAt,
        completedAt: item.completedAt,
      });
      ids[item.id] = id;
      for (const file of item.files)
        fileRows.push({ projectId, itemId: id, fileObjectId: file.fileObjectId, role: file.role });
    }
  }
  await tx.effectPackagingRun.createMany({ data: runRows });
  if (itemRows.length) await tx.effectPackagingItem.createMany({ data: itemRows });
  if (fileRows.length) await tx.effectPackagingFile.createMany({ data: fileRows });
  return runs;
}

/**
 * A fork carries the fill runs that produced the pool it shows, so an inherited row must be
 * recognisable: the run that copied it never ran the fill itself, and the version tree counts what
 * a branch really did. Real keys are client uuids, so the namespace can never collide with one.
 */
export const inheritedFillKey = (childRunId: string, sourceId: string): string =>
  `inherit:${childRunId}:mix:${sourceId}`;

export const isInheritedFillKey = (idempotencyKey: string): boolean =>
  idempotencyKey.startsWith('inherit:');

/**
 * Copy the completed mix fill runs of a parent Run into a branch.
 *
 * The workspace reads its AI 归槽 pool — the classification chips and per-material match scores —
 * from the fill runs of the Run it is looking at, so a branch that kept the clips but not the runs
 * fell back to the material library as it looked before the fill. The frozen snapshot and the
 * classification name material artifacts by id, so they are re-written with the map the artifacts
 * themselves were cloned under; a run whose materials the branch could not carry is dropped by the
 * workspace's own validation instead of showing a pool that no longer matches the library.
 *
 * Only the newest rows the workspace can see are copied, so a Run with a long fill history does not
 * grow a second copy of all of it on every fork.
 */
export async function cloneMixAiRunsInTransaction(
  tx: Tx,
  projectId: string,
  sourceRunId: string,
  childRunId: string,
  ids: Record<string, string>,
): Promise<void> {
  const runs = await tx.effectTemplateMixAiRun.findMany({
    where: { projectId, workflowRunId: sourceRunId, status: 'COMPLETED' },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: 20,
  });
  if (!runs.length) return;
  const rows: Prisma.EffectTemplateMixAiRunCreateManyInput[] = runs.map((source) => ({
    projectId,
    workflowRunId: childRunId,
    templateId: source.templateId,
    targetVariantId: source.targetVariantId,
    outputVariantId: source.outputVariantId,
    idempotencyKey: inheritedFillKey(childRunId, source.id),
    requestHash: source.requestHash,
    inputHash: source.inputHash,
    inputSnapshot: json(remapIds(source.inputSnapshot, ids)),
    classificationResult: nullableJson(source.classificationResult, ids),
    selectionResult: nullableJson(source.selectionResult, ids),
    samplingResult: nullableJson(source.samplingResult, ids),
    trimResult: nullableJson(source.trimResult, ids),
    expectedDraftRevision: source.expectedDraftRevision,
    templateEditVersion: source.templateEditVersion,
    status: 'COMPLETED',
    stage: source.stage,
    progress: 100,
    completedAt: source.completedAt,
    createdAt: source.createdAt,
  }));
  await tx.effectTemplateMixAiRun.createMany({ data: rows });
}

/** Second pass: re-point cloned packaging snapshots at cloned artifacts and files. */
export async function remapClonedPackagingRunsInTransaction(
  tx: Tx,
  projectId: string,
  runs: readonly ClonedPackagingRun[],
  ids: Record<string, string>,
): Promise<void> {
  for (const run of runs) {
    const copyRunId = ids[run.id];
    if (!copyRunId) continue;
    for (const item of run.items) {
      const copyItemId = ids[item.id];
      if (!copyItemId) continue;
      await tx.effectPackagingItem.update({
        where: { id: copyItemId },
        data: {
          snapshot: json(remapIds(item.snapshot, ids)),
          checkpoint: json(remapIds(item.checkpoint, ids)),
        },
      });
    }
  }
}
