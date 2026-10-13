import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ConfigService } from '@nestjs/config';
import { expect, it } from 'vitest';
import { emptyCustomizedBrief, type StoryboardWorkspace } from '@ai-marketing/contracts';
import { PrismaService } from '../../../database/prisma.service';
import { WorkflowWorkingRepository } from '../../../platform/workflow/workflow-working.repository';
import { workflowStateHash } from '../../../platform/workflow/workflow-state-hash';
import { StoryboardRepository } from './storyboard.repository';

// Real HTTP + PostgreSQL + Python pipeline, with model calls replaced only in this test.
it.skipIf(process.env.CUSTOMIZED_STORYBOARD_HTTP_TEST !== '1')(
  'publishes through protected HTTP using the real Python pipeline without model charges',
  async () => {
    const rootPath = resolve(process.cwd(), '../..');
    const envFile = await readFile(resolve(rootPath, '.env'), 'utf8');
    const setting = (name: string) =>
      process.env[name] ?? envFile.match(new RegExp(`^${name}=(.*)$`, 'm'))?.[1]?.trim();
    const token = setting('CUSTOMIZED_STORYBOARD_WORKER_TOKEN');
    if (!token) throw new Error('Dedicated worker token is required for this opt-in test');
    const base = `http://localhost:${setting('API_PORT') ?? '3100'}/api`;
    const db = new PrismaService(
      new ConfigService({
        DATABASE_URL:
          setting('DATABASE_URL') ??
          'postgresql://postgres:postgres@localhost:5432/ai_marketing?schema=public',
      }),
    );
    const working = new WorkflowWorkingRepository(db),
      repo = new StoryboardRepository(db, working),
      projectId = randomUUID();
    // No Outbox row is inserted: the deployed paid consumer cannot receive this test task.
    Object.defineProperty(repo, 'enqueue', { value: async () => undefined });
    try {
      await db.project.create({ data: { id: projectId, name: '分镜 HTTP 受控隔离验收' } });
      const run = await working.initializeCustomizedRun(projectId);
      const brief = {
        ...emptyCustomizedBrief(),
        productName: '陶瓷杯',
        sellingPoints: ['圆润把手'],
      };
      await db.workingArtifact.create({
        data: {
          projectId,
          workflowRunId: run.id,
          nodeId: 'INFORMATION_EXTRACTION',
          artifactKey: 'customized-brief',
          kind: 'STRUCTURED',
          name: '信息卡',
          directory: 'INSIGHTS',
          type: 'INSIGHT_RESULT',
          payload: brief,
          contentHash: workflowStateHash(brief),
        },
      });
      const key = randomUUID(),
        task = await repo.create(projectId, run.id, 0, key, {
          creative: 'controlled-pro',
          detail: 'controlled-turbo',
        });
      const api = `${base}/projects/${projectId}/workflows/customized/storyboard`;
      const denied = await fetch(
        `${base}/internal/workers/customized-storyboard/tasks/${task.id}/claim`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ projectId }),
        },
      );
      expect(denied.status).toBe(401);
      const duplicate = await fetch(`${api}/tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workflowRunId: run.id, expectedRevision: 0, idempotencyKey: key }),
      });
      expect(duplicate.status).toBe(202);
      expect(((await duplicate.json()) as { data: { id: string } }).data.id).toBe(task.id);
      const python = `import asyncio,json,sys
sys.path.insert(0,'tests')
from test_pipeline import ControlledProvider
from customized_storyboard.api import Api
from customized_storyboard.pipeline import Pipeline
async def run():
 v=json.load(sys.stdin)
 api=Api(v['base'],v['token'],v['project'],v['task'])
 try:
  claim=await api.call('POST','claim')
  api.token=claim['attemptToken']
  provider=ControlledProvider()
  provider.review_errors=True
  await Pipeline(api,provider,claim['input'],claim['checkpoints'],claim['completedScriptIds']).run()
 finally: await api.close()
asyncio.run(run())`;
      await new Promise<void>((done, reject) => {
        const child = spawn('uv', ['run', '--no-sync', 'python', '-c', python], {
          cwd: resolve(rootPath, 'workers/customized-storyboard'),
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        let diagnostic = '';
        child.stderr.on('data', (chunk) => {
          diagnostic += String(chunk);
        });
        child.on('error', reject);
        child.on('exit', (code) =>
          code === 0
            ? done()
            : reject(
                new Error(
                  `Controlled pipeline exit ${code}: ${diagnostic.replaceAll(token, '[redacted]')}`,
                ),
              ),
        );
        child.stdin.end(JSON.stringify({ base, token, project: projectId, task: task.id }));
      });
      const response = await fetch(`${api}?workflowRunId=${run.id}`);
      expect(response.status).toBe(200);
      const workspace = ((await response.json()) as { data: StoryboardWorkspace }).data;
      expect(workspace.task?.status).toBe('COMPLETED');
      expect(workspace.scripts).toHaveLength(3);
      expect(new Set(workspace.scripts.map((s) => s.workflowRunId)).size).toBe(3);
      const detail = await fetch(
        `${api}/tasks/${task.id}/nodes/SHOTS?page=0&scriptId=${workspace.scripts[0]!.id}`,
      );
      expect(detail.status).toBe(200);
      expect(
        JSON.stringify(((await detail.json()) as { data: { sections: unknown } }).data.sections),
      ).toContain('自然侧光');
      const repairDetail = await fetch(
        `${api}/tasks/${task.id}/nodes/REPAIR?page=0&scriptId=${workspace.scripts[0]!.id}`,
      );
      expect(repairDetail.status).toBe(200);
      const repairSections = JSON.stringify(
        ((await repairDetail.json()) as { data: { sections: unknown } }).data.sections,
      );
      expect(repairSections).toContain('第 01 镜 · 画面内容');
      expect(repairSections).toContain('已知事实');
      expect(workspace.scripts.every((s) => s.script.shots[0]?.visual === '已知事实')).toBe(true);
      expect(await db.jobOutbox.count({ where: { projectId } })).toBe(0);
    } finally {
      await db.workingArtifactDependency.deleteMany({ where: { projectId } });
      await db.project.deleteMany({ where: { id: projectId } });
      await db.$disconnect();
    }
  },
  90000,
);
