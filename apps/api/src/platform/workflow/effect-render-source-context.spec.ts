import { describe, expect, it, vi } from 'vitest';
import { confirmedEffectRenderSourceRun } from './effect-render-source-context';

describe('confirmed render workspace source', () => {
  const setup = (count = 22) => {
    const branches = [
      { id: 'root', parentWorkflowRunId: null, forkNodeId: null, branchPublishedAt: null },
      { id: 'owner', parentWorkflowRunId: 'root', forkNodeId: 'TEMPLATE_MIX', branchPublishedAt: new Date() },
      { id: 'old', parentWorkflowRunId: 'owner', forkNodeId: 'TEMPLATE_MIX', branchPublishedAt: new Date() },
      { id: 'draft', parentWorkflowRunId: 'old', forkNodeId: 'SEGMENT_RENDER', branchPublishedAt: null, editSessionNodeId: 'SEGMENT_RENDER' },
      { id: 'independent', parentWorkflowRunId: 'root', forkNodeId: 'SEGMENT_RENDER', branchPublishedAt: new Date() },
    ];
    const batch = (id: string, revision: number, size: number, copied = false) => ({
      workflowRunId: id, nodeId: 'SEGMENT_RENDER', artifactKey: `render-batch:${id}`, revision,
      metadata: copied ? { branchSource: { artifactId: 'root-batch' } } : {},
      payload: { clips: Array.from({ length: size }, (_, i) => ({ taskId: `${id}-${i}` })) },
      updatedAt: new Date(revision * 1000),
    });
    return { workflowRun: { findMany: vi.fn().mockResolvedValue(branches) },
      workingArtifact: { findMany: vi.fn().mockResolvedValue([
        batch('root', 1, 20), batch('owner', 2, count), batch('old', 1, 20, true),
        batch('draft', 99, 24), batch('independent', 99, 50),
      ]) } };
  };
  it.each([22, 19, 0])('reads the confirmed pool (%s), never the largest/newest copied task list', async (count) => {
    const db = setup(count);
    expect(await confirmedEffectRenderSourceRun(db as never, 'p', 'old')).toBe('owner');
    expect(db.workflowRun.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { projectId: 'p', workflow: 'EFFECT', workflowSpace: 'EFFECT' },
    }));
  });
  it('preserves unsaved edits and independent render boundaries', async () => {
    const db = setup();
    expect(await confirmedEffectRenderSourceRun(db as never, 'p', 'draft')).toBe('draft');
    expect(db.workingArtifact.findMany).not.toHaveBeenCalled();
    expect(await confirmedEffectRenderSourceRun(db as never, 'p', 'independent')).toBe('independent');
  });
});
