import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { expect, it } from 'vitest';
import {
  effectTemplateMixSourceChanges,
  type EffectTemplateMixDraft,
  type EffectTemplateMixRole,
} from '@ai-marketing/contracts';
import type { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { WorkflowWorkingRepository } from '../../../platform/workflow/workflow-working.repository';
import { WorkflowWorkingService } from '../../../platform/workflow/workflow-working.service';
import { workflowStateHash } from '../../../platform/workflow/workflow-state-hash';
import { EffectTemplateMixAiRepository } from './effect-template-mix-ai.repository';
import { EffectTemplateMixService } from './effect-template-mix.service';
import type { EffectTemplateMixAiSnapshot } from './effect-template-mix-ai.types';

// Real repository lifecycle, deterministic classifications/trims, all writes rolled back.
// No model/storage request or Outbox dispatch is performed.
it.skipIf(process.env.EFFECT_OUTPUT_DATABASE_TEST !== '1')(
  'fills a new template on a stale branch with the current ancestor file, without immediate pending updates',
  async () => {
    const db = new PrismaService(
      new ConfigService({
        DATABASE_URL:
          process.env.DATABASE_URL ??
          'postgresql://postgres:postgres@localhost:5432/ai_marketing?schema=public',
      }),
    );
    const rollback = new Error('CURRENT_FILL_SOURCE_ROLLBACK');
    try {
      await expect(
        db.$transaction(
          async (tx) => {
            const candidates = await tx.workflowRun.findMany({
              where: {
                workflow: 'EFFECT',
                workflowSpace: 'EFFECT',
                branchPublishedAt: { not: null },
                forkNodeId: 'TEMPLATE_MIX',
              },
              orderBy: { createdAt: 'desc' },
            });
            const scopedDb = new Proxy(tx, {
              get(target, key) {
                return key === '$transaction'
                  ? (fn: (client: Prisma.TransactionClient) => unknown) => fn(tx)
                  : Reflect.get(target, key);
              },
            }) as unknown as PrismaService;
            const working = new WorkflowWorkingRepository(scopedDb);
            let fixture:
              | {
                  projectId: string;
                  runId: string;
                  latestId: string;
                  latestFile: string;
                  oldId: string;
                }
              | undefined;
            for (const run of candidates) {
              const sources = await working.listArtifacts(run.projectId, { workflowRunId: run.id });
              const latest = sources.find(
                (row) =>
                  row.nodeId === 'SEGMENT_RENDER' &&
                  row.artifactKey.startsWith('render-clip:') &&
                  row.freshness === 'CURRENT' &&
                  (row.metadata as { branchSourceOwner?: boolean } | null)?.branchSourceOwner ===
                    true &&
                  sources.some(
                    (old) =>
                      old.workflowRunId === run.id &&
                      old.freshness === 'STALE' &&
                      (old.payload as { promptId?: string } | null)?.promptId ===
                        (row.payload as { promptId?: string } | null)?.promptId,
                  ),
              );
              if (!latest) continue;
              const old = sources.find(
                (row) =>
                  row.workflowRunId === run.id &&
                  row.freshness === 'STALE' &&
                  (row.payload as { promptId?: string } | null)?.promptId ===
                    (latest.payload as { promptId?: string } | null)?.promptId,
              )!;
              fixture = {
                projectId: run.projectId,
                runId: run.id,
                latestId: latest.id,
                latestFile: (latest.payload as { fileObjectId: string }).fileObjectId,
                oldId: old.id,
              };
              break;
            }
            if (!fixture) throw new Error('CURRENT_FILL_SOURCE_FIXTURE_MISSING');
            const { projectId, runId, latestId, latestFile, oldId } = fixture;
            await tx.workflowRun.updateMany({
              where: {
                projectId,
                workflow: 'EFFECT',
                workflowSpace: 'EFFECT',
                activeKey: 'ACTIVE',
              },
              data: { activeKey: null },
            });
            await tx.workflowRun.update({ where: { id: runId }, data: { activeKey: 'ACTIVE' } });
            const node = await tx.workflowNodeState.findFirstOrThrow({
              where: { projectId, workflowRunId: runId, nodeId: 'TEMPLATE_MIX' },
            });
            const state = JSON.parse(JSON.stringify(node.state)) as EffectTemplateMixDraft;
            const roles: EffectTemplateMixRole[] = [
              'HOOK',
              'PAIN_POINT',
              'PRODUCT',
              'SELLING_POINT',
              'TRANSFORMATION',
              'END',
            ];
            const templateId = randomUUID();
            state.templates.push({
              id: templateId,
              workspace: {
                editVersion: 1,
                variants: [],
                template: {
                  name: '新模板最新来源回滚验收',
                  editVersion: 1,
                  slots: roles.map((role, index) => ({
                    id: `slot-${index}`,
                    role,
                    label: role,
                    purpose:
                      role === 'HOOK'
                        ? 'HOOK'
                        : role === 'END'
                          ? 'END_CONVERSION'
                          : role === 'PRODUCT'
                            ? 'PRODUCT_DISPLAY'
                            : 'EFFECT',
                    duration: 4,
                    transition: '硬切',
                  })),
                },
              },
            });
            await tx.workflowNodeState.update({
              where: { id: node.id },
              data: {
                state: JSON.parse(JSON.stringify(state)),
                contentHash: workflowStateHash(state),
                revision: { increment: 1 },
              },
            });
            const serviceWorking = new WorkflowWorkingService(
              working,
              { get: async () => ({ id: projectId }) } as never,
              {} as never,
            );
            const ai = new EffectTemplateMixAiRepository(scopedDb, working);
            const mix = new EffectTemplateMixService(serviceWorking, ai);
            const fill = await mix.createAiRun(
              projectId,
              runId,
              templateId,
              node.revision + 1,
              randomUUID(),
            );
            const created = await ai.find(projectId, fill.id);
            const snapshot = created!.inputSnapshot as unknown as EffectTemplateMixAiSnapshot;
            expect(snapshot.materials.some((source) => source.artifactId === oldId)).toBe(false);
            expect(
              snapshot.materials.find((source) => source.artifactId === latestId)?.fileObjectId,
            ).toBe(latestFile);
            const latest = snapshot.materials.find((source) => source.artifactId === latestId)!;
            const picked = [
              latest,
              ...snapshot.materials.filter((source) => source.id !== latest.id).slice(0, 5),
            ];
            expect(picked).toHaveLength(6);
            const claim = await mix.claimAiRun(projectId, fill.id);
            if (!('attemptToken' in claim) || !claim.attemptToken)
              throw new Error('FILL_CLAIM_FAILED');
            const classifications = snapshot.materials.map((source) => ({
              materialId: source.id,
              scores: Object.fromEntries(
                roles.map((role, index) => [role, picked[index]?.id === source.id ? 0.99 : 0]),
              ) as Record<EffectTemplateMixRole, number>,
              reasons: {},
            }));
            const matched = await mix.classifyAiRun(
              projectId,
              fill.id,
              claim.attemptToken,
              classifications,
            );
            expect(matched.selections.some((selection) => selection.materialId === latestId)).toBe(
              true,
            );
            expect(
              (await ai.selectedFile(projectId, fill.id, latestId, claim.attemptToken))?.artifact
                .id,
            ).toBe(latestId);
            const trims = matched.selections.map((selection) => ({
              ...selection,
              trimStartSeconds: 0,
              trimReason: '回滚验收截取',
            }));
            await mix.completeAiRun(projectId, fill.id, claim.attemptToken, trims);
            const workspace = await mix.workspace(projectId, fill.workflowRunId);
            const entry = workspace.draft.templates.find((item) => item.id === templateId)!;
            expect(entry.workspace.variants.length).toBeGreaterThan(0);
            expect(
              entry.workspace.variants.some((variant) =>
                Object.values(variant.bindings).includes(latestId),
              ),
            ).toBe(true);
            const sources = await mix.materialSources(projectId, fill.workflowRunId);
            expect(
              entry.workspace.variants.every(
                (variant) =>
                  effectTemplateMixSourceChanges(variant, sources.materials).length === 0,
              ),
            ).toBe(true);
            expect(
              workspace.commits.find((commit) => commit.templateId === templateId)?.stale,
            ).toBe(false);
            throw rollback;
          },
          { timeout: 120_000 },
        ),
      ).rejects.toBe(rollback);
    } finally {
      await db.$disconnect();
    }
  },
  130_000,
);
