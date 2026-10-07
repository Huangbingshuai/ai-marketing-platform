import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { expect, it } from 'vitest';
import { PrismaService } from '../../../database/prisma.service';
import { EffectTemplateMixAiRepository } from './effect-template-mix-ai.repository';
import { pendingAddedMaterials } from './effect-template-mix-incremental';

it.skipIf(process.env.EFFECT_OUTPUT_DATABASE_TEST !== '1')(
  'a parent APPEND never consumes additions for an already-created child',
  async () => {
    const db = new PrismaService(
      new ConfigService({
        DATABASE_URL:
          process.env.DATABASE_URL ??
          'postgresql://postgres:postgres@localhost:5432/ai_marketing?schema=public',
      }),
    );
    const rollback = new Error('INHERITANCE_TEST_ROLLBACK');
    try {
      await expect(
        db.$transaction(
          async (tx) => {
            const projectId = randomUUID(),
              parent = randomUUID(),
              oldChild = randomUUID(),
              newChild = randomUUID(),
              templateId = randomUUID();
            await tx.project.create({ data: { id: projectId, name: '分支归槽隔离回归' } });
            for (const [id, createdAt] of [
              [parent, '2026-10-01T00:00:00Z'],
              [oldChild, '2026-10-03T00:00:00Z'],
              [newChild, '2026-10-05T00:00:00Z'],
            ])
              await tx.workflowRun.create({
                data: {
                  id: id!,
                  projectId,
                  workflow: 'EFFECT',
                  workflowSpace: 'EFFECT',
                  createdAt: new Date(createdAt!),
                  activeKey: id === parent ? 'ACTIVE' : null,
                  ...(id === parent
                    ? {}
                    : { parentWorkflowRunId: parent, forkNodeId: 'TEMPLATE_MIX' }),
                },
              });
            const common = {
              projectId,
              workflowRunId: parent,
              templateId,
              requestHash: 'a'.repeat(64),
              inputHash: 'b'.repeat(64),
              expectedDraftRevision: 1,
              templateEditVersion: 1,
              status: 'COMPLETED' as const,
              stage: 'COMPLETED' as const,
              outputVariantId: randomUUID(),
            };
            const baseline = await tx.effectTemplateMixAiRun.create({
              data: {
                ...common,
                idempotencyKey: randomUUID(),
                completedAt: new Date('2026-10-02T00:00:00Z'),
                createdAt: new Date('2026-10-01T01:00:00Z'),
                inputSnapshot: { materials: [{ id: 'old', promptId: 'original' }] },
              },
            });
            const append = await tx.effectTemplateMixAiRun.create({
              data: {
                ...common,
                idempotencyKey: randomUUID(),
                completedAt: new Date('2026-10-04T00:00:00Z'),
                createdAt: new Date('2026-10-04T00:00:00Z'),
                inputSnapshot: {
                  incremental: { materialIds: ['new'] },
                  materials: [
                    { id: 'old', promptId: 'original' },
                    { id: 'new', promptId: 'added' },
                  ],
                },
                selectionResult: [{ materialId: 'new' }],
              },
            });
            const trims: string[] = [];
            for (let index = 0; index < 25; index++) {
              const createdAt = new Date(new Date('2026-10-04T01:00:00Z').getTime() + index * 1000);
              const trim = await tx.effectTemplateMixAiRun.create({ data: {
                ...common, idempotencyKey: randomUUID(), createdAt, completedAt: createdAt,
                inputSnapshot: { trimOnly: true, materials: [{ id: 'old', promptId: 'original' }] },
                selectionResult: [{ materialId: 'old' }],
              } });
              trims.unshift(trim.id);
            }
            const repository = new EffectTemplateMixAiRepository(tx as unknown as PrismaService);
            const oldHistory = await repository.inheritedMixAiRuns(projectId, oldChild);
            const newHistory = await repository.inheritedMixAiRuns(projectId, newChild);
            expect(oldHistory.map((run) => run.id)).toEqual([baseline.id]);
            expect(newHistory.map((run) => run.id)).toEqual([...trims, append.id, baseline.id]);
            expect(await repository.listRecent(projectId, parent)).toHaveLength(20);
            const localHistory = await repository.listHistory(projectId, parent);
            expect(localHistory).toHaveLength(27);
            const materials = [
              { id: 'old', sourcePromptId: 'original', available: true },
              { id: 'new', sourcePromptId: 'added', available: true },
            ];
            expect(pendingAddedMaterials(templateId, materials, oldHistory)).toEqual(['new']);
            expect(pendingAddedMaterials(templateId, materials, newHistory)).toEqual([]);
            expect(pendingAddedMaterials(templateId, materials, [append, baseline])).toEqual([]);
            const nextMaterials = [...materials, { id: 'next', sourcePromptId: 'next', available: true }];
            expect(pendingAddedMaterials(templateId, nextMaterials, localHistory)).toEqual(['next']);
            expect(pendingAddedMaterials(templateId, nextMaterials, newHistory)).toEqual(['next']);
            expect(await repository.inheritedMixAiRuns(randomUUID(), oldChild)).toEqual([]);
            throw rollback;
          },
          { timeout: 15000 },
        ),
      ).rejects.toBe(rollback);
    } finally {
      await db.$disconnect();
    }
  },
  20000,
);
