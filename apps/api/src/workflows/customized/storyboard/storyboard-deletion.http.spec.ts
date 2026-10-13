import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ConfigService } from '@nestjs/config';
import { expect, it } from 'vitest';
import { emptyCustomizedBrief, type DeleteStoryboardScriptResult } from '@ai-marketing/contracts';
import { PrismaService } from '../../../database/prisma.service';
import { WorkflowWorkingRepository } from '../../../platform/workflow/workflow-working.repository';
import { customizedScope } from '../../../platform/workflow/customized-branches';
import { workflowStateHash } from '../../../platform/workflow/workflow-state-hash';
import { StoryboardRepository } from './storyboard.repository';

// Live local API, disposable database project only. No Outbox or model tasks are created.
it.skipIf(process.env.CUSTOMIZED_STORYBOARD_DELETE_HTTP_TEST !== '1')(
  'permanently deletes a script subtree through the live DELETE route',
  async () => {
    const env = await readFile(resolve(process.cwd(), '../../.env'), 'utf8');
    const setting = (name: string) =>
      process.env[name] ?? env.match(new RegExp(`^${name}=(.*)$`, 'm'))?.[1]?.trim();
    const db = new PrismaService(
      new ConfigService({
        DATABASE_URL:
          setting('DATABASE_URL') ??
          'postgresql://postgres:postgres@localhost:5432/ai_marketing?schema=public',
      }),
    );
    const projectId = randomUUID();
    try {
      await db.project.create({ data: { id: projectId, name: '脚本删除 HTTP 隔离测试' } });
      const working = new WorkflowWorkingRepository(db),
        repo = new StoryboardRepository(db, working);
      const root = await working.initializeCustomizedRun(projectId);
      const brief = {
        ...emptyCustomizedBrief(),
        productName: '测试杯',
        sellingPoints: ['握持舒适'],
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
      const id = randomUUID();
      const script = {
        id,
        name: 'HTTP 待删除脚本',
        synopsis: '隔离测试',
        structure: '',
        productFocus: '',
        shots: [],
      };
      const row = await repo.manual(projectId, root.id, script, 'MANUAL');
      const branch = await db.workflowRun.create({
        data: {
          ...customizedScope(projectId),
          parentWorkflowRunId: root.id,
          forkScriptId: id,
          forkNodeId: 'STORYBOARD',
          branchPublishedAt: new Date(),
          status: 'PAUSED',
          activeKey: null,
        },
      });
      const child = await db.workflowRun.create({
        data: {
          ...customizedScope(projectId),
          parentWorkflowRunId: branch.id,
          forkScriptId: id,
          forkNodeId: 'SHOT_PROMPT',
          branchPublishedAt: new Date(),
          status: 'PAUSED',
          activeKey: null,
        },
      });
      await db.customizedStoryboardScript.update({
        where: { id },
        data: { workflowRunId: branch.id, status: 'COMPLETED' },
      });
      const api = `http://localhost:${setting('API_PORT') ?? '3100'}/api/projects/${projectId}/workflows/customized/storyboard`;
      const treeUrl = `http://localhost:${setting('API_PORT') ?? '3100'}/api/projects/${projectId}/workflow-runs/customized/branches`;
      const warmTree = await fetch(treeUrl);
      expect(warmTree.status).toBe(200);
      await warmTree.json();
      const remove = (revision: number) =>
        fetch(`${api}/scripts/${id}`, {
          method: 'DELETE',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ workflowRunId: root.id, expectedRevision: revision }),
          signal: AbortSignal.timeout(15000),
        });
      expect((await remove(row.revision + 1)).status).toBe(409);
      const response = await remove(row.revision);
      expect(response.status).toBe(200);
      const result = ((await response.json()) as { data: DeleteStoryboardScriptResult }).data;
      expect(result.removedRunIds.sort()).toEqual([branch.id, child.id].sort());
      expect(await db.customizedStoryboardScript.count({ where: { projectId } })).toBe(0);
      expect(await db.workflowRun.count({ where: { projectId } })).toBe(1);
      const workspace = await fetch(`${api}?workflowRunId=${root.id}`);
      expect(workspace.status).toBe(200);
      expect(((await workspace.json()) as { data: { scripts: unknown[] } }).data.scripts).toEqual(
        [],
      );
      const freshTree = await fetch(treeUrl);
      expect(freshTree.status).toBe(200);
      const tree = JSON.stringify(await freshTree.json());
      expect(tree).not.toContain(branch.id);
      expect(tree).not.toContain(child.id);
      expect((await remove(row.revision)).status).toBe(404);
    } finally {
      await db.workingArtifactDependency.deleteMany({ where: { projectId } });
      await db.project.deleteMany({ where: { id: projectId } });
      await db.$disconnect();
    }
  },
  30000,
);
