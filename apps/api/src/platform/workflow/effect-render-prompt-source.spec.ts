import { describe, expect, it } from 'vitest';
import { effectRenderPromptSource, projectEffectBranchFreshness } from './effect-branch-freshness';
import { createHash } from 'node:crypto';

const branches = [
  { id: 'root', parentWorkflowRunId: null, forkNodeId: null },
  {
    id: 'mix',
    parentWorkflowRunId: 'root',
    forkNodeId: 'TEMPLATE_MIX',
    branchPublishedAt: new Date(1000),
  },
  {
    id: 'sibling',
    parentWorkflowRunId: 'root',
    forkNodeId: 'TEMPLATE_MIX',
    branchPublishedAt: new Date(1000),
  },
  {
    id: 'independent',
    parentWorkflowRunId: 'root',
    forkNodeId: 'SEGMENT_RENDER',
    branchPublishedAt: new Date(1000),
  },
];
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const prompt = (id: string, run: string, revision: number, time: number, body = 'latest') => ({
  id,
  workflowRunId: run,
  nodeId: 'PROMPT_GENERATION',
  artifactKey: `prompt-batch:${run}`,
  revision,
  updatedAt: new Date(time),
  freshness: 'CURRENT',
  availability: 'AVAILABLE',
  payload: {
    items: [
      {
        id: 'p',
        content: body,
        targetDurationSeconds: 5,
        primaryPurpose: 'PRODUCT_DISPLAY',
        compatiblePurposes: ['PRODUCT_DISPLAY'],
      },
    ],
    sharedPrompt: { contentHash: hash('shared') },
  },
});
const old = prompt('old', 'root', 11, 1000, 'old');
const adopted = prompt('adopted', 'mix', 13, 2000);
const payload = {
  taskId: 'task',
  promptId: 'p',
  promptContentHash: hash('latest'),
  adoptedPrompt: {
    promptContentHash: hash('latest'),
    sharedPromptHash: hash('shared'),
    targetDurationSeconds: 5,
    primaryPurpose: 'PRODUCT_DISPLAY',
    compatiblePurposes: ['PRODUCT_DISPLAY'],
  },
};
const render = {
  id: 'render',
  workflowRunId: 'root',
  nodeId: 'SEGMENT_RENDER',
  artifactKey: 'render-batch:root',
  revision: 7,
  updatedAt: new Date(3000),
  freshness: 'CURRENT',
  availability: 'AVAILABLE',
  payload: { clips: [payload], sourcePrompt: { artifactId: adopted.id, revision: 13 } },
  dependencies: [
    {
      sourceType: 'WORKING_ARTIFACT',
      sourceNodeId: 'PROMPT_GENERATION',
      sourceArtifactId: adopted.id,
      sourceRevision: 13,
    },
  ],
};

describe('render adopted Prompt source anti-rollback', () => {
  it('keeps the exact adopted source instead of an older root snapshot or arbitrary newer sibling', () => {
    expect(
      effectRenderPromptSource(branches, render, old, [
        old,
        adopted,
        prompt('unrelated', 'sibling', 99, 9000),
      ]),
    ).toBe(adopted);
    expect(
      projectEffectBranchFreshness(branches, [old, adopted, render], undefined, 'root').find(
        (a) => a.id === render.id,
      )?.freshness,
    ).toBe('CURRENT');
  });
  it.each([12, 14])('keeps a later real edit even when its revision is %s', (revision) => {
    const changed = prompt('old', 'root', revision, 2500, 'edited while rendering');
    expect(effectRenderPromptSource(branches, render, changed, [adopted])).toBe(changed);
    expect(
      projectEffectBranchFreshness(branches, [changed, adopted, render], undefined, 'root').at(-1)
        ?.freshness,
    ).toBe('STALE');
  });
  it('clears content-reverted differences without changing any revisions', () => {
    const reverted = prompt('old', 'root', 14, 4000);
    expect(
      projectEffectBranchFreshness(branches, [reverted, adopted, render], undefined, 'root').at(-1)
        ?.freshness,
    ).toBe('CURRENT');
    expect(render.revision).toBe(7);
  });
  it('does not cross an independent render boundary or adopt an unconfirmed draft', () => {
    expect(
      effectRenderPromptSource(branches, render, old, [
        { ...adopted, workflowRunId: 'independent' },
      ]),
    ).toBe(old);
    const draft = [
      ...branches,
      {
        id: 'draft',
        parentWorkflowRunId: 'root',
        forkNodeId: 'TEMPLATE_MIX',
        branchPublishedAt: null,
      },
    ];
    expect(
      effectRenderPromptSource(draft, render, old, [{ ...adopted, workflowRunId: 'draft' }]),
    ).toBe(old);
  });
  it('does not guess from missing timestamps, missing identities or an unavailable viewing source', () => {
    const { updatedAt: _time, ...withoutTime } = old;
    expect(effectRenderPromptSource(branches, render, withoutTime, [adopted])).toMatchObject({
      id: old.id,
    });
    expect(effectRenderPromptSource(branches, render, old, [])).toBe(old);
    expect(
      effectRenderPromptSource(branches, render, { ...old, availability: 'UNAVAILABLE' }, [
        adopted,
      ]),
    ).toMatchObject({ id: old.id });
  });
  it('ignores copied navigation timestamps but keeps subsequent saved changes after provenance is removed', () => {
    const copy = {
      ...old,
      updatedAt: new Date(9000),
      metadata: { branchSource: { artifactId: old.id } },
    };
    expect(effectRenderPromptSource(branches, render, copy, [adopted])).toBe(adopted);
    const saved = { ...copy, metadata: {} };
    expect(effectRenderPromptSource(branches, render, saved, [adopted])).toMatchObject({
      id: old.id,
    });
  });
  it('rejects contradictory source revisions/hashes rather than treating them as a confirmed head', () => {
    expect(effectRenderPromptSource(branches, render, old, [{ ...adopted, revision: 12 }])).toBe(
      old,
    );
    const inconsistent = {
      ...render,
      payload: {
        ...render.payload,
        sourcePrompt: { artifactId: adopted.id, revision: 13, contentHash: 'different' },
      },
    };
    const inconsistentSource = { ...adopted, contentHash: 'original' };
    expect(effectRenderPromptSource(branches, inconsistent, old, [inconsistentSource])).toBe(old);
  });
  it('still exposes a later edit of the explicitly adopted source', () => {
    const changed = {
      ...adopted,
      revision: 14,
      payload: {
        ...adopted.payload,
        items: [
          { ...adopted.payload.items[0]!, content: 'new body' },
          { ...adopted.payload.items[0]!, id: 'new-source' },
        ],
      },
    };
    expect(
      projectEffectBranchFreshness(branches, [old, changed, render], undefined, 'root').at(-1)
        ?.freshness,
    ).toBe('STALE');
    const deleted = { ...changed, payload: { ...changed.payload, items: [] } };
    expect(
      projectEffectBranchFreshness(branches, [old, deleted, render], undefined, 'root').at(-1)
        ?.freshness,
    ).toBe('STALE');
  });
});
