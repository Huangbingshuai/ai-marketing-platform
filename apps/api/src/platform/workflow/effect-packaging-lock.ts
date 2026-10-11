import { ConflictException } from '@nestjs/common';
import type { EffectTemplateMixDraft, PackagingSnapshot } from '@ai-marketing/contracts';
import type { Prisma } from '../../generated/prisma/client';
import { workflowStateHash } from './workflow-state-hash';

export async function activePackagingItems(tx: Prisma.TransactionClient, projectId: string, workflowRunId: string) {
  return tx.effectPackagingItem.findMany({ where: { projectId, status: { in: ['QUEUED', 'RUNNING'] },
    run: { status: { in: ['QUEUED', 'RUNNING'] }, OR: [{ workflowRunId },
      { workflowRun: { parentWorkflowRunId: workflowRunId, forkNodeId: 'TEMPLATE_MIX' } }] },
  }, select: { variantId: true, snapshot: true, run: { select: { templateId: true } } } });
}

/** Called under the node row lock also held by packaging creation/commit. */
export async function assertPackagingDraftEditable(tx: Prisma.TransactionClient, projectId: string,
  workflowRunId: string, before: unknown, after: unknown) {
  const previous = before as EffectTemplateMixDraft;
  const next = after as EffectTemplateMixDraft;
  for (const item of await activePackagingItems(tx, projectId, workflowRunId)) {
    if (!(item.snapshot as unknown as PackagingSnapshot).operation) continue;
    const oldEntry = previous.templates.find((entry) => entry.id === item.run.templateId);
    const entry = next.templates.find((entry) => entry.id === item.run.templateId);
    const oldVariant = oldEntry?.workspace.variants.find((variant) => variant.id === item.variantId);
    const variant = entry?.workspace.variants.find((variant) => variant.id === item.variantId);
    if (!oldEntry || !entry || !oldVariant || !variant ||
        workflowStateHash(oldEntry.workspace.template) !== workflowStateHash(entry.workspace.template) ||
        workflowStateHash(oldVariant) !== workflowStateHash(variant))
      throw new ConflictException('当前成片正在包装，完成后自动解锁');
  }
}
