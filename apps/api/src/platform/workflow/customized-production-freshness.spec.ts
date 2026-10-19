import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { currentCustomizedVideoArtifacts } from './customized-production-freshness';
import { WorkflowWorkingService } from './workflow-working.service';
const fixture = () =>
  JSON.parse(
    readFileSync(
      resolve(
        __dirname,
        '../../../../../packages/contracts/fixtures/customized-video-plan-v2.json',
      ),
      'utf8',
    ),
  ).document;
const at = new Date('2026-10-19T05:00:00Z');
const row = (artifactKey: string, freshness = 'CURRENT', payload: unknown = null) => ({
  artifactKey,
  freshness,
  payload,
  nodeId: 'SHOT_RENDER',
  revision: 1,
  name: artifactKey,
  createdAt: at,
});
describe('customized video node freshness scope', () => {
  it('ignores obsolete prompts and removed tasks without modifying historical records', () => {
    const rows = [
      row('customized-video-plan', 'CURRENT', fixture()),
      row('customized-clip-prompt:old', 'STALE'),
      row('customized-video-clip:old', 'CURRENT', { removed: true }),
      row('customized-clip-prompt:clip-a'),
      row('customized-shot:shot-a'),
    ];
    const before = JSON.stringify(rows);
    expect(currentCustomizedVideoArtifacts(rows).map((r) => r.artifactKey)).toEqual([
      'customized-video-plan',
      'customized-clip-prompt:clip-a',
      'customized-shot:shot-a',
    ]);
    expect(JSON.stringify(rows)).toBe(before);
  });
  it.each([null, { shots: [] }, { schemaVersion: 2, videoPlan: { clips: [] } }])(
    'keeps the legacy or unvalidated head conservative (%j)',
    (payload) => {
      const rows = [
        row('customized-video-plan', 'CURRENT', payload),
        row('customized-clip-prompt:old', 'STALE'),
      ];
      expect(currentCustomizedVideoArtifacts(rows)).toBe(rows);
    },
  );
  it.each([false, true])(
    'aggregates each branch from its own confirmed plan and retains real stale prompts (%s)',
    async (stale) => {
      const head = fixture();
      const base = {
        projectId: 'p',
        parentWorkflowRunId: null,
        forkNodeId: null,
        branchLabel: null,
        currentNodeId: 'SHOT_RENDER',
        createdAt: at,
        branchPublishedAt: null,
      };
      const records = [
        {
          ...base,
          id: 'active',
          activeKey: 'ACTIVE',
          workingArtifacts: [
            row('customized-video-plan', 'CURRENT', head),
            row('customized-clip-prompt:old', 'STALE'),
            row('customized-clip-prompt:clip-a', stale ? 'STALE' : 'CURRENT'),
          ],
        },
        {
          ...base,
          id: 'sibling',
          activeKey: null,
          workingArtifacts: [
            row('customized-video-plan', 'CURRENT', head),
            row('customized-clip-prompt:clip-a', 'STALE'),
          ],
        },
      ];
      const service = new WorkflowWorkingService(
        { listCustomizedRunBranches: vi.fn().mockResolvedValue(records) } as never,
        { get: vi.fn().mockResolvedValue({ id: 'p' }) } as never,
        {} as never,
      );
      const tree = await service.getCustomizedBranchTree('p');
      expect(tree.branches[0]!.nodes.find((n) => n.nodeId === 'SHOT_RENDER')?.status).toBe(
        stale ? 'STALE' : 'CONFIRMED',
      );
      expect(tree.branches[1]!.nodes.find((n) => n.nodeId === 'SHOT_RENDER')?.status).toBe('STALE');
    },
  );
});
