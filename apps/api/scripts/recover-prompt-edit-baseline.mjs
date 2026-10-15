// Explicit, revision-fenced recovery of an accidentally stale editing baseline. Dry-run by default.
import { createRequire } from 'node:module';
import { loadEnvFile } from 'node:process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { deepStrictEqual } from 'node:assert';

const stable = (value) =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
      : item,
  );
const same = (a, b) => stable(a) === stable(b);
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

/** Three-way merge by stable identity, never by numbering, keywords or semantic similarity. */
export function rebasePromptItems(base, saved, adopted) {
  for (const items of [base, saved, adopted])
    assert(new Set(items.map((item) => item.id)).size === items.length, 'Duplicate item identity');
  const before = new Map(base.map((item) => [item.id, item]));
  const after = new Map(saved.map((item) => [item.id, item]));
  const current = new Map(adopted.map((item) => [item.id, item]));
  const deleted = base.filter((item) => !after.has(item.id));
  const edited = saved.filter((item) => before.has(item.id) && !same(item, before.get(item.id)));
  const added = saved.filter((item) => !before.has(item.id));
  for (const item of [...deleted, ...edited]) {
    assert(current.has(item.id), `Missing merge target: ${item.id}`);
    assert(
      same(current.get(item.id), before.get(item.id)) ||
        same(current.get(item.id), after.get(item.id)),
      `Concurrent item change: ${item.id}`,
    );
  }
  const removed = new Set(deleted.map((item) => item.id));
  const patches = new Map(edited.map((item) => [item.id, item]));
  const items = adopted
    .filter((item) => !removed.has(item.id))
    .map((item) => patches.get(item.id) ?? item);
  const codes = new Set(items.map((item) => item.code));
  let counter = Math.max(
    0,
    ...[...adopted, ...base, ...saved].map((item) =>
      /^P\d+$/.test(item.code) ? Number(item.code.slice(1)) : 0,
    ),
  );
  const newItems = added.map((item) => {
    assert(!current.has(item.id), `Concurrent addition: ${item.id}`);
    const code = codes.has(item.code) ? `P${String(++counter).padStart(3, '0')}` : item.code;
    codes.add(code);
    return { ...item, code };
  });
  return { items: [...items, ...newItems], added: newItems, edited, deleted };
}

async function main() {
  try {
    loadEnvFile(resolve(import.meta.dirname, '../../../.env'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const require = createRequire(import.meta.url);
  const { ConfigService } = require('@nestjs/config');
  const { PrismaService } = require('../dist-dev/database/prisma.service.js');
  const {
    WorkflowWorkingRepository,
  } = require('../dist-dev/platform/workflow/workflow-working.repository.js');
  const {
    EffectPromptRepository,
  } = require('../dist-dev/workflows/effect/prompt-generation/effect-prompt.repository.js');
  const {
    recomputePromptQuality,
    parseEffectPromptBatchResult,
  } = require('../dist-dev/workflows/effect/prompt-generation/effect-prompt.quality.js');
  const {
    renderPromptUpdateKind,
  } = require('../dist-dev/workflows/effect/segment-render/effect-segment-render-prompt-update.js');
  const args = process.argv.slice(2);
  const [
    projectId,
    artifactId,
    baseRevision,
    expectedRevision,
    sourceArtifactId,
    sourceRevision,
    resultRevision,
  ] = args;
  assert(
    projectId &&
      artifactId &&
      sourceArtifactId &&
      [baseRevision, expectedRevision, sourceRevision, resultRevision].every((value) =>
        /^\d+$/.test(value ?? ''),
      ),
    'Required: projectId artifactId baseRevision expectedRevision sourceArtifactId sourceRevision resultRevision [--apply]',
  );
  const apply = args.includes('--apply');
  const rollback = new Error('RECOVERY_DRY_RUN');
  const db = new PrismaService(new ConfigService({ DATABASE_URL: process.env.DATABASE_URL }));
  try {
    await db.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "projects" WHERE "id"=${projectId}::uuid FOR UPDATE`;
        const target = await tx.workingArtifact.findFirstOrThrow({
          where: { projectId, id: artifactId, nodeId: 'PROMPT_GENERATION' },
          include: { dependencies: true },
        });
        const active = await tx.workflowRun.findFirstOrThrow({
          where: { projectId, activeKey: 'ACTIVE', workflow: 'EFFECT', workflowSpace: 'EFFECT' },
        });
        assert(
          active.id === target.workflowRunId && !active.editSessionNodeId,
          'Active workspace changed or editing',
        );
        assert(target.revision === Number(expectedRevision), 'Target revision changed');
        const source = await tx.workingArtifact.findFirstOrThrow({
          where: {
            projectId,
            id: sourceArtifactId,
            nodeId: 'PROMPT_GENERATION',
            revision: Number(sourceRevision),
            availability: 'AVAILABLE',
            freshness: 'CURRENT',
          },
        });
        const baseline = await tx.workingArtifactRevisionSnapshot.findFirstOrThrow({
          where: {
            projectId,
            workingArtifactId: artifactId,
            revision: Number(baseRevision),
          },
        });
        const result = await tx.effectPromptResult.findFirstOrThrow({
          where: { projectId, id: target.sourceArtifactId },
          include: { run: true },
        });
        assert(
          result.revision === Number(resultRevision) &&
            result.workflowRunId === target.workflowRunId,
          'Result revision changed',
        );
        const sourceResult = await tx.effectPromptResult.findFirstOrThrow({
          where: { projectId, id: source.sourceArtifactId },
        });
        const batch = await tx.effectSegmentRenderBatch.findFirstOrThrow({
          where: {
            projectId,
            workflowRunId: target.workflowRunId,
            sourcePromptArtifactId: source.id,
            sourcePromptRevision: source.revision,
            sourcePromptHash: source.contentHash,
            archivedAt: null,
            committedAt: { not: null },
          },
          include: { tasks: true },
          orderBy: { createdAt: 'desc' },
        });
        assert(
          batch.tasks.every((task) => !['QUEUED', 'RUNNING', 'REPAIRING'].includes(task.status)),
          'Render tasks active',
        );
        assert(
          (await tx.effectPromptRun.count({
            where: { projectId, status: { in: ['QUEUED', 'RUNNING'] } },
          })) === 0,
          'Prompt task active',
        );
        const beforeOutbox = await tx.jobOutbox.count({ where: { projectId } });
        const beforeRender = stable(batch);
        const previous = parseEffectPromptBatchResult(baseline.snapshot.payload);
        const saved = parseEffectPromptBatchResult(target.payload);
        const adopted = parseEffectPromptBatchResult(source.payload);
        assert(previous && saved && adopted, 'Invalid Prompt snapshots');
        deepStrictEqual(result.draftResult, target.payload);
        for (const key of ['settings', 'renderProfile', 'sharedPrompt']) {
          assert(
            same(previous[key], saved[key]) && same(saved[key], adopted[key]),
            `Non-item change: ${key}`,
          );
        }
        const merged = rebasePromptItems(previous.items, saved.items, adopted.items);
        // This incident is explicitly authorized for exactly one addition, deletion and edit.
        assert(
          merged.added.length === 1 && merged.deleted.length === 1 && merged.edited.length === 1,
          'Expected three-item recovery scope changed',
        );
        const overrides = structuredClone(sourceResult.manualOverrides);
        const deletedIds = new Set(merged.deleted.map((item) => item.id));
        overrides.added = [
          ...overrides.added.filter((item) => !deletedIds.has(item.id)),
          ...merged.added,
        ];
        overrides.deleted = [...new Set([...overrides.deleted, ...deletedIds])];
        for (const item of merged.edited)
          overrides.edited[item.id] = result.manualOverrides.edited[item.id];
        for (const id of deletedIds) delete overrides.edited[id];
        const restored = recomputePromptQuality(
          merged.items,
          saved.settings,
          saved.metrics,
          saved.renderProfile,
          saved.sharedPrompt,
        );
        deepStrictEqual(restored.metrics.semanticEvaluation, saved.metrics.semanticEvaluation);
        assert(parseEffectPromptBatchResult(restored), 'Recovered Prompt contract invalid');
        const scoped = new Proxy(tx, {
          get(target, key) {
            return key === '$transaction' ? (fn) => fn(tx) : Reflect.get(target, key);
          },
        });
        const working = new WorkflowWorkingRepository(scoped);
        const repository = new EffectPromptRepository(scoped, working);
        // Use the ordinary isolated manual-edit lifecycle, not a batch-generation confirmation
        // (which would intentionally publish a new branch instead of repairing this head).
        const edit = await working.beginEffectNodeEditInTransaction(
          tx,
          projectId,
          target.workflowRunId,
          'PROMPT_GENERATION',
          'MANUAL',
        );
        assert(edit?.created, 'Could not open an isolated recovery editor');
        const childProductId = edit.productIdMap[result.productId];
        const childArtifact = await tx.workingArtifact.findFirstOrThrow({
          where: {
            projectId,
            workflowRunId: edit.runId,
            nodeId: 'PROMPT_GENERATION',
            artifactKey: `prompt-batch:${childProductId}`,
          },
          include: { dependencies: true },
        });
        const childResult = await tx.effectPromptResult.findFirstOrThrow({
          where: {
            projectId,
            id: childArtifact.sourceArtifactId,
          },
        });
        const childInsight = childArtifact.dependencies.find(
          ({ sourceNodeId }) => sourceNodeId === 'INFORMATION_EXTRACTION',
        );
        const originalInsight = target.dependencies.find(
          ({ sourceNodeId }) => sourceNodeId === 'INFORMATION_EXTRACTION',
        );
        assert(childInsight && originalInsight, 'Insight mapping missing');
        const remap = (value) => {
          let serialized = JSON.stringify(value);
          for (const [before, after] of Object.entries({
            [target.workflowRunId]: edit.runId,
            [result.productId]: childProductId,
            [originalInsight.sourceArtifactId]: childInsight.sourceArtifactId,
            [originalInsight.sourceHash]: childInsight.sourceHash,
          }))
            serialized = serialized.replaceAll(before, after);
          return JSON.parse(serialized);
        };
        await tx.effectPromptResult.update({
          where: { id: childResult.id },
          data: {
            draftResult: remap(restored),
            manualOverrides: remap(overrides),
            revision: { increment: 1 },
            savedAt: new Date(),
          },
        });
        const committed = await repository.commitValidatedResult(
          projectId,
          childResult.id,
          childResult.revision + 1,
          {
            kind: target.kind,
            name: target.name,
            directory: target.directory,
            type: target.type,
            tags: target.tags,
            payload: remap(restored),
            metadata: {
              productId: childProductId,
              qualityStatus: restored.qualityStatus,
              baselineRecovery: {
                originalRevision: target.revision,
                baseRevision: baseline.revision,
                adoptedArtifactId: source.id,
                adoptedRevision: source.revision,
              },
            },
            sourceRunId: childResult.runId,
            sourceArtifactId: childResult.id,
            expectedRevision: childArtifact.revision,
            dependencies: childArtifact.dependencies.map(
              ({
                sourceType,
                sourceNodeId,
                sourceArtifactId,
                sourceKey,
                sourceRevision,
                sourceHash,
              }) => ({
                sourceType,
                sourceNodeId,
                sourceArtifactId,
                sourceKey,
                sourceRevision,
                sourceHash,
              }),
            ),
          },
        );
        assert(committed.kind === 'COMMITTED', `Recovery commit failed: ${committed.kind}`);
        const confirmed = await tx.workingArtifact.findUniqueOrThrow({ where: { id: artifactId } });
        const latest = parseEffectPromptBatchResult(confirmed.payload);
        assert(
          latest && confirmed.revision === target.revision + 1,
          'Recovery confirmation mismatch',
        );
        const tasks = batch.tasks.filter((task) => task.errorCode !== 'MATERIAL_DELETED');
        const kinds = tasks
          .map((task) => ({
            code: task.promptCode,
            kind: renderPromptUpdateKind(task.requestSnapshot, latest),
          }))
          .filter((item) => item.kind);
        const additions = latest.items.filter(
          (item) => !batch.tasks.some((task) => task.promptId === item.id),
        );
        deepStrictEqual(kinds.map(({ kind }) => kind).sort(), ['REMOVE', 'RENDER']);
        assert(additions.length === 1, 'Recovery generated unexpected additions');
        assert(
          (await tx.jobOutbox.count({ where: { projectId } })) === beforeOutbox,
          'Unexpected Outbox writes',
        );
        deepStrictEqual(
          await tx.effectSegmentRenderBatch
            .findUniqueOrThrow({ where: { id: batch.id }, include: { tasks: true } })
            .then(stable),
          beforeRender,
        );
        console.log(
          JSON.stringify({
            mode: apply ? 'APPLIED' : 'DRY_RUN',
            artifactId,
            revision: confirmed.revision,
            count: latest.items.length,
            differences: kinds,
            additions: additions.map(({ id, code }) => ({ id, code })),
            outboxAdded: 0,
            semanticDuplicateRate: latest.metrics.semanticEvaluation.duplicateRate,
          }),
        );
        if (!apply) throw rollback;
      },
      { timeout: 120_000 },
    );
  } catch (error) {
    if (error !== rollback) throw error;
  } finally {
    await db.$disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
