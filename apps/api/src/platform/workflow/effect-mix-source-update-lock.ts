import type { EffectTemplateMixDraft, FinalOutputSnapshot } from '@ai-marketing/contracts';
import { ConflictException } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import { workflowStateHash } from './workflow-state-hash';

/** Serialize editor saves with source-refresh start/commit, not independent background exports. */
export async function lockMixNodeForSourceUpdate(
  tx: Prisma.TransactionClient,
  projectId: string,
  workflowRunId: string,
): Promise<void> {
  await tx.$queryRaw`SELECT id FROM workflow_node_states WHERE "projectId"=${projectId}::uuid AND "workflowRunId"=${workflowRunId}::uuid AND "nodeId"='TEMPLATE_MIX' FOR UPDATE`;
}

export async function activeMixSourceUpdates(
  tx: Prisma.TransactionClient,
  projectId: string,
  workflowRunId: string,
): Promise<NonNullable<FinalOutputSnapshot['sourceRefresh']>[]> {
  const items = await tx.effectFinalOutputItem.findMany({
    where: {
      projectId,
      status: { in: ['QUEUED', 'RUNNING'] },
      run: { workflowRunId, status: { in: ['QUEUED', 'RUNNING'] } },
    },
    select: { snapshot: true },
  });
  return items.flatMap((item) => {
    const refresh = (item.snapshot as unknown as FinalOutputSnapshot).sourceRefresh;
    return refresh?.workflowRunId === workflowRunId ? [refresh] : [];
  });
}

export function assertMixSourceUpdateDraftEditable(
  before: unknown,
  after: unknown,
  updates: Awaited<ReturnType<typeof activeMixSourceUpdates>>,
): void {
  const previous = before as EffectTemplateMixDraft | undefined;
  const next = after as EffectTemplateMixDraft | undefined;
  for (const update of updates) {
    const oldEntry = previous?.templates?.find((entry) => entry.id === update.templateId);
    const entry = next?.templates?.find((entry) => entry.id === update.templateId);
    const oldVariant = oldEntry?.workspace.variants.find(
      (variant) => variant.id === update.baselineVariant.id,
    );
    const variant = entry?.workspace.variants.find(
      (variant) => variant.id === update.baselineVariant.id,
    );
    if (
      !oldEntry ||
      !entry ||
      !oldVariant ||
      !variant ||
      workflowStateHash(oldEntry.workspace.template) !==
        workflowStateHash(entry.workspace.template) ||
      workflowStateHash(oldVariant) !== workflowStateHash(variant)
    )
      throw new ConflictException('局部更新正在进行，对应成片工程暂时不能编辑；任务结束后自动解锁');
  }
}
