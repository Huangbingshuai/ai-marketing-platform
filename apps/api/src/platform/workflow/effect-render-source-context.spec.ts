import { describe, expect, it, vi } from 'vitest';
import {
  confirmedEffectRenderPromptArtifact,
  confirmedEffectRenderSourceRun,
} from './effect-render-source-context';

describe('confirmed render workspace source', () => {
  const setup = (count = 22) => {
    const branches = [
      { id: 'root', parentWorkflowRunId: null, forkNodeId: null, branchPublishedAt: null },
      {
        id: 'owner',
        parentWorkflowRunId: 'root',
        forkNodeId: 'TEMPLATE_MIX',
        branchPublishedAt: new Date(),
      },
      {
        id: 'old',
        parentWorkflowRunId: 'owner',
        forkNodeId: 'TEMPLATE_MIX',
        branchPublishedAt: new Date(),
      },
      {
        id: 'draft',
        parentWorkflowRunId: 'old',
        forkNodeId: 'SEGMENT_RENDER',
        branchPublishedAt: null,
        editSessionNodeId: 'SEGMENT_RENDER',
      },
      {
        id: 'independent',
        parentWorkflowRunId: 'root',
        forkNodeId: 'SEGMENT_RENDER',
        branchPublishedAt: new Date(),
      },
    ];
    const batch = (id: string, revision: number, size: number, copied = false) => ({
      workflowRunId: id,
      nodeId: 'SEGMENT_RENDER',
      artifactKey: `render-batch:${id}`,
      revision,
      metadata: copied ? { branchSource: { artifactId: 'root-batch' } } : {},
      payload: { clips: Array.from({ length: size }, (_, i) => ({ taskId: `${id}-${i}` })) },
      updatedAt: new Date(revision * 1000),
    });
    return {
      workflowRun: { findMany: vi.fn().mockResolvedValue(branches) },
      workingArtifact: {
        findMany: vi
          .fn()
          .mockResolvedValue([
            batch('root', 1, 20),
            batch('owner', 2, count),
            batch('old', 1, 20, true),
            batch('draft', 99, 24),
            batch('independent', 99, 50),
          ]),
      },
    };
  };
  it.each([22, 19, 0])(
    'reads the confirmed pool (%s), never the largest/newest copied task list',
    async (count) => {
      const db = setup(count);
      expect(await confirmedEffectRenderSourceRun(db as never, 'p', 'old')).toBe('owner');
      expect(db.workflowRun.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { projectId: 'p', workflow: 'EFFECT', workflowSpace: 'EFFECT' },
        }),
      );
    },
  );
  it('preserves unsaved edits and independent render boundaries', async () => {
    const db = setup();
    expect(await confirmedEffectRenderSourceRun(db as never, 'p', 'draft')).toBe('draft');
    expect(db.workingArtifact.findMany).not.toHaveBeenCalled();
    expect(await confirmedEffectRenderSourceRun(db as never, 'p', 'independent')).toBe(
      'independent',
    );
  });
  it('resolves only the explicitly consumed Prompt in the same project', async () => {
    const db = setup();
    const viewing = {
      id: 'old-prompt',
      workflowRunId: 'root',
      nodeId: 'PROMPT_GENERATION',
      artifactKey: 'prompt-batch:root',
      freshness: 'CURRENT',
      revision: 11,
      updatedAt: new Date(1000),
    };
    const adopted = {
      ...viewing,
      id: 'adopted-prompt',
      workflowRunId: 'owner',
      revision: 13,
      updatedAt: new Date(2000),
    };
    const findFirst = vi.fn().mockResolvedValue(adopted);
    const scoped = { ...db, workingArtifact: { ...db.workingArtifact, findFirst } };
    const render = {
      workflowRunId: 'root',
      sourcePromptArtifactId: adopted.id,
      sourcePromptRevision: 13,
    };
    expect(
      await confirmedEffectRenderPromptArtifact(
        scoped as never,
        'p',
        'root',
        viewing as never,
        render,
      ),
    ).toBe(adopted);
    expect(findFirst).toHaveBeenCalledWith({
      where: { projectId: 'p', id: adopted.id, nodeId: 'PROMPT_GENERATION' },
    });
    expect(
      await confirmedEffectRenderPromptArtifact(
        scoped as never,
        'p',
        'root',
        { ...viewing, revision: 12, updatedAt: new Date(3000) } as never,
        render,
      ),
    ).toMatchObject({ id: viewing.id });
    findFirst.mockClear();
    expect(
      await confirmedEffectRenderPromptArtifact(
        scoped as never,
        'p',
        'draft',
        viewing as never,
        render,
      ),
    ).toBe(viewing);
    expect(findFirst).not.toHaveBeenCalled();
  });
});
