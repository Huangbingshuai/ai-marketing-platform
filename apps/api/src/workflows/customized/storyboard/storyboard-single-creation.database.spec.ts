import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { expect, it } from 'vitest';
import { emptyCustomizedBrief, type StoryboardInput } from '@ai-marketing/contracts';
import { PrismaService } from '../../../database/prisma.service';
import { WorkflowWorkingRepository } from '../../../platform/workflow/workflow-working.repository';
import { workflowStateHash } from '../../../platform/workflow/workflow-state-hash';
import { StoryboardRepository } from './storyboard.repository';
import { customizedScope } from '../../../platform/workflow/customized-branches';

it.skipIf(process.env.CUSTOMIZED_STORYBOARD_DATABASE_TEST !== '1')(
  'creates one from legacy settings, freezes same-type confirmed history, and preserves old idempotent batches',
  async () => {
    const db = new PrismaService(
      new ConfigService({
        DATABASE_URL:
          process.env.DATABASE_URL ??
          'postgresql://postgres:postgres@localhost:5432/ai_marketing?schema=public',
      }),
    );
    const working = new WorkflowWorkingRepository(db),
      repo = new StoryboardRepository(db, working);
    const projectId = randomUUID();
    // No paid consumer can see these controlled tasks.
    Object.defineProperty(repo, 'enqueue', { value: async () => undefined });
    try {
      await db.project.create({ data: { id: projectId, name: '单份创作与历史避重隔离测试' } });
      const root = await working.initializeCustomizedRun(projectId);
      const brief = {
        ...emptyCustomizedBrief(),
        productName: '测试产品',
        sellingPoints: ['资料依据'],
      };
      await db.workingArtifact.create({
        data: {
          projectId,
          workflowRunId: root.id,
          nodeId: 'INFORMATION_EXTRACTION',
          artifactKey: 'customized-brief',
          name: '信息卡',
          kind: 'STRUCTURED',
          directory: 'INSIGHTS',
          type: 'INSIGHT_RESULT',
          payload: brief,
          contentHash: workflowStateHash(brief),
        },
      });
      const legacySettings = {
        videoType: 'DRAMA' as const,
        variantCount: 5,
        targetDurationSeconds: 60,
        structureMode: 'AI' as const,
        structure: '',
        instructions: '',
      };
      await db.workflowNodeState.create({
        data: {
          projectId,
          workflowRunId: root.id,
          nodeId: 'STORYBOARD_SETTINGS',
          schemaVersion: 1,
          state: { settings: legacySettings },
          contentHash: workflowStateHash(legacySettings),
        },
      });
      const state = await repo.workspace(projectId, root.id);
      expect(state.settings.variantCount).toBe(1);
      // Viewing does not rewrite stored historical settings.
      expect(
        (
          await db.workflowNodeState.findFirstOrThrow({
            where: { projectId, nodeId: 'STORYBOARD_SETTINGS' },
          })
        ).state,
      ).toMatchObject({ settings: { variantCount: 5 } });
      const older = await db.workflowRun.create({
        data: {
          ...customizedScope(projectId),
          currentNodeId: 'STORYBOARD',
          status: 'PAUSED',
          activeKey: null,
        },
      });
      const expected: string[] = [];
      for (const [videoType, confirmed] of [
        ['DRAMA', true],
        ['BRAND_AD', true],
        ['DRAMA', false],
      ] as const) {
        const id = randomUUID();
        const draft = {
          id,
          name: `${videoType}-${confirmed}`,
          synopsis: '已有事件与结尾完整保留作软参考',
          structure: '',
          productFocus: '',
          shots: [],
          assets: [],
          creation: { videoType, referenceDurationSeconds: 60, structureSections: [] },
        };
        await db.customizedStoryboardScript.create({
          data: {
            id,
            projectId,
            sourceRunId: older.id,
            workflowRunId: older.id,
            origin: 'MANUAL',
            status: 'COMPLETED',
            sourceSnapshot: {},
            draft,
          },
        });
        if (confirmed)
          await db.workingArtifact.create({
            data: {
              projectId,
              workflowRunId: older.id,
              nodeId: 'STORYBOARD',
              artifactKey: `customized-script:${id}`,
              name: draft.name,
              kind: 'STRUCTURED',
              directory: 'SCRIPTS',
              type: 'STORYBOARD_SCRIPT',
              payload: draft,
              contentHash: workflowStateHash(draft),
            },
          });
        if (videoType === 'DRAMA' && confirmed) expected.push(id);
      }
      const key = randomUUID(),
        models = { creative: 'controlled', detail: 'controlled' };
      const task = await repo.create(projectId, root.id, state.settingsRevision, key, models);
      const row = await db.customizedStoryboardTask.findUniqueOrThrow({ where: { id: task.id } });
      const input = row.inputSnapshot as unknown as StoryboardInput;
      expect(input.settings.variantCount).toBe(1);
      expect(input.scriptIds).toHaveLength(1);
      expect(await db.customizedStoryboardScript.count({ where: { taskId: task.id } })).toBe(1);
      expect(input.existingConcepts.map((s) => s.scriptId)).toEqual(expected);
      // Explicit old snapshot: duplicate command must return it without recreating/normalizing it.
      const oldInput = {
        ...input,
        settings: { ...input.settings, variantCount: 3 },
        scriptIds: [...input.scriptIds, randomUUID(), randomUUID()],
      };
      await db.customizedStoryboardTask.update({
        where: { id: task.id },
        data: {
          inputSnapshot: JSON.parse(JSON.stringify(oldInput)),
          inputHash: workflowStateHash(oldInput),
        },
      });
      expect((await repo.create(projectId, root.id, state.settingsRevision, key, models)).id).toBe(
        task.id,
      );
      expect(
        (await db.customizedStoryboardTask.findUniqueOrThrow({ where: { id: task.id } }))
          .inputSnapshot,
      ).toMatchObject({ settings: { variantCount: 3 }, scriptIds: oldInput.scriptIds });
      await repo.settings(projectId, root.id, state.settingsRevision, {
        ...legacySettings,
        targetDurationSeconds: 45,
      });
      expect(
        (
          await db.workflowNodeState.findFirstOrThrow({
            where: { projectId, nodeId: 'STORYBOARD_SETTINGS' },
          })
        ).state,
      ).toMatchObject({ settings: { variantCount: 1, targetDurationSeconds: 45 } });
      expect(await db.jobOutbox.count({ where: { projectId } })).toBe(0);
    } finally {
      await db.workingArtifactDependency.deleteMany({ where: { projectId } });
      await db.project.deleteMany({ where: { id: projectId } });
      await db.$disconnect();
    }
  },
  30000,
);
