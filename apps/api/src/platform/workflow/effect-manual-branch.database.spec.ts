import { ConfigService } from '@nestjs/config';
import { expect, it } from 'vitest';
import { PrismaService } from '../../database/prisma.service';
import { createEffectManualBranchInTransaction } from './effect-manual-branch';

it.skipIf(process.env.EFFECT_EDIT_DATABASE_TEST !== '1')(
  'copies confirmed effect content into one active branch and reuses the idempotent result',
  async () => {
    const db = new PrismaService(
      new ConfigService({
        DATABASE_URL:
          process.env.DATABASE_URL ??
          'postgresql://postgres:postgres@localhost:5432/ai_marketing?schema=public',
      }),
    );
    const rollback = new Error('EFFECT_MANUAL_BRANCH_TEST_ROLLBACK');
    try {
      await expect(
        db.$transaction(
          async (tx) => {
            const candidate = await tx.workflowRun.findFirst({
              where: {
                workflow: 'EFFECT',
                workflowSpace: 'EFFECT',
                OR: [{ parentWorkflowRunId: null }, { branchPublishedAt: { not: null } }],
                workingArtifacts: { some: { nodeId: 'TEMPLATE_MIX', availability: 'AVAILABLE' } },
              },
              orderBy: { lastActiveAt: 'desc' },
            });
            expect(candidate).not.toBeNull();
            const parent = candidate!;
            await tx.workflowRun.updateMany({
              where: {
                projectId: parent.projectId,
                workflow: 'EFFECT',
                workflowSpace: 'EFFECT',
                activeKey: 'ACTIVE',
              },
              data: { activeKey: null },
            });
            await tx.workflowRun.update({
              where: { id: parent.id },
              data: { activeKey: 'ACTIVE' },
            });
            const before = await tx.workingArtifact.findMany({
              where: {
                projectId: parent.projectId,
                workflowRunId: parent.id,
                availability: 'AVAILABLE',
              },
              select: { nodeId: true, artifactKey: true, revision: true, contentHash: true },
            });
            expect(before.some((item) => item.nodeId === 'TEMPLATE_MIX')).toBe(true);
            const key = `test:${crypto.randomUUID()}`;
            const childId = await createEffectManualBranchInTransaction(
              tx,
              parent.projectId,
              parent.id,
              key,
            );
            expect(childId).toBeTruthy();
            expect(
              await createEffectManualBranchInTransaction(tx, parent.projectId, parent.id, key),
            ).toBe(childId);
            const child = await tx.workflowRun.findUniqueOrThrow({ where: { id: childId! } });
            expect(child.activeKey).toBe('ACTIVE');
            expect(child.forkNodeId).toBe('MANUAL_COPY');
            expect(child.branchPublishedAt).not.toBeNull();
            expect(
              (await tx.workflowRun.findUniqueOrThrow({ where: { id: parent.id } })).activeKey,
            ).toBeNull();
            const after = await tx.workingArtifact.findMany({
              where: {
                projectId: parent.projectId,
                workflowRunId: parent.id,
                availability: 'AVAILABLE',
              },
              select: { nodeId: true, artifactKey: true, revision: true, contentHash: true },
            });
            expect(after).toEqual(before);
            const copied = await tx.workingArtifact.findMany({
              where: {
                projectId: parent.projectId,
                workflowRunId: childId!,
                availability: 'AVAILABLE',
              },
              select: { nodeId: true, artifactKey: true, revision: true },
            });
            for (const source of before) {
              expect(
                copied.some(
                  (item) =>
                    item.nodeId === source.nodeId &&
                    item.revision === source.revision &&
                    (item.artifactKey === source.artifactKey ||
                      item.artifactKey.startsWith(source.artifactKey.split(':')[0]! + ':')),
                ),
              ).toBe(true);
            }
            throw rollback;
          },
          { timeout: 120_000 },
        ),
      ).rejects.toThrow(rollback.message);
    } finally {
      await db.$disconnect();
    }
  },
  130_000,
);
