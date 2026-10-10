import type {
  EffectTemplateMixDraft,
  EffectTemplateMixVariant,
  WorkingArtifact,
} from '@ai-marketing/contracts';
import { effectTemplateMixSourceChanges } from '@ai-marketing/contracts';
import { describe, expect, it, vi } from 'vitest';

import type { WorkflowWorkingService } from '../../../platform/workflow/workflow-working.service';
import { workflowStateHash } from '../../../platform/workflow/workflow-state-hash';
import { EffectTemplateMixService } from './effect-template-mix.service';
import type { EffectTemplateMixAiRepository } from './effect-template-mix-ai.repository';
import { templateConfigurationHash } from './template-mix-lifecycle';

const templateId = '3c2504a0-b21a-4a7d-b486-14495c73bdf4';
const variantId = '01795c3c-4726-405b-bbc9-28137f768fff';
const slotId = 'e169b2ee-0ee7-4f03-88cf-25d85218691f';
const sourceId = '7b084c93-e637-430a-812f-d0e277e41804';

const draft = (): EffectTemplateMixDraft => ({
  schemaVersion: 1,
  activeTemplateId: templateId,
  templates: [
    {
      id: templateId,
      workspace: {
        editVersion: 4,
        template: {
          name: '跑量模板',
          editVersion: 2,
          slots: [
            {
              id: slotId,
              label: '片头钩子',
              role: 'HOOK',
              purpose: 'HOOK',
              duration: 4,
              transition: '硬切',
            },
          ],
        },
        variants: [
          {
            id: variantId,
            name: '跑量模板 · 1',
            appliedTemplateVersion: 2,
            slots: [
              {
                id: slotId,
                label: '片头钩子',
                role: 'HOOK',
                purpose: 'HOOK',
                duration: 4,
                transition: '硬切',
              },
            ],
            bindings: { [slotId]: sourceId },
            bindingRevisions: { [slotId]: 2 },
            offsets: { [slotId]: 0 },
            manualSlotIds: [],
            conflictSlotIds: [],
            status: 'CURRENT',
            captions: [],
            subtitleStyle: 'standard',
            bgm: null,
            voice: null,
            originalVolume: 1,
          },
        ],
      },
    },
  ],
});

const source = {
  id: sourceId,
  nodeId: 'SEGMENT_RENDER',
  artifactKey: 'render-clip:task-1',
  kind: 'FILE',
  name: '钩子视频片段',
  contentUrl: '/api/projects/project/workflow-artifacts/' + sourceId + '/content',
  revision: 2,
  availability: 'AVAILABLE',
  freshness: 'CURRENT',
  payload: {
    durationSeconds: 4,
    contentHash: 'sha',
    fileObjectId: 'file-1',
    primaryPurpose: 'HOOK',
    compatiblePurposes: [],
  },
} as WorkingArtifact;

describe('saved video spatial transforms', () => {
  it('uses the published generation ratio despite copied batches and changing next-batch settings', async () => {
    const { service, working } = harness();
    const owner = { ...source, workflowRunId: 'render-owner', artifactKey: 'render-batch:owner-product',
      metadata: { branchSourceOwner: true }, payload: { clips: [{ ratio: '4:3' }] } } as WorkingArtifact;
    const copied = { ...owner, workflowRunId: 'mix-run', artifactKey: 'render-batch:copy-product',
      metadata: { branchSourceOwner: false }, payload: { clips: [{ ratio: '16:9' }] } } as WorkingArtifact;
    working.listArtifacts.mockResolvedValue({ items: [source, copied, owner], total: 3 });
    let nextRatio = '9:16';
    working.getNodeStateOrNull.mockImplementation(async (_p, _run, node) => {
      if (node === 'TEMPLATE_MIX') return { revision: 7, state: draft() } as never;
      return { revision: 2, state: { ratio: nextRatio } } as never;
    });
    for (const ratio of ['9:16', '1:1', 'adaptive']) {
      nextRatio = ratio;
      expect((await service.workspace('project', 'mix-run')).renderAspectRatio).toBe('4:3');
      expect((await service.outputSourceWorkspace('project', 'mix-run')).renderAspectRatio).toBe('4:3');
      expect((await service.materialSources('project', 'mix-run')).renderAspectRatio).toBe('4:3');
    }
    expect(working.getNodeStateOrNull.mock.calls.some(call => String(call[2]).startsWith('SEGMENT_RENDER_SETTINGS'))).toBe(false);
    expect(working.putNodeState).not.toHaveBeenCalled();
    // A newly adopted generation, unlike a settings edit, does change the default.
    owner.payload = { clips: [{ ratio: '9:16' }] };
    expect((await service.workspace('project', 'mix-run')).renderAspectRatio).toBe('9:16');
    owner.payload = { clips: [{ ratio: '1:1' }] };
    expect((await service.materialSources('project', 'mix-run')).renderAspectRatio).toBe('1:1');
  });
  it.each([
    [[], 'adaptive'],
    [[{ ratio: '16:9' }], '16:9'],
    [[{ ratio: 'adaptive' }], 'adaptive'],
    [[{ ratio: '4:3' }, { ratio: '16:9' }], 'adaptive'],
    [[{ ratio: '4:3' }, { ratio: '8:6' }], '4:3'],
    [[{ ratio: '4:3' }, { ratio: '9:16', origin: 'EXTERNAL_IMPORT' }], '4:3'],
    [[{ ratio: 'broken' }], 'adaptive'],
    [[{ ratio: '9:16', origin: 'EXTERNAL_IMPORT' }], 'adaptive'],
  ])('resolves only committed generation snapshots %j', async (clips, expected) => {
    const { service, working } = harness();
    const batch = { ...source, workflowRunId: 'render-owner', artifactKey: 'render-batch:product',
      metadata: { branchSourceOwner: true }, payload: { clips } } as WorkingArtifact;
    const prompt = { ...source, nodeId: 'PROMPT_GENERATION', workflowRunId: 'render-owner',
      artifactKey: 'prompt-batch:product', payload: { renderProfile: { ratio: '9:16' } } } as WorkingArtifact;
    working.listArtifacts.mockResolvedValue({ items: [source, batch, prompt], total: 3 });
    working.getNodeStateOrNull.mockImplementation(async (_p, _r, node) => node === 'TEMPLATE_MIX'
      ? { revision: 7, state: draft() } as never : null as never);
    expect((await service.workspace('project', 'mix-run')).renderAspectRatio).toBe(expected);
    expect(working.putNodeState).not.toHaveBeenCalled();
  });
  it('saves valid transforms through the existing revision-controlled draft', async () => {
    const { service, working } = harness();
    const value = draft();
    value.templates[0]!.workspace.variants[0]!.videoTransforms = { [slotId]: { x: .2, y: -.1, scaleX: .7, scaleY: 1.2, rotation: 35, uniform: false } };
    await service.saveDraft('project', 'run', 7, value, true);
    expect(working.putNodeState.mock.calls[0]![3].state.templates[0].workspace.variants[0].videoTransforms)
      .toEqual(value.templates[0]!.workspace.variants[0]!.videoTransforms);
  });
  it.each([Infinity, NaN, 3])('rejects invalid spatial offset %s before persistence', async x => {
    const { service, working } = harness();
    const value = draft();
    value.templates[0]!.workspace.variants[0]!.videoTransforms = { [slotId]: { x, y: 0, scaleX: 1, scaleY: 1, rotation: 0, uniform: true } };
    await expect(service.saveDraft('project', 'run', 7, value, true)).rejects.toThrow();
    expect(working.putNodeState).not.toHaveBeenCalled();
  });
  it('allows user canvas overrides independently of the render default', async () => {
    const { service, working } = harness(); const value = draft();
    value.templates[0]!.workspace.variants[0]!.canvasRatio = '1:1';
    await service.saveDraft('project', 'run', 7, value, true);
    expect(working.putNodeState).toHaveBeenCalledOnce();
  });
  it('reads the committed adaptive generation ratio and accepts a manual canvas', async () => {
    const { service, working } = harness(); const value = draft();
    working.listArtifacts.mockResolvedValue({ items: [source, { ...source, artifactKey: 'render-batch:product', payload: { clips: [{ ratio: 'adaptive' }] } }], total: 2 });
    working.getNodeStateOrNull.mockImplementation(async (_p, _r, node) => ({ revision: 7, state: node === 'SEGMENT_RENDER_SETTINGS:product' ? { ratio: 'adaptive' } : draft() }) as never);
    value.templates[0]!.workspace.variants[0]!.canvasRatio = '2.35:1';
    await service.saveDraft('project', 'run', 7, value, true);
    expect((await service.workspace('project', 'run')).renderAspectRatio).toBe('adaptive');
    expect(working.getNodeStateOrNull).not.toHaveBeenCalledWith('project', 'run', 'SEGMENT_RENDER_SETTINGS:product');
    expect(working.putNodeState).toHaveBeenCalledOnce();
  });
});
describe('inherited render replacements in a selected mix branch', () => {
  it.each([
    ['HOOK', 'HOOK'], ['PRODUCT_DISPLAY', 'PRODUCT_DISPLAY'], ['EFFECT', 'EFFECT'],
    ['CTA', 'END_CONVERSION'], ['END_CONVERSION', 'END_CONVERSION'],
    ['PAIN', 'HOOK'], ['SELLING_POINT_EXPLANATION', 'EFFECT'], ['OUTRO', 'END_CONVERSION'],
  ])('keeps confirmed %s clips visible as %s without making a first fill stale', async (raw, expected) => {
    const { service, working } = harness();
    const clip = { ...source, payload: { ...(source.payload as object),
      primaryPurpose: raw, compatiblePurposes: [raw, 'CTA', 'OUTRO', 'unknown'],
    } };
    working.listArtifacts.mockResolvedValue({ items: [clip], total: 1 });
    const workspace = await service.workspace('project', 'run');
    expect(workspace.materials).toHaveLength(1);
    expect(workspace.materials[0]).toMatchObject({ id: sourceId, artifactRevision: 2,
      fileObjectId: 'file-1', purpose: expected, available: true, activeSource: true });
    expect(workspace.materials[0]!.compatiblePurposes).toEqual([...new Set([expected, 'END_CONVERSION'])]);
    expect(effectTemplateMixSourceChanges(workspace.draft.templates[0]!.workspace.variants[0]!, workspace.materials))
      .toEqual([]);
    const sources = await service.materialSources('project', 'run');
    expect(sources.materials).toHaveLength(1);
    expect(sources.pendingProjectCount).toBe(0);
    expect(working.putNodeState).not.toHaveBeenCalled();
    expect(working.commitValidatedArtifacts).not.toHaveBeenCalled();
  });

  it('keeps an unchanged bound CTA clone current without rebinding it to the ancestor', async () => {
    const { service, working } = harness();
    const payload = { ...(source.payload as object), primaryPurpose: 'CTA', promptId: 'prompt-cta' };
    const bound = { ...source, workflowRunId: 'run', payload };
    const ancestor = { ...bound, id: 'ancestor', workflowRunId: 'parent', artifactKey: 'render-clip:parent-task',
      metadata: { branchSourceOwner: true } };
    working.listArtifacts.mockResolvedValue({ items: [ancestor, bound], total: 2 });
    const result = await service.materialSources('project', 'run');
    expect(result.materials).toHaveLength(1);
    expect(result.materials[0]!.id).toBe(sourceId);
    expect(result.pendingProjectCount).toBe(0);
    expect(working.putNodeState).not.toHaveBeenCalled();
  });

  it.each(['replacement', 'removed', 'unavailable'])('still reports a real CTA source %s', async (change) => {
    const { service, working } = harness();
    const clip = { ...source, workflowRunId: 'run', payload: { ...(source.payload as object),
      primaryPurpose: 'CTA', promptId: 'prompt-cta' } };
    working.listArtifacts.mockResolvedValue({ items: [clip], total: 1 });
    const initial = await service.workspace('project', 'run');
    working.getNodeStateOrNull.mockResolvedValue({ revision: 7, state: initial.draft });
    if (change === 'replacement') {
      working.listArtifacts.mockResolvedValue({ items: [{ ...clip, revision: 3,
        payload: { ...clip.payload, fileObjectId: 'new-file', contentHash: 'new-sha' } }], total: 1 });
    } else if (change === 'removed') {
      const batch = { ...source, id: 'pool', workflowRunId: 'run', artifactKey: 'render-batch:product',
        payload: { clips: [], removedSources: [{ taskId: 'task-1', promptId: 'prompt-cta' }] } };
      working.listArtifacts.mockResolvedValue({ items: [clip, batch], total: 2 });
    } else {
      working.listArtifacts.mockResolvedValue({ items: [{ ...clip, availability: 'MISSING' }], total: 1 });
    }
    const result = await service.materialSources('project', 'run');
    const changes = effectTemplateMixSourceChanges(initial.draft.templates[0]!.workspace.variants[0]!, result.materials);
    expect(result.pendingProjectCount).toBe(1);
    expect(changes).toHaveLength(1);
    if (change === 'removed') expect(changes[0]!.kind).toBe('REMOVED');
    else if (change === 'replacement') expect(changes[0]!.material?.fileObjectId).toBe('new-file');
    else expect(changes[0]!.blockedReason).toBeTruthy();
    expect(working.putNodeState).not.toHaveBeenCalled();
  });

  it('does not guess a purpose or mark unknown source metadata as a deletion', async () => {
    const { service, working } = harness();
    working.listArtifacts.mockResolvedValue({ items: [{ ...source,
      payload: { ...(source.payload as object), primaryPurpose: 'unknown' } }], total: 1 });
    const result = await service.outputSourceWorkspace('project', 'run');
    expect(result.materials).toEqual([]);
    const changes = effectTemplateMixSourceChanges(result.draft.templates[0]!.workspace.variants[0]!, result.materials);
    expect(changes[0]!.kind).not.toBe('REMOVED');
    expect(changes[0]!.blockedReason).toBeTruthy();
    expect(working.putNodeState).not.toHaveBeenCalled();
  });

  it('updates only changed source slots and keeps unchanged cloned bindings current', async () => {
    const { working, service } = harness();
    const state = draft();
    const variant = state.templates[0]!.workspace.variants[0]!;
    variant.slots.push({ ...variant.slots[0]!, id: 'unchanged-slot' });
    variant.bindings['unchanged-slot'] = 'unchanged-copy';
    variant.bindingRevisions['unchanged-slot'] = 1;
    const clip = (
      id: string,
      task: string,
      file: string,
      promptId: string,
      revision: number,
      owner: boolean,
      freshness = 'CURRENT',
    ): WorkingArtifact => ({
      ...source,
      id,
      artifactKey: `render-clip:${task}`,
      revision,
      freshness: freshness as 'CURRENT',
      workflowRunId: owner ? 'render-head' : 'branch',
      metadata: { branchSourceOwner: owner },
      payload: { ...(source.payload as object), fileObjectId: file, promptId },
    });
    working.getNodeState.mockResolvedValue({ revision: 7, state });
    working.getNodeStateOrNull.mockResolvedValue({ revision: 7, state });
    working.listArtifacts.mockResolvedValue({
      items: [
        clip(sourceId, 'copy-task', 'old', 'p', 2, false, 'STALE'),
        clip('replacement', 'new-task', 'new', 'p', 3, true),
        clip('unchanged-copy', 'unchanged-copy-task', 'same', 'q', 1, false),
        clip('unchanged-original', 'unchanged-task', 'same', 'q', 1, true),
        {
          ...source,
          id: 'batch',
          workflowRunId: 'render-head',
          artifactKey: 'render-batch:product',
          metadata: { branchSourceOwner: true },
          payload: {
            clips: [
              { taskId: 'new-task', promptId: 'p' },
              { taskId: 'unchanged-task', promptId: 'q' },
            ],
          },
        },
        {
          ...source,
          id: 'copied-batch',
          workflowRunId: 'branch',
          artifactKey: 'render-batch:copy-product',
          metadata: { branchSourceOwner: false },
          payload: {
            clips: [
              { taskId: 'copy-task', promptId: 'p' },
              { taskId: 'unchanged-copy-task', promptId: 'q' },
            ],
          },
        },
      ],
      total: 6,
    });
    const result = await service.workspace('project', 'branch');
    expect(effectTemplateMixSourceChanges(variant, result.materials)).toEqual([
      { slotId, material: expect.objectContaining({ id: 'replacement' }) },
    ]);
    expect(
      result.materials.filter((row) => row.activeSource && row.available).map((row) => row.id),
    ).toEqual(['replacement', 'unchanged-copy']);
    expect(result.draft.templates[0]?.needsAiFill).toBe(false);
    expect(working.putNodeState).not.toHaveBeenCalled();
  });
});

const harness = () => {
  const working = {
    // A fill with no published version to protect stays in the Run it was asked for.
    beginEffectNodeEdit: vi.fn().mockResolvedValue({
      run: { id: 'run' },
      parentWorkflowRunId: null,
      productIdMap: {},
      taskIdMap: {},
      created: false,
    }),
    getNodeState: vi.fn().mockResolvedValue({ revision: 7, state: draft() }),
    getNodeStateOrNull: vi.fn().mockResolvedValue({ revision: 7, state: draft() }),
    listArtifacts: vi.fn().mockResolvedValue({ items: [source], total: 1 }),
    putNodeState: vi.fn().mockImplementation((_project, _run, _node, input) =>
      Promise.resolve({
        nodeState: { revision: 8, state: input.state },
        unchanged: false,
      }),
    ),
    commitValidatedArtifacts: vi.fn().mockResolvedValue([
      {
        artifact: { id: templateId, artifactKey: 'mix-template:' + templateId, revision: 1 },
        unchanged: false,
      },
      {
        artifact: {
          id: variantId,
          artifactKey: 'timeline-project:' + templateId + ':' + variantId,
          revision: 1,
        },
        unchanged: false,
      },
    ]),
    publishEffectNodeEdit: vi.fn().mockResolvedValue({
      run: { id: 'run' },
      activeWorkflowRunId: 'run',
      createdBranch: false,
    }),
  };
  return {
    working,
    service: new EffectTemplateMixService(working as unknown as WorkflowWorkingService),
  };
};

describe('EffectTemplateMixService', () => {
  it('copies the server-owned adopted source into another film instead of trusting client history or using the live revision', async () => {
    const h = harness();
    const previous = draft();
    const owner = previous.templates[0]!.workspace.variants[0]!;
    owner.bindingSources = { [slotId]: {
      id: sourceId, artifactId: sourceId, artifactKey: source.artifactKey,
      artifactRevision: 2, artifactContentHash: 'business-old', fileObjectId: 'file-1',
      contentHash: 'sha', contentUrl: '/old', code: 'R-001', name: '旧素材', duration: 4,
      ratio: '9:16', resolution: '720p', purpose: 'HOOK', compatiblePurposes: [], available: true,
    } };
    h.working.getNodeStateOrNull.mockResolvedValue({ revision: 7, state: previous });
    h.working.listArtifacts.mockResolvedValue({ items: [{ ...source, revision: 3,
      payload: { ...(source.payload as object), fileObjectId: 'latest-file' } }], total: 1 });
    const value = structuredClone(previous);
    const copied = { ...structuredClone(owner), id: 'copied-film', name: '复制成片' };
    copied.bindingSources![slotId]!.contentHash = 'client-forged-hash';
    value.templates[0]!.workspace.variants.push(copied);
    await h.service.saveDraft('project', 'run', 7, value, true);
    expect(h.working.putNodeState.mock.calls[0]![3].state.templates[0].workspace.variants[1].bindingSources[slotId])
      .toMatchObject({ artifactRevision: 2, fileObjectId: 'file-1', contentHash: 'sha' });
    expect(owner.bindingSources[slotId]!.contentHash).toBe('sha');
  });
  it('recovers a legacy adopted file from its successful task snapshot without using the new live revision', async () => {
    const h = harness();
    const saved = draft();
    h.working.getNodeStateOrNull.mockResolvedValue({ revision: 7, state: saved });
    h.working.listArtifacts.mockResolvedValue({ items: [{ ...source, revision: 3,
      payload: { ...(source.payload as object), fileObjectId: 'new-file', contentHash: 'new-sha' } }], total: 1 });
    const repository = {
      sourceArtifacts: vi.fn().mockResolvedValue([]),
      listRecent: vi.fn().mockResolvedValue([{ templateId, status: 'COMPLETED',
        createdAt: new Date('2026-10-07T00:00:00Z'), updatedAt: new Date('2026-10-07T00:00:00Z'), inputSnapshot: {
        materials: [{ id: sourceId, artifactId: sourceId, artifactKey: source.artifactKey,
          artifactRevision: 2, contentHash: 'old-business-hash', fileObjectId: 'file-1',
          promptId: 'p1', prompt: '原画面描述', code: 'R-001', name: '原片段', duration: 4 }],
      } }]),
      mediaFingerprints: vi.fn().mockResolvedValue([{ id: 'file-1', sha256: 'sha' }]),
    };
    const service = new EffectTemplateMixService(h.working as unknown as WorkflowWorkingService,
      repository as unknown as EffectTemplateMixAiRepository);
    const result = await service.workspace('project', 'run');
    expect(result.draft.templates[0]!.workspace.variants[0]!.bindingSources?.[slotId]).toMatchObject({
      artifactRevision: 2, fileObjectId: 'file-1', contentHash: 'sha',
      artifactContentHash: 'old-business-hash', promptText: '原画面描述',
      contentUrl: '/api/projects/project/file-objects/file-1/content',
    });
    expect(saved.templates[0]!.workspace.variants[0]!.bindingSources).toBeUndefined();
    expect(h.working.putNodeState).not.toHaveBeenCalled();
  });
  it('hides a saved deletion including bound copies without resurrecting a same-file different source', async () => {
    const h = harness();
    const original = { ...source, metadata: { branchSourceOwner: true },
      payload: { ...(source.payload as object), promptId: 'deleted-prompt' } };
    const live = { ...source, id: 'live', artifactKey: 'render-clip:live',
      metadata: { branchSourceOwner: true }, payload: { ...(source.payload as object), promptId: 'live-prompt' } };
    const pool = { ...source, id: 'pool', artifactKey: 'render-batch:p', metadata: { branchSourceOwner: true },
      payload: { clips: [{ taskId: 'live', promptId: 'live-prompt' }],
        removedSources: [{ taskId: 'task-1', promptId: 'deleted-prompt' }] } };
    h.working.listArtifacts.mockResolvedValue({ items: [original, live, pool], total: 3 });
    const result = await h.service.workspace('project', 'run');
    expect(result.materials.find((row) => row.id === source.id)).toMatchObject({ activeSource: false, sourceRemoved: true });
    expect(result.materials.filter((row) => row.activeSource && row.available).map((row) => row.id)).toEqual(['live']);
    expect(effectTemplateMixSourceChanges(result.draft.templates[0]!.workspace.variants[0]!, result.materials))
      .toEqual([{ slotId, kind: 'REMOVED' }]);
  });
  const obsoleteSources = (sameFile = false) => {
    const current = { ...source, metadata: { branchSourceOwner: true },
      payload: { ...(source.payload as object), promptId: 'shared-prompt', version: 2 } };
    const old = { ...source, id: 'old-copy', revision: 1, artifactKey: 'render-clip:old-copy',
      metadata: { branchSourceOwner: false },
      payload: { ...(source.payload as object), promptId: 'shared-prompt', version: 1,
        fileObjectId: sameFile ? 'file-1' : 'old-file' } };
    const batch = { ...source, id: 'current-batch', artifactKey: 'render-batch:current',
      metadata: { branchSourceOwner: true }, payload: { clips: [{ taskId: 'task-1' }] } };
    return [current, old, batch] as WorkingArtifact[];
  };

  it('rejects a draft switching an updated slot back to another branch CURRENT old file', async () => {
    const { service, working } = harness();
    working.listArtifacts.mockResolvedValue({ items: obsoleteSources(), total: 3 });
    const value = draft(), variant = value.templates[0]!.workspace.variants[0]!;
    variant.bindings[slotId] = 'old-copy';
    variant.bindingRevisions[slotId] = 1;
    await expect(service.saveDraft('project', 'run', 7, value, true)).rejects.toThrow('不能使用其他分支的旧素材覆盖');
    expect(working.putNodeState).not.toHaveBeenCalled();
    expect(working.commitValidatedArtifacts).not.toHaveBeenCalled();
  });

  it('rejects confirming an obsolete CURRENT copy even when its local revision matches', async () => {
    const { service, working } = harness();
    const value = draft(), variant = value.templates[0]!.workspace.variants[0]!;
    variant.bindings[slotId] = 'old-copy';
    variant.bindingRevisions[slotId] = 1;
    working.getNodeState.mockResolvedValue({ revision: 7, state: value });
    working.listArtifacts.mockResolvedValue({ items: obsoleteSources(), total: 3 });
    await expect(service.validate('project', 'run', 7, templateId)).rejects.toThrow('不能使用其他分支的旧素材覆盖');
    expect(working.commitValidatedArtifacts).not.toHaveBeenCalled();
  });

  it('allows an unchanged stale binding to autosave other fields without confirming it', async () => {
    const { service, working } = harness();
    const previous = draft(), variant = previous.templates[0]!.workspace.variants[0]!;
    variant.bindings[slotId] = 'old-copy';
    variant.bindingRevisions[slotId] = 1;
    working.getNodeStateOrNull.mockResolvedValue({ revision: 7, state: previous });
    working.listArtifacts.mockResolvedValue({ items: obsoleteSources(), total: 3 });
    const value = structuredClone(previous);
    value.templates[0]!.workspace.variants[0]!.originalVolume = 0.5;
    await expect(service.saveDraft('project', 'run', 7, value, true)).resolves.toEqual({ draftRevision: 8 });
    expect(working.commitValidatedArtifacts).not.toHaveBeenCalled();
  });

  it('accepts a reminted binding to the exact same current video file', async () => {
    const { service, working } = harness();
    working.listArtifacts.mockResolvedValue({ items: obsoleteSources(true), total: 3 });
    const value = draft(), variant = value.templates[0]!.workspace.variants[0]!;
    variant.bindings[slotId] = 'old-copy';
    variant.bindingRevisions[slotId] = 1;
    await expect(service.saveDraft('project', 'run', 7, value, true)).resolves.toEqual({ draftRevision: 8 });
    working.getNodeState.mockResolvedValue({ revision: 7, state: value });
    await expect(service.validate('project', 'run', 7, templateId)).resolves.toBeDefined();
  });

  it('allows choosing a current material with a different Prompt identity', async () => {
    const { service, working } = harness();
    const items = obsoleteSources();
    items[1]!.metadata = { branchSourceOwner: true };
    items[1]!.payload = { ...(items[1]!.payload as object), promptId: 'another-prompt' };
    (items[2]!.payload as { clips: unknown[] }).clips.push({ taskId: 'old-copy' });
    working.listArtifacts.mockResolvedValue({ items, total: 3 });
    const value = draft(), variant = value.templates[0]!.workspace.variants[0]!;
    variant.bindings[slotId] = 'old-copy';
    variant.bindingRevisions[slotId] = 1;
    await expect(service.saveDraft('project', 'run', 7, value, true)).resolves.toEqual({ draftRevision: 8 });
  });

  it('keeps the frozen Prompt slot maximum when an independent import is longer', async () => {
    const { service, working } = harness();
    const imported = {
      ...source,
      id: 'imported',
      artifactKey: 'render-clip:import-task',
      payload: {
        ...(source.payload as object),
        fileObjectId: 'import-file',
        contentHash: 'import-sha',
        durationSeconds: 30,
        origin: 'EXTERNAL_IMPORT',
        promptText: '用户导入的视频描述',
        importedMaterial: { schemaVersion: 1 },
      },
    } as WorkingArtifact;
    working.listArtifacts.mockResolvedValue({
      items: [
        source,
        imported,
        {
          ...source,
          id: 'batch',
          artifactKey: 'render-batch:product',
          payload: {
            promptDurationMaxSeconds: 10,
            clips: [{ taskId: 'task-1' }, { taskId: 'import-task' }],
          },
        },
      ],
      total: 3,
    });
    const result = await service.workspace('project', 'run');
    expect(result.slotDurationMaxSeconds).toBe(10);
    expect(result.materials.find((row) => row.id === 'imported')).toMatchObject({
      duration: 30,
      origin: 'EXTERNAL_IMPORT',
      promptText: '用户导入的视频描述',
    });
  });
  it('replaces an ancestor repair source even while both committed batches are CURRENT', async () => {
    const { service, working } = harness();
    const old = {
      ...source,
      workflowRunId: 'parent',
      payload: { ...(source.payload as object), promptId: 'prompt' },
    };
    const replacement = {
      ...source,
      id: 'repaired',
      workflowRunId: 'run',
      artifactKey: 'render-clip:repair',
      payload: { ...(source.payload as object), promptId: 'prompt', fileObjectId: 'new-file' },
    };
    const oldBatch = {
      ...old,
      id: 'old-batch',
      artifactKey: 'render-batch:old-product',
      payload: { clips: [{ taskId: 'task-1', promptId: 'prompt' }] },
    };
    const newBatch = {
      ...replacement,
      id: 'new-batch',
      artifactKey: 'render-batch:new-product',
      payload: { clips: [{ taskId: 'repair', promptId: 'prompt' }] },
    };
    const candidate = {
      ...replacement,
      id: 'unadopted',
      artifactKey: 'render-clip:candidate',
      payload: { ...(replacement.payload as object), fileObjectId: 'candidate-file' },
    };
    const items = [old, oldBatch, candidate, newBatch, replacement] as WorkingArtifact[];
    working.listArtifacts.mockResolvedValue({ items, total: items.length });
    const result = await service.outputSourceWorkspace('project', 'run');
    expect(
      result.materials.filter((material) => material.activeSource).map((material) => material.id),
    ).toEqual(['repaired']);
    expect(
      result.materials.find((material) => material.id === 'repaired')?.replacesMaterialIds,
    ).toContain(sourceId);
    expect(result.materials.find((material) => material.id === sourceId)).toMatchObject({
      available: true,
      activeSource: false,
    });
    expect((await service.materialSources('project', 'run')).pendingProjectCount).toBe(1);
    expect(working.putNodeState).not.toHaveBeenCalled();
  });
  it('deletes only the requested project and allows an empty template without touching versions', async () => {
    const { service, working } = harness();
    const value = draft();
    const other = structuredClone(value.templates[0]!);
    other.id = 'other-template';
    value.templates.push(other);
    working.getNodeState.mockResolvedValue({ revision: 7, state: value });
    const result = await service.deleteVariant('project', 'run', templateId, variantId, 7);
    expect(result.draft.templates[0]!.workspace.variants).toEqual([]);
    expect(result.draft.templates[0]!.workspace.editVersion).toBe(5);
    expect(result.draft.templates[1]!.workspace.variants).toHaveLength(1);
    expect(working.putNodeState).toHaveBeenCalledWith(
      'project',
      'run',
      'TEMPLATE_MIX',
      expect.objectContaining({ expectedRevision: 7 }),
    );
    expect(working.commitValidatedArtifacts).not.toHaveBeenCalled();
    expect(working.beginEffectNodeEdit).not.toHaveBeenCalled();
  });

  it('rejects unknown projects and stale deletion revisions without saving', async () => {
    const { service, working } = harness();
    await expect(
      service.deleteVariant('project', 'run', templateId, 'foreign-variant', 7),
    ).rejects.toThrow('当前成片工程不存在');
    await expect(service.deleteVariant('project', 'run', templateId, variantId, 6)).rejects.toThrow(
      '混剪草稿已在其他页面更新',
    );
    expect(working.putNodeState).not.toHaveBeenCalled();
  });

  it('returns only the persisted revision for compact autosave without rebuilding the workbench', async () => {
    const { working } = harness();
    const aiRuns = {
      listRecent: vi.fn().mockResolvedValue([]),
      sourceArtifacts: vi.fn().mockResolvedValue([]),
      inheritedMixAiRuns: vi.fn().mockResolvedValue([]),
    };
    const service = new EffectTemplateMixService(
      working as unknown as WorkflowWorkingService,
      aiRuns as unknown as EffectTemplateMixAiRepository,
    );
    const value = draft();
    value.templates[0]!.materialRoleOverrides = { [sourceId]: 'HOOK' };
    await expect(service.saveDraft('project', 'run', 7, value, true)).resolves.toEqual({
      draftRevision: 8,
    });
    expect(working.putNodeState).toHaveBeenCalledOnce();
    expect(working.putNodeState.mock.calls[0]![3].state.templates[0]).toMatchObject({
      materialRoleOverrides: { [sourceId]: 'HOOK' },
      materialRoleEditVersion: 1,
    });
    expect(aiRuns.listRecent).toHaveBeenCalledOnce(); // Lock/source validation still runs.
    expect(aiRuns.sourceArtifacts).not.toHaveBeenCalled();
    expect(aiRuns.inheritedMixAiRuns).not.toHaveBeenCalled();
    expect(working.commitValidatedArtifacts).not.toHaveBeenCalled();
    expect(working.beginEffectNodeEdit).not.toHaveBeenCalled();
  });

  it('does not bypass material ownership validation for compact autosave', async () => {
    const { service, working } = harness();
    const value = draft();
    value.templates[0]!.materialRoleOverrides = { 'foreign-source': 'HOOK' };
    await expect(service.saveDraft('project', 'run', 7, value, true)).rejects.toThrow();
    expect(working.putNodeState).not.toHaveBeenCalled();
  });

  it('projects output sources through the existing artifact reader without loading workbench history', async () => {
    const { service, working } = harness();
    const result = await service.outputSourceWorkspace('project', 'run');
    expect(result.draft).toMatchObject(draft());
    expect(result.draft.templates[0]!.workspace.variants[0]!.bindingSources?.[slotId]).toMatchObject({
      fileObjectId: 'file-1', artifactRevision: 2, contentUrl: '/api/projects/project/file-objects/file-1/content',
    });
    expect(result.materials).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: sourceId,
          artifactRevision: 2,
          fileObjectId: 'file-1',
          available: true,
        }),
      ]),
    );
    expect(working.getNodeStateOrNull).toHaveBeenCalledWith('project', 'run', 'TEMPLATE_MIX');
    expect(result.artifacts).toEqual([source]);
    expect(working.listArtifacts).toHaveBeenCalledExactlyOnceWith('project', {
      workflowRunId: 'run',
    });
    expect(working.putNodeState).not.toHaveBeenCalled();
  });
  it('reads only the draft when pending output needs a name rather than source differences', async () => {
    const { service, working } = harness();
    const result = await service.outputSourceWorkspace('project', 'run', false);
    expect(result.draft).toEqual(draft());
    expect(result.materials).toEqual([]);
    expect(result.artifacts).toEqual([]);
    expect(working.listArtifacts).not.toHaveBeenCalled();
  });
  it('keeps bound clips for playback but excludes retired clips from the live source pool', async () => {
    const { service, working } = harness();
    const replacement = {
      ...source,
      id: 'replacement',
      artifactKey: 'render-clip:new-task',
      payload: { ...(source.payload as Record<string, unknown>), fileObjectId: 'file-new' },
    };
    const batch = {
      ...source,
      id: 'batch',
      kind: 'STRUCTURED',
      artifactKey: 'render-batch:pool',
      payload: { clips: [{ taskId: 'new-task' }] },
    } as WorkingArtifact;
    working.listArtifacts.mockResolvedValue({ items: [source, replacement, batch], total: 3 });
    const result = await service.outputSourceWorkspace('project', 'run');
    expect(result.materials.find((material) => material.id === source.id)).toMatchObject({
      activeSource: false,
    });
    expect(result.materials.find((material) => material.id === replacement.id)).toMatchObject({
      activeSource: true,
    });
    expect((await service.materialSources('project', 'run')).pendingProjectCount).toBe(1);
    expect(result.draftRevision).toBe(7);
    batch.payload = { clips: [] };
    const empty = await service.outputSourceWorkspace('project', 'run');
    expect(empty.materials.filter((material) => material.activeSource)).toEqual([]);
    expect(empty.materials.find((material) => material.id === source.id)?.available).toBe(true);
  });
  it('autosaves material roles without confirming artifacts or changing timeline content', async () => {
    const { service, working } = harness();
    const value = draft();
    value.templates[0]!.materialRoleOverrides = { [sourceId]: 'HOOK' };
    const result = await service.saveDraft('project', 'run', 7, value);
    expect(result.draft.templates[0]!.materialRoleOverrides).toEqual({ [sourceId]: 'HOOK' });
    expect(result.draft.templates[0]!.materialRoleEditVersion).toBe(1);
    expect(result.draft.templates[0]!.workspace).toMatchObject(draft().templates[0]!.workspace);
    expect(working.commitValidatedArtifacts).not.toHaveBeenCalled();
    expect(working.beginEffectNodeEdit).not.toHaveBeenCalled();
  });

  it('freezes manual roles for smart-fill and enforces them in role pools', async () => {
    const { working } = harness();
    const state = draft();
    const roles = [
      'HOOK',
      'PAIN_POINT',
      'PRODUCT',
      'SELLING_POINT',
      'TRANSFORMATION',
      'END',
    ] as const;
    const entry = state.templates[0]!;
    entry.workspace.variants = [];
    entry.workspace.template.slots = roles.map((role) => ({
      ...entry.workspace.template.slots[0]!,
      id: role,
      role,
    }));
    entry.materialRoleOverrides = { 'clip-0': 'PRODUCT', 'clip-1': null };
    entry.materialRoleEditVersion = 2;
    working.getNodeState.mockResolvedValue({ revision: 7, state });
    const prompt = {
      ...source,
      id: 'prompt-batch',
      nodeId: 'PROMPT_GENERATION',
      artifactKey: 'prompt-batch:p',
      contentHash: 'prompt-hash',
      payload: { items: roles.map((_, index) => ({ id: `p${index}`, content: '原始产品画面' })) },
    };
    const clips = roles.map((_, index) => ({
      ...source,
      id: `clip-${index}`,
      artifactKey: `render-clip:${index}`,
      contentHash: `hash-${index}`,
      storageKey: `video-${index}`,
      payload: {
        ...(source.payload as object),
        promptId: `p${index}`,
        fileObjectId: `file-${index}`,
      },
    }));
    const create = vi.fn().mockResolvedValue({
      kind: 'CREATED',
      run: {
        id: 'ai',
        templateId,
        workflowRunId: 'run',
        targetVariantId: null,
        outputVariantId: null,
        status: 'QUEUED',
        stage: 'CLASSIFYING',
        progress: 0,
        errorCode: null,
        errorMessage: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
    const repository = {
      sourceArtifacts: vi.fn().mockResolvedValue([prompt, ...clips]),
      listRecent: vi.fn().mockResolvedValue([]),
      create,
      find: vi.fn(),
      saveSelection: vi.fn().mockResolvedValue({ count: 1 }),
    };
    const service = new EffectTemplateMixService(
      working as unknown as WorkflowWorkingService,
      repository as unknown as EffectTemplateMixAiRepository,
    );
    await service.createAiRun('project', 'run', templateId, 7, 'key');
    const input = create.mock.calls[0]![0];
    expect(input.snapshot.materialRoleAssignments).toEqual({ 'clip-0': 'PRODUCT' });
    expect(input.snapshot.manualMaterialRoles).toEqual({ 'clip-0': 'PRODUCT' });
    expect(input.initialClassifications).toHaveLength(1);
    expect(input.initialClassifications[0]).toMatchObject({
      materialId: 'clip-0',
      source: 'MANUAL',
    });
    entry.materialRoleOverrides['clip-0'] = 'END';
    expect(input.snapshot.materialRoleAssignments['clip-0']).toBe('PRODUCT');
    repository.find.mockResolvedValue({
      status: 'RUNNING',
      attemptToken: 'attempt',
      inputSnapshot: input.snapshot,
    });
    const rows = roles.map((role, index) => ({
      materialId: `clip-${index}`,
      scores: Object.fromEntries(roles.map((candidate) => [candidate, candidate === role ? 1 : 0])),
      reasons: {},
    }));
    rows[0] = input.initialClassifications[0];
    rows[2]!.scores.HOOK = 0.8;
    const result = await service.classifyAiRun('project', 'ai', 'attempt', rows as never);
    expect(result.selections.find((item) => item.materialId === 'clip-0')?.role).toBe('PRODUCT');
    await expect(
      service.classifyAiRun(
        'project',
        'ai',
        'attempt',
        rows.map((row) => ({ ...row, source: 'AI' })) as never,
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it.each(['foreign-id', 'stale-id'])(
    'rejects assigning a %s material from outside the current pool',
    async (id) => {
      const { service, working } = harness();
      working.listArtifacts.mockResolvedValue({
        items: [source, { ...source, id: 'stale-id', freshness: 'STALE' }],
        total: 2,
      });
      const value = draft();
      value.templates[0]!.materialRoleOverrides = { [id]: 'HOOK' };
      await expect(service.saveDraft('project', 'run', 7, value)).rejects.toMatchObject({
        status: 400,
      });
      expect(working.putNodeState).not.toHaveBeenCalled();
    },
  );

  it('rejects unknown roles and too-short manually assigned materials', async () => {
    const { service } = harness();
    const value = draft();
    value.templates[0]!.materialRoleOverrides = { [sourceId]: 'UNKNOWN' as 'HOOK' };
    await expect(service.saveDraft('project', 'run', 7, value)).rejects.toMatchObject({
      status: 400,
    });
    value.templates[0]!.materialRoleOverrides = { [sourceId]: 'HOOK' };
    value.templates[0]!.workspace.template.slots[0]!.duration = 5;
    await expect(service.saveDraft('project', 'run', 7, value)).rejects.toMatchObject({
      status: 400,
    });
  });
  it('uses only the committed render batch for the cap, not longer clips left in the library', async () => {
    const { service, working } = harness();
    const current = {
      ...source,
      payload: { ...(source.payload as Record<string, unknown>), durationSeconds: 8 },
    };
    const leftover = {
      ...current,
      id: 'leftover',
      artifactKey: 'render-clip:older-task',
      payload: { ...(source.payload as Record<string, unknown>), durationSeconds: 15 },
    };
    const batch = {
      ...source,
      id: 'batch',
      kind: 'STRUCTURED',
      artifactKey: 'render-batch:product',
      payload: { clips: [{ taskId: 'task-1' }] },
    };
    working.listArtifacts.mockResolvedValue({
      items: [current, leftover, batch] as WorkingArtifact[],
      total: 3,
    });
    const value = draft();
    value.templates[0]!.workspace.template.slots[0]!.duration = 8;
    const result = await service.saveDraft('project', 'run', 7, value);
    expect(result.slotDurationMaxSeconds).toBe(8);
    value.templates[0]!.workspace.template.slots[0]!.duration = 9;
    await expect(service.saveDraft('project', 'run', 7, value)).rejects.toMatchObject({
      status: 400,
    });
  });
  it.each([8, 10, 15])(
    'accepts the frozen %s-second upper boundary and rejects an out-of-range draft',
    async (maximum) => {
      const { service, working } = harness();
      const current = {
        ...source,
        payload: { ...(source.payload as Record<string, unknown>), durationSeconds: maximum },
      };
      const stale = {
        ...source,
        id: 'old-long-clip',
        artifactKey: 'render-clip:old',
        freshness: 'STALE',
        payload: { ...(source.payload as Record<string, unknown>), durationSeconds: 20 },
      };
      working.listArtifacts.mockResolvedValue({
        items: [current, stale] as WorkingArtifact[],
        total: 2,
      });
      const value = draft();
      value.templates[0]!.workspace.template.slots[0]!.duration = maximum;
      await expect(service.saveDraft('project', 'run', 7, value)).resolves.toBeDefined();
      working.putNodeState.mockClear();
      value.templates[0]!.workspace.template.slots[0]!.duration = maximum + 0.1;
      await expect(service.saveDraft('project', 'run', 7, value)).rejects.toMatchObject({
        status: 400,
      });
      expect(working.putNodeState).not.toHaveBeenCalled();
      value.templates[0]!.workspace.template.slots[0]!.duration = 3.9;
      await expect(service.saveDraft('project', 'run', 7, value)).rejects.toMatchObject({
        status: 400,
      });
    },
  );

  it('preserves an untouched historical long slot but refuses generating new projects from it', async () => {
    const { service, working } = harness();
    const previous = draft();
    previous.templates[0]!.workspace.template.slots[0]!.duration = 15;
    working.getNodeStateOrNull.mockResolvedValue({ revision: 7, state: previous });
    const edited = structuredClone(previous);
    edited.templates[0]!.workspace.template.name = '仅修改名称';
    await expect(service.saveDraft('project', 'run', 7, edited)).resolves.toBeDefined();
    working.getNodeState.mockResolvedValue({ revision: 7, state: previous });
    await expect(service.createEmptyVariant('project', 'run', templateId, 7)).rejects.toMatchObject(
      { status: 400 },
    );
  });
  it('reads only the saved variant for packaging hot-path source checks', async () => {
    const { service, working } = harness();
    expect((await service.currentVariant('project', 'run', templateId, variantId))?.id).toBe(
      variantId,
    );
    expect(working.getNodeStateOrNull).toHaveBeenCalledWith('project', 'run', 'TEMPLATE_MIX');
    expect(working.listArtifacts).not.toHaveBeenCalled();
    expect(await service.currentVariant('project', 'run', templateId, 'missing')).toBeNull();
    working.getNodeStateOrNull.mockResolvedValue(null);
    expect(await service.currentVariant('project', 'run', templateId, variantId)).toBeNull();
  });
  it('projects persisted stage shard counts and a few real inputs and outputs', async () => {
    const now = new Date('2026-09-23T04:00:00.000Z');
    const inputSnapshot = {
      materials: Array.from({ length: 5 }, (_, index) => ({
        id: `material-${index + 1}`,
        code: `R-${index + 1}`,
        name: `素材 ${index + 1}`,
        duration: 15,
        promptSummary:
          index === 0 ? '木勺将刚出锅的酱汁淋在脆皮鸡块上，突出酥脆与多汁口感' : undefined,
      })),
      template: { name: '跑量模板', slots: [{ id: slotId, label: '片头钩子', duration: 4 }] },
    };
    const repository = {
      find: vi.fn().mockResolvedValue({
        id: 'run-id',
        templateId,
        targetVariantId: null,
        outputVariantId: null,
        status: 'RUNNING',
        stage: 'CLASSIFYING',
        progress: 45,
        errorCode: null,
        errorMessage: null,
        createdAt: now,
        updatedAt: now,
        inputSnapshot,
        classificationResult: [
          {
            materialId: 'material-1',
            scores: { HOOK: 0.91, PAIN_POINT: 0.2, PRODUCT: 0.8 },
            reasons: { HOOK: '酱汁淋下的动作开场醒目，能快速抓住注意力' },
          },
          { materialId: 'material-2', scores: { HOOK: 0.4 }, reasons: { HOOK: '画面信息较少' } },
          {
            materialId: 'material-3',
            scores: { PRODUCT: 0.75 },
            reasons: { PRODUCT: '主体产品清晰' },
          },
        ],
        selectionResult: [
          {
            materialId: 'material-1',
            slotId,
            role: 'HOOK',
            matchScore: 0.91,
            matchLevel: 'NORMAL',
            classificationReason: '酱汁淋下的开场动作最醒目',
            duration: 4,
          },
          {
            materialId: 'material-2',
            slotId,
            role: 'HOOK',
            matchScore: 0.4,
            matchLevel: 'LOW_MATCH',
            classificationReason: '缺少更合适的钩子素材',
            duration: 4,
          },
        ],
        samplingResult: [{ materialId: 'material-1', frameTimestampsSeconds: [0, 1.2, 3.8] }],
        trimResult: [
          {
            materialId: 'material-1',
            slotId,
            trimStartSeconds: 1.25,
            trimReason: '勺子落下并带出酱汁的瞬间，产品状态最清楚',
          },
        ],
      }),
    };
    const service = new EffectTemplateMixService(
      {} as unknown as WorkflowWorkingService,
      repository as unknown as EffectTemplateMixAiRepository,
    );

    const run = await service.aiRun('project', 'run-id');

    expect(run.stageDetails?.CLASSIFYING).toMatchObject({ completed: 3, total: 5 });
    expect(run.stageDetails?.CLASSIFYING?.inputSamples[0]).toContain(
      '创意主线：木勺将刚出锅的酱汁',
    );
    expect(run.stageDetails?.CLASSIFYING?.outputSamples[0]).toContain('片头钩子 91%');
    expect(run.stageDetails?.CLASSIFYING?.outputSamples[0]).toContain('快速抓住注意力');
    expect(run.stageDetails?.MATCHING).toMatchObject({ completed: 1, total: 1 });
    expect(run.stageDetails?.MATCHING?.outputSamples[0]).toContain('匹配度 91%');
    expect(run.stageDetails?.MATCHING?.outputSamples[1]).toContain('备选补位');
    expect(run.stageDetails?.SAMPLING).toMatchObject({ completed: 1, total: 2 });
    expect(run.stageDetails?.SAMPLING?.outputSamples[0]).toContain(
      '抽取 3 张关键帧（0.0 秒、1.2 秒、3.8 秒）',
    );
    expect(run.stageDetails?.TRIMMING?.outputSamples[0]).toContain('截取 1.3–5.3 秒');
    expect(run.stageDetails?.TRIMMING?.outputSamples[0]).toContain('勺子落下并带出酱汁');
    expect(run.stageDetails?.COMPLETED).toMatchObject({ completed: 0, total: 1 });
  });

  it('uses completed trim results as proof of frame extraction for historical runs', async () => {
    const now = new Date('2026-09-23T04:00:00.000Z');
    const repository = {
      find: vi.fn().mockResolvedValue({
        id: 'run-id',
        templateId,
        targetVariantId: null,
        outputVariantId: null,
        status: 'COMPLETED',
        stage: 'COMPLETED',
        progress: 100,
        errorCode: null,
        errorMessage: null,
        createdAt: now,
        updatedAt: now,
        inputSnapshot: {
          materials: [{ id: 'material-1', code: 'R-1', name: '钩子镜头', duration: 15 }],
          template: { name: '跑量模板', slots: [{ id: slotId, label: '片头钩子', duration: 4 }] },
        },
        classificationResult: [],
        selectionResult: [
          { materialId: 'material-1', slotId, role: 'HOOK', variantIndex: 0, duration: 4 },
        ],
        samplingResult: [],
        trimResult: [
          { materialId: 'material-1', slotId, trimStartSeconds: 2, trimReason: '动作完整' },
        ],
      }),
    };
    const service = new EffectTemplateMixService(
      {} as unknown as WorkflowWorkingService,
      repository as unknown as EffectTemplateMixAiRepository,
    );
    const run = await service.aiRun('project', 'run-id');
    expect(run.stageDetails?.SAMPLING).toMatchObject({ completed: 1, total: 1 });
    expect(run.stageDetails?.SAMPLING?.outputSamples[0]).toContain('旧任务记录由截取结果确认');
  });

  it('counts frame extraction by distinct source videos rather than repeated timeline placements', async () => {
    const now = new Date('2026-09-23T04:00:00.000Z');
    const repository = {
      find: vi.fn().mockResolvedValue({
        id: 'run-id',
        templateId,
        targetVariantId: null,
        outputVariantId: null,
        status: 'RUNNING',
        stage: 'SAMPLING',
        progress: 55,
        errorCode: null,
        errorMessage: null,
        createdAt: now,
        updatedAt: now,
        inputSnapshot: {
          materials: [{ id: 'material-1', code: 'R-1', name: '钩子镜头', duration: 15 }],
          template: { slots: [{ id: slotId, label: '片头钩子', duration: 4 }] },
        },
        selectionResult: [
          { materialId: 'material-1', slotId, variantIndex: 0, role: 'HOOK', duration: 4 },
          { materialId: 'material-1', slotId, variantIndex: 1, role: 'HOOK', duration: 4 },
        ],
        samplingResult: [{ materialId: 'material-1', frameTimestampsSeconds: [0.2, 1.5] }],
        classificationResult: [],
        trimResult: [],
      }),
    };
    const service = new EffectTemplateMixService(
      {} as unknown as WorkflowWorkingService,
      repository as unknown as EffectTemplateMixAiRepository,
    );
    const run = await service.aiRun('project', 'run-id');
    expect(run.stageDetails?.SAMPLING).toMatchObject({ completed: 1, total: 1 });
  });

  it('preserves untouched legacy 3-second slots while rejecting newly edited ones', async () => {
    const { service, working } = harness();
    const legacy = draft();
    legacy.templates[0]!.workspace.template.slots[0]!.duration = 3;
    legacy.templates[0]!.workspace.variants[0]!.slots[0]!.duration = 3;
    working.getNodeStateOrNull.mockResolvedValue({ revision: 7, state: legacy });
    const unchanged = JSON.parse(JSON.stringify(legacy)) as EffectTemplateMixDraft;
    unchanged.templates[0]!.workspace.template.name = '更新名称';
    await expect(service.saveDraft('project', 'run', 7, unchanged)).resolves.toBeDefined();
    unchanged.templates[0]!.workspace.template.slots[0]!.label = '新钩子';
    await expect(service.saveDraft('project', 'run', 7, unchanged)).rejects.toMatchObject({
      status: 400,
    });
  });

  it('allows the first 4-second draft without a previous node state', async () => {
    const { service, working } = harness();
    working.getNodeStateOrNull.mockResolvedValue(null);
    const saved = await service.saveDraft('project', 'run', null, draft());
    const createdAt = saved.draft.templates[0]?.createdAt;
    expect(createdAt).toEqual(expect.any(String));
    expect(Number.isNaN(Date.parse(createdAt!))).toBe(false);

    const edited = draft();
    edited.templates[0]!.createdAt = '2000-01-01T00:00:00.000Z';
    working.getNodeStateOrNull.mockResolvedValue({ revision: 8, state: saved.draft });
    await service.saveDraft('project', 'run', 8, edited);
    expect(working.putNodeState.mock.calls[1]?.[3].state.templates[0]?.createdAt).toBe(createdAt);
  });

  it('rejects a new template while the render batch has not succeeded', async () => {
    const { service, working } = harness();
    working.getNodeStateOrNull.mockResolvedValue(null);
    working.listArtifacts.mockResolvedValue({ items: [], total: 0 });

    await expect(service.saveDraft('project', 'run', null, draft())).rejects.toMatchObject({
      status: 409,
    });
    expect(working.putNodeState).not.toHaveBeenCalled();
    expect((await service.workspace('project', 'run')).templateCreationReady).toBe(false);
  });

  it('allows a new template after the render batch succeeds, before render validation', async () => {
    const { working } = harness();
    working.getNodeStateOrNull.mockResolvedValue(null);
    working.listArtifacts.mockResolvedValue({ items: [], total: 0 });
    const repository = {
      hasSuccessfulRenderBatch: vi.fn().mockResolvedValue(true),
      listRecent: vi.fn().mockResolvedValue([]),
      sourceArtifacts: vi.fn().mockResolvedValue([]),
      lockedTemplateIds: vi.fn().mockResolvedValue([]),
      packagedTemplateIds: vi.fn().mockResolvedValue([]),
      activePackagingTemplateIds: vi.fn().mockResolvedValue([]),
    };
    const service = new EffectTemplateMixService(
      working as unknown as WorkflowWorkingService,
      repository as unknown as EffectTemplateMixAiRepository,
    );

    const saved = await service.saveDraft('project', 'run', null, draft());
    expect(saved.templateCreationReady).toBe(true);
    expect(working.putNodeState).toHaveBeenCalledOnce();
  });

  it('deletes an unfilled template from the draft after checking its downstream records', async () => {
    const { working } = harness();
    const repository = {
      templateHasDownstream: vi.fn().mockResolvedValue(false),
      listRecent: vi.fn().mockResolvedValue([]),
      sourceArtifacts: vi.fn().mockResolvedValue([]),
      lockedTemplateIds: vi.fn().mockResolvedValue([]),
      packagedTemplateIds: vi.fn().mockResolvedValue([]),
      activePackagingTemplateIds: vi.fn().mockResolvedValue([]),
    };
    const service = new EffectTemplateMixService(
      working as unknown as WorkflowWorkingService,
      repository as unknown as EffectTemplateMixAiRepository,
    );

    const saved = await service.saveDraft('project', 'run', 7, {
      schemaVersion: 1,
      activeTemplateId: '',
      templates: [],
    });

    expect(repository.templateHasDownstream).toHaveBeenCalledWith('project', 'run', templateId);
    expect(saved.draft.templates).toEqual([]);
    expect(saved.draft.activeTemplateId).toBe('');
    expect(working.putNodeState).toHaveBeenCalledOnce();
  });

  it('refuses to delete a template that already has smart-fill or a downstream branch', async () => {
    const { working } = harness();
    const repository = {
      templateHasDownstream: vi.fn().mockResolvedValue(true),
      listRecent: vi.fn().mockResolvedValue([]),
      sourceArtifacts: vi.fn().mockResolvedValue([]),
      lockedTemplateIds: vi.fn().mockResolvedValue([]),
      packagedTemplateIds: vi.fn().mockResolvedValue([]),
      activePackagingTemplateIds: vi.fn().mockResolvedValue([]),
    };
    const service = new EffectTemplateMixService(
      working as unknown as WorkflowWorkingService,
      repository as unknown as EffectTemplateMixAiRepository,
    );

    await expect(
      service.saveDraft('project', 'run', 7, {
        schemaVersion: 1,
        activeTemplateId: '',
        templates: [],
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(repository.templateHasDownstream).toHaveBeenCalledWith('project', 'run', templateId);
    expect(working.putNodeState).not.toHaveBeenCalled();
  });

  it('does not invent a creation time for a legacy template or trust a client replacement', async () => {
    const { service, working } = harness();
    const edited = draft();
    edited.templates[0]!.createdAt = '2000-01-01T00:00:00.000Z';
    const saved = await service.saveDraft('project', 'run', 7, edited);
    expect(saved.draft.templates[0]?.createdAt).toBeUndefined();
    expect(working.putNodeState.mock.calls[0]?.[3].state.templates[0]?.createdAt).toBeUndefined();
  });

  it('rejects an invalid template creation timestamp', async () => {
    const { service, working } = harness();
    const edited = draft();
    edited.templates[0]!.createdAt = 'not-a-date';
    await expect(service.saveDraft('project', 'run', 7, edited)).rejects.toMatchObject({
      status: 400,
    });
    expect(working.putNodeState).not.toHaveBeenCalled();
  });

  it('rejects newly introduced duplicate template names after whitespace and Unicode normalization', async () => {
    const { service, working } = harness();
    const value = draft();
    const duplicate = JSON.parse(
      JSON.stringify(value.templates[0]),
    ) as (typeof value.templates)[number];
    duplicate.id = 'another-template';
    duplicate.workspace.template.name = '　跑量模板　';
    value.templates.push(duplicate);

    await expect(service.saveDraft('project', 'run', 7, value)).rejects.toMatchObject({
      status: 400,
    });
    expect(working.putNodeState).not.toHaveBeenCalled();
  });

  it('saves template changes after fill and marks them as needing a new fill', async () => {
    const { service, working } = harness();
    working.listArtifacts.mockResolvedValue({
      items: [
        {
          ...source,
          payload: { ...(source.payload as Record<string, unknown>), durationSeconds: 8 },
        },
      ],
      total: 1,
    });
    const value = draft();
    value.templates[0]!.filledTemplateHash = templateConfigurationHash(
      value.templates[0]!.workspace.template,
    );
    value.templates[0]!.workspace.template.slots[0]!.duration = 5;
    working.getNodeStateOrNull.mockResolvedValue({
      revision: 7,
      state: {
        ...value,
        templates: [
          {
            ...value.templates[0]!,
            workspace: {
              ...value.templates[0]!.workspace,
              template: {
                ...value.templates[0]!.workspace.template,
                slots: [{ ...value.templates[0]!.workspace.template.slots[0]!, duration: 4 }],
              },
            },
          },
        ],
      },
    });
    const result = await service.saveDraft('project', 'run', 7, value);
    expect(working.putNodeState).toHaveBeenCalledOnce();
    expect(result.draft.templates[0]?.needsAiFill).toBe(true);
  });

  it('commits a template and timeline with the exact consumed clip revision', async () => {
    const { service, working } = harness();
    const result = await service.validate('project', 'run', 7, templateId);
    expect(result.artifacts).toHaveLength(2);
    const inputs = working.commitValidatedArtifacts.mock.calls[0]![3];
    expect(inputs[1].input.dependencies).toEqual([
      expect.objectContaining({ sourceArtifactId: sourceId, sourceRevision: 2 }),
    ]);
  });

  it('requires the user-triggered trim refresh after a bound render revision advances', async () => {
    const { service, working } = harness();
    const state = draft();
    const variant = state.templates[0]!.workspace.variants[0]!;
    variant.bindingRevisions[variant.slots[0]!.id] = 1;
    working.getNodeState.mockResolvedValue({ revision: 7, state });

    await expect(service.validate('project', 'run', 7, templateId)).rejects.toMatchObject({
      status: 409,
    });
    expect(working.commitValidatedArtifacts).not.toHaveBeenCalled();
  });

  it('rejects a stale browser draft revision', async () => {
    const { service, working } = harness();
    await expect(service.validate('project', 'run', 6, templateId)).rejects.toMatchObject({
      status: 409,
    });
    expect(working.commitValidatedArtifacts).not.toHaveBeenCalled();
  });
  it('validates manual output with decorative empty template slots and one real clip', async () => {
    const { service, working } = harness();
    const state = draft();
    const variant = state.templates[0]!.workspace.variants[0]!;
    const marker = { ...variant.slots[0]!, id: 'empty-sign', duration: 0 };
    variant.slots.unshift(marker);
    variant.conflictSlotIds = [marker.id];
    working.getNodeState.mockResolvedValue({ revision: 7, state });
    const result = await service.prepareValidation('project', 'run', 7, templateId, { manualOutput: true });
    expect(result.variants.map((item) => item.id)).toEqual([variantId]);
  });
  it('validates a caption-only manual output but not an empty sign-only project', async () => {
    const { service, working } = harness();
    const state = draft();
    const variant = state.templates[0]!.workspace.variants[0]!;
    variant.bindings = {};
    variant.captions = [{ id: 'c', text: '标题', start: 0, end: 3 }];
    working.getNodeState.mockResolvedValue({ revision: 7, state });
    expect((await service.prepareValidation('project', 'run', 7, templateId, { manualOutput: true })).variants).toHaveLength(1);
    variant.captions = [];
    await expect(service.prepareValidation('project', 'run', 7, templateId, { manualOutput: true }))
      .rejects.toThrow('没有实际轨道内容');
  });

  it('rejects repeated source clips inside one timeline', async () => {
    const { service, working } = harness();
    const state = draft();
    const variant = state.templates[0]!.workspace.variants[0]!;
    const secondId = 'a980df15-a13d-4ca4-977c-0a754ebc6382';
    variant.slots.push({ ...variant.slots[0]!, id: secondId });
    variant.bindings[secondId] = sourceId;
    variant.bindingRevisions[secondId] = 2;
    working.getNodeState.mockResolvedValue({ revision: 7, state });
    await expect(service.validate('project', 'run', 7, templateId)).rejects.toMatchObject({
      status: 409,
    });
  });

  it('assembles the dedicated workspace from the node draft and confirmed render clips', async () => {
    const { service } = harness();
    const result = await service.workspace('project', 'run');
    expect(result.draftRevision).toBe(7);
    expect(result.materials).toEqual([
      expect.objectContaining({ id: sourceId, artifactRevision: 2, available: true }),
    ]);
  });

  it('uses the stable output FileObject URL when an older render artifact also exposes one', async () => {
    const { service, working } = harness();
    working.listArtifacts.mockResolvedValue({
      items: [
        {
          ...source,
          files: [
            {
              id: 'file-1',
              fileObjectId: 'file-1',
              role: 'SEGMENT_CLIP',
              sortOrder: 0,
              originalFileName: 'clip.mp4',
              mimeType: 'video/mp4',
              sizeBytes: 1,
              sha256: 'sha',
              previewKind: 'VIDEO',
              previewUrl: '/api/projects/project/file-objects/file-1/content',
              contentUrl: '/api/projects/project/file-objects/file-1/content',
              downloadUrl: '/api/projects/project/file-objects/file-1/content?download=true',
            },
          ],
        } as unknown as WorkingArtifact,
      ],
      total: 1,
    });

    const result = await service.workspace('project', 'run');

    expect(result.materials[0]?.contentUrl).toBe(
      '/api/projects/project/file-objects/file-1/content',
    );
  });

  it('exposes the source Prompt on each confirmed material', async () => {
    const prompt = {
      id: 'prompt-artifact',
      nodeId: 'PROMPT_GENERATION',
      artifactKey: 'prompt-batch:product',
      revision: 3,
      contentHash: 'prompt-hash',
      payload: {
        items: [
          {
            id: 'prompt-1',
            code: 'P-001',
            content: '展示腊肠切片的油润质感',
            creativeCore: '暖色餐桌上的产品特写',
          },
        ],
      },
    } as unknown as WorkingArtifact;
    const render = {
      ...source,
      payload: {
        ...(source.payload as Record<string, unknown>),
        promptId: 'prompt-1',
      },
    } as WorkingArtifact;
    const working = {
      getNodeStateOrNull: vi.fn().mockResolvedValue({ revision: 7, state: draft() }),
      listArtifacts: vi.fn().mockResolvedValue({ items: [prompt, render], total: 2 }),
    };
    const service = new EffectTemplateMixService(working as unknown as WorkflowWorkingService);

    const result = await service.workspace('project', 'run');

    expect(result.materials[0]).toMatchObject({
      promptCode: 'P-001',
      promptText: '展示腊肠切片的油润质感',
      promptCreativeCore: '暖色餐桌上的产品特写',
    });
  });

  const batchArtifact = (taskIds: string[]) =>
    ({
      id: 'batch-artifact',
      nodeId: 'SEGMENT_RENDER',
      artifactKey: 'render-batch:product',
      kind: 'STRUCTURED',
      revision: 2,
      availability: 'AVAILABLE',
      freshness: 'CURRENT',
      payload: {
        schemaVersion: 1,
        productId: 'product',
        clips: taskIds.map((taskId) => ({ taskId })),
      },
    }) as unknown as WorkingArtifact;
  const workspaceWith = async (items: WorkingArtifact[]) => {
    const working = {
      getNodeStateOrNull: vi.fn().mockResolvedValue({ revision: 7, state: draft() }),
      listArtifacts: vi.fn().mockResolvedValue({ items, total: items.length }),
    };
    const service = new EffectTemplateMixService(working as unknown as WorkflowWorkingService);
    return service.workspace('project', 'run');
  };

  it('keeps a superseded batch’s clips out of the pool instead of counting them as expired', async () => {
    // A re-render replaces the batch and leaves the old clips behind; only the batch's own clips are
    // still offered by the render node, so the leftover must not read as an expired material.
    const superseded = {
      ...source,
      id: 'superseded-clip',
      artifactKey: 'render-clip:task-2',
      freshness: 'STALE',
    } as WorkingArtifact;

    const result = await workspaceWith([batchArtifact(['task-1']), source, superseded]);

    expect(result.materials.map(({ id }) => id)).toEqual([sourceId]);
  });

  it('still reports a stale clip the current batch lists so a Prompt edit stays visible', async () => {
    const result = await workspaceWith([
      batchArtifact(['task-1']),
      { ...source, freshness: 'STALE' } as WorkingArtifact,
    ]);

    expect(result.materials).toEqual([expect.objectContaining({ id: sourceId, available: false })]);
  });

  it('keeps a superseded clip an existing project is bound to and shows it as expired', async () => {
    // The draft binds this clip, so hiding it would blank the slot instead of telling the user the
    // project still points at a material whose Prompt moved on.
    const result = await workspaceWith([
      batchArtifact(['task-9']),
      { ...source, freshness: 'STALE' } as WorkingArtifact,
    ]);

    expect(result.materials).toEqual([expect.objectContaining({ id: sourceId, available: false })]);
  });

  it('keeps a current clip the batch no longer lists so a bound variant still resolves', async () => {
    // A same-Prompt re-render leaves the previous clips CURRENT, and smart fill reads through
    // `sourceArtifacts`, so it can still pick them: the pool has to keep them reachable.
    const result = await workspaceWith([batchArtifact(['task-9']), source]);

    expect(result.materials).toEqual([expect.objectContaining({ id: sourceId, available: true })]);
  });

  it('offers one card per rendered file when a branch inherits its ancestor’s clips', async () => {
    // Forking a branch clones the render stage, and `listArtifacts` surfaces the ancestor's copies of
    // it too, so the same clip reached the library twice — the same video appeared as two cards. The
    // branch's own artifact is the one its draft binds, so that is the card that has to survive, even
    // when the ancestor's copy is listed first.
    const inherited = {
      ...source,
      id: 'ancestor-clip',
      workflowRunId: 'parent-run',
    } as WorkingArtifact;
    const cloned = { ...source, workflowRunId: 'run' } as WorkingArtifact;

    const result = await workspaceWith([inherited, cloned]);

    expect(result.materials.map(({ id }) => id)).toEqual([sourceId]);
  });

  it('creates and fills exactly one project inside the requested template', async () => {
    const { service, working } = harness();
    const state = draft();
    state.templates[0]!.workspace.variants = [];
    working.getNodeState.mockResolvedValue({ revision: 7, state });

    const result = await service.createVariant('project', 'run', templateId, 7);

    expect(result.draft.templates[0]!.workspace.variants).toHaveLength(1);
    expect(result.draft.templates[0]!.workspace.variants[0]!.bindings[slotId]).toBe(sourceId);
    expect(working.putNodeState).toHaveBeenCalledWith(
      'project',
      'run',
      'TEMPLATE_MIX',
      expect.objectContaining({ expectedRevision: 7 }),
    );
  });

  it('creates an empty project without deterministically filling any slot', async () => {
    const { service, working } = harness();
    const state = draft();
    state.templates[0]!.workspace.variants = [];
    working.getNodeState.mockResolvedValue({ revision: 7, state });

    const result = await service.createEmptyVariant('project', 'run', templateId, 7);
    const created = result.draft.templates[0]!.workspace.variants[0]!;

    expect(created.bindings).toEqual({});
    expect(created.bindingRevisions).toEqual({});
    expect(created.offsets).toEqual({});
    expect(created.conflictSlotIds).toEqual([]);
  });

  it('allows adding empty projects beyond 100 after packaging has locked the template', async () => {
    const { working } = harness();
    const state = draft();
    const first = state.templates[0]!.workspace.variants[0]!;
    state.templates[0]!.workspace.variants = Array.from({ length: 100 }, (_, index) => ({
      ...(JSON.parse(JSON.stringify(first)) as EffectTemplateMixVariant),
      id: `variant-${index}`,
      name: `成片 ${index + 1}`,
    }));
    state.templates[0]!.packagingLocked = true;
    working.getNodeState.mockResolvedValue({ revision: 7, state });
    const aiRuns = {
      packagedTemplateIds: vi.fn().mockResolvedValue([templateId]),
      activePackagingTemplateIds: vi.fn().mockResolvedValue([]),
      // A stale fill lease must not block the additive empty-project operation
      // after packaging has permanently locked the template.
      lockedTemplateIds: vi.fn().mockResolvedValue([templateId]),
      listRecent: vi.fn().mockResolvedValue([]),
      sourceArtifacts: vi.fn().mockResolvedValue([]),
    };
    const service = new EffectTemplateMixService(
      working as unknown as WorkflowWorkingService,
      aiRuns as unknown as EffectTemplateMixAiRepository,
    );

    const result = await service.createEmptyVariant('project', 'run', templateId, 7);

    expect(result.draft.templates[0]!.workspace.variants).toHaveLength(101);
    expect(result.draft.templates[0]!.packagingLocked).toBe(true);
    expect(result.draft.templates[0]!.workspace.variants.at(-1)!.bindings).toEqual({});

    working.getNodeState.mockResolvedValue({ revision: 8, state: result.draft });
    const nextResult = await service.createEmptyVariant('project', 'run', templateId, 8);
    expect(nextResult.draft.templates[0]!.workspace.variants).toHaveLength(102);
  });

  it('allows template configuration edits after packaging so the template can be filled again', async () => {
    const { working } = harness();
    working.listArtifacts.mockResolvedValue({
      items: [
        {
          ...source,
          payload: { ...(source.payload as Record<string, unknown>), durationSeconds: 10 },
        },
      ],
      total: 1,
    });
    const previous = draft();
    previous.templates[0]!.packagingLocked = true;
    const edited = JSON.parse(JSON.stringify(previous)) as EffectTemplateMixDraft;
    edited.templates[0]!.workspace.variants[0]!.offsets[slotId] = 0.5;
    const afterProjectEdit = JSON.parse(JSON.stringify(edited)) as EffectTemplateMixDraft;
    const retimed = JSON.parse(JSON.stringify(afterProjectEdit)) as EffectTemplateMixDraft;
    retimed.templates[0]!.workspace.template.name = '包装后仍可修改的模板名';
    retimed.templates[0]!.workspace.template.slots[0]!.duration = 9;
    working.getNodeStateOrNull
      .mockResolvedValueOnce({ revision: 7, state: previous })
      .mockResolvedValueOnce({ revision: 8, state: afterProjectEdit })
      .mockResolvedValueOnce({ revision: 9, state: retimed });
    const aiRuns = {
      packagedTemplateIds: vi.fn().mockResolvedValue([templateId]),
      activePackagingTemplateIds: vi.fn().mockResolvedValue([]),
      lockedTemplateIds: vi.fn().mockResolvedValue([]),
      listRecent: vi.fn().mockResolvedValue([]),
      sourceArtifacts: vi.fn().mockResolvedValue([]),
    };
    const packageLockedService = new EffectTemplateMixService(
      working as unknown as WorkflowWorkingService,
      aiRuns as unknown as EffectTemplateMixAiRepository,
    );

    await expect(
      packageLockedService.saveDraft('project', 'run', 7, edited),
    ).resolves.toBeDefined();
    expect(edited.templates[0]!.workspace.variants[0]!.offsets[slotId]).toBe(0.5);
    const result = await packageLockedService.saveDraft('project', 'run', 8, retimed);
    expect(result.draft.templates[0]!.workspace.template.name).toBe('包装后仍可修改的模板名');
    expect(result.draft.templates[0]!.workspace.template.slots[0]!.duration).toBe(9);
    // The flag is still reported: it keeps the packaged template out of deletion.
    expect(result.draft.templates[0]!.packagingLocked).toBe(true);
  });

  it('still refuses removing a project the finished package points at', async () => {
    const { working } = harness();
    const previous = draft();
    previous.templates[0]!.packagingLocked = true;
    const removed = JSON.parse(JSON.stringify(previous)) as EffectTemplateMixDraft;
    removed.templates[0]!.workspace.variants = [];
    working.getNodeStateOrNull.mockResolvedValue({ revision: 7, state: previous });
    const aiRuns = {
      packagedTemplateIds: vi.fn().mockResolvedValue([templateId]),
      activePackagingTemplateIds: vi.fn().mockResolvedValue([]),
      lockedTemplateIds: vi.fn().mockResolvedValue([]),
      listRecent: vi.fn().mockResolvedValue([]),
      sourceArtifacts: vi.fn().mockResolvedValue([]),
    };
    const service = new EffectTemplateMixService(
      working as unknown as WorkflowWorkingService,
      aiRuns as unknown as EffectTemplateMixAiRepository,
    );

    await expect(service.saveDraft('project', 'run', 7, removed)).rejects.toMatchObject({
      status: 409,
    });
  });

  it('allows edits to a packaged template while packaging runs from its frozen snapshot', async () => {
    const { working } = harness();
    const state = draft();
    state.templates[0]!.packagingLocked = true;
    working.getNodeState.mockResolvedValue({ revision: 7, state });
    const packaged = {
      packagedTemplateIds: vi.fn().mockResolvedValue([templateId]),
      activePackagingTemplateIds: vi.fn().mockResolvedValue([]),
      lockedTemplateIds: vi.fn().mockResolvedValue([]),
      listRecent: vi.fn().mockResolvedValue([]),
      sourceArtifacts: vi.fn().mockResolvedValue([]),
    };
    const service = new EffectTemplateMixService(
      working as unknown as WorkflowWorkingService,
      packaged as unknown as EffectTemplateMixAiRepository,
    );
    await expect(
      service.applyVariant('project', 'run', templateId, variantId, false, 7),
    ).resolves.toBeDefined();

    const running = new EffectTemplateMixService(
      working as unknown as WorkflowWorkingService,
      {
        ...packaged,
        activePackagingTemplateIds: vi.fn().mockResolvedValue([templateId]),
      } as unknown as EffectTemplateMixAiRepository,
    );
    await expect(
      running.applyVariant('project', 'run', templateId, variantId, false, 7),
    ).resolves.toBeDefined();
  });

  it('allows switching the voice after packaging', async () => {
    const { working } = harness();
    const previous = draft();
    previous.templates[0]!.packagingLocked = true;
    previous.templates[0]!.workspace.template.voiceProfileId = 'voice-a';
    const voiced = JSON.parse(JSON.stringify(previous)) as EffectTemplateMixDraft;
    voiced.templates[0]!.workspace.template.voiceProfileId = 'voice-b';
    working.getNodeStateOrNull.mockResolvedValue({ revision: 7, state: previous });
    const aiRuns = {
      packagedTemplateIds: vi.fn().mockResolvedValue([templateId]),
      activePackagingTemplateIds: vi.fn().mockResolvedValue([]),
      lockedTemplateIds: vi.fn().mockResolvedValue([]),
      listRecent: vi.fn().mockResolvedValue([]),
      sourceArtifacts: vi.fn().mockResolvedValue([]),
    };
    const service = new EffectTemplateMixService(
      working as unknown as WorkflowWorkingService,
      aiRuns as unknown as EffectTemplateMixAiRepository,
    );

    await expect(service.saveDraft('project', 'run', 7, voiced)).resolves.toBeDefined();
    expect(voiced.templates[0]!.workspace.template.voiceProfileId).toBe('voice-b');
  });

  it('allows template configuration changes while packaging runs from its frozen snapshot', async () => {
    const { working } = harness();
    const previous = draft();
    previous.templates[0]!.packagingLocked = true;
    previous.templates[0]!.workspace.template.voiceProfileId = 'voice-a';
    const voiced = JSON.parse(JSON.stringify(previous)) as EffectTemplateMixDraft;
    voiced.templates[0]!.workspace.template.voiceProfileId = 'voice-b';
    working.getNodeStateOrNull.mockResolvedValue({ revision: 7, state: previous });
    const aiRuns = {
      packagedTemplateIds: vi.fn().mockResolvedValue([templateId]),
      // The worker owns a frozen input snapshot and must not lock user edits in this Run.
      activePackagingTemplateIds: vi.fn().mockResolvedValue([templateId]),
      lockedTemplateIds: vi.fn().mockResolvedValue([]),
      listRecent: vi.fn().mockResolvedValue([]),
      sourceArtifacts: vi.fn().mockResolvedValue([]),
    };
    const service = new EffectTemplateMixService(
      working as unknown as WorkflowWorkingService,
      aiRuns as unknown as EffectTemplateMixAiRepository,
    );

    await expect(service.saveDraft('project', 'run', 7, voiced)).resolves.toBeDefined();
    expect(voiced.templates[0]!.workspace.template.voiceProfileId).toBe('voice-b');
  });

  it('rejects a server mutation based on a stale draft revision', async () => {
    const { service, working } = harness();
    await expect(
      service.refillVariant('project', 'run', templateId, variantId, 6),
    ).rejects.toMatchObject({
      status: 409,
    });
    expect(working.putNodeState).not.toHaveBeenCalled();
  });

  it('applies an edited project only inside the requested template', async () => {
    const { service, working } = harness();
    working.listArtifacts.mockResolvedValue({
      items: [
        {
          ...source,
          payload: { ...(source.payload as Record<string, unknown>), durationSeconds: 8 },
        },
      ],
      total: 1,
    });
    const state = draft();
    const isolatedId = 'c61347b7-af3c-4667-a474-25a5c9bb00c1';
    state.templates.push({
      id: isolatedId,
      workspace: JSON.parse(JSON.stringify(state.templates[0]!.workspace)),
    });
    state.templates[0]!.workspace.variants[0]!.slots[0]!.duration = 5;
    working.getNodeState.mockResolvedValue({ revision: 7, state });

    const result = await service.applyVariant('project', 'run', templateId, variantId, true, 7);

    expect(result.draft.templates[0]!.workspace.template.slots[0]!.duration).toBe(5);
    expect(result.draft.templates[1]!.workspace.template.slots[0]!.duration).toBe(4);
  });

  it('freezes original Prompt text without forwarding upstream purpose recommendations', async () => {
    const state = draft();
    const roles = [
      'HOOK',
      'PAIN_POINT',
      'PRODUCT',
      'SELLING_POINT',
      'TRANSFORMATION',
      'END',
    ] as const;
    state.templates[0]!.workspace.template.slots = roles.map((role, index) => ({
      id: `slot-${index}`,
      label: role,
      role,
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
    }));
    state.templates[0]!.workspace.variants = [];
    const now = new Date();
    const promptArtifact = {
      id: 'prompt-artifact',
      nodeId: 'PROMPT_GENERATION',
      artifactKey: 'prompt-batch:product',
      revision: 2,
      contentHash: 'p'.repeat(64),
      payload: {
        items: roles.map((_, index) => ({
          id: `prompt-${index}`,
          content: `原始画面 Prompt ${index}`,
        })),
      },
    };
    const clips = roles.map((_, index) => ({
      id: `material-${index}`,
      nodeId: 'SEGMENT_RENDER',
      artifactKey: `render-clip:${index}`,
      revision: 3,
      contentHash: String(index).repeat(64),
      freshness: 'CURRENT',
      availability: 'AVAILABLE',
      storageKey: `video/${index}.mp4`,
      name: `素材 ${index} 视频片段`,
      payload: {
        promptId: `prompt-${index}`,
        renderCode: `V${index}`,
        durationSeconds: 5,
        contentHash: 'v'.repeat(64),
        fileObjectId: `file-${index}`,
        primaryPurpose: 'HOOK',
        compatiblePurposes: ['HOOK'],
      },
    }));
    const working = {
      getNodeState: vi.fn().mockResolvedValue({ revision: 7, state }),
      beginEffectNodeEdit: vi.fn().mockResolvedValue({
        run: { id: 'run' },
        parentWorkflowRunId: null,
        productIdMap: {},
        taskIdMap: {},
        created: false,
      }),
    };
    const create = vi.fn().mockImplementation((input) =>
      Promise.resolve({
        kind: 'CREATED',
        run: {
          id: 'run-id',
          templateId,
          workflowRunId: input.workflowRunId,
          targetVariantId: null,
          outputVariantId: null,
          status: 'QUEUED',
          stage: 'CLASSIFYING',
          progress: 0,
          errorCode: null,
          errorMessage: null,
          createdAt: now,
          updatedAt: now,
        },
        input,
      }),
    );
    const aiRepository = {
      sourceArtifacts: vi.fn().mockResolvedValue([promptArtifact, ...clips]),
      listRecent: vi.fn().mockResolvedValue([]),
      create,
    };
    const service = new EffectTemplateMixService(
      working as unknown as WorkflowWorkingService,
      aiRepository as unknown as EffectTemplateMixAiRepository,
    );

    await service.createAiRun('project', 'run', templateId, 7, 'key');

    // Re-filling is a full update: it must ask for an isolated child before it reads the draft, and
    // `always` is what makes even the project's first fill land on a branch of its own.
    expect(working.beginEffectNodeEdit).toHaveBeenCalledWith(
      'project',
      'run',
      'TEMPLATE_MIX',
      'BATCH',
      {
        always: true,
        keepParentActive: false,
        creationKey: expect.any(String),
      },
    );
    expect(create.mock.calls[0]![0].workflowRunId).toBe('run');

    const snapshot = create.mock.calls[0]![0].snapshot;
    expect(snapshot.materials[0]).toMatchObject({ prompt: '原始画面 Prompt 0' });
    expect(snapshot.requireAllMaterials).toBe(true);
    expect(snapshot.replaceExistingVariants).toBe(true);
    expect(snapshot.targetVariantId).toBeNull();
    expect(snapshot.maxOutputVariants).toBe(100);
    expect(snapshot.existingVariantBindings).toEqual([]);
    expect(snapshot.workspaceHash).toBe(workflowStateHash(state.templates[0]!.workspace));
    expect(JSON.stringify(snapshot)).not.toContain('primaryPurpose');
    expect(JSON.stringify(snapshot)).not.toContain('compatiblePurposes');

    const legacySnapshot = { ...snapshot };
    delete legacySnapshot.workspaceHash;
    const scores = Object.fromEntries(roles.map((role) => [role, 0.8]));
    const classifications = clips.map((clip) => ({ materialId: clip.id, scores, reasons: {} }));
    const selections = clips.map((clip, index) => ({
      variantIndex: 0,
      slotId: `slot-${index}`,
      materialId: clip.id,
      duration: 4,
      matchScore: 0.8,
      matchLevel: 'HIGH',
      classificationReason: '匹配',
    }));
    const trims = clips.map((clip, index) => ({
      variantIndex: 0,
      slotId: `slot-${index}`,
      materialId: clip.id,
      trimStartSeconds: 0,
      trimReason: '动作完整',
    }));
    aiRepository.listRecent.mockResolvedValue([
      {
        status: 'FAILED',
        templateId,
        inputSnapshot: legacySnapshot,
        classificationResult: classifications,
        selectionResult: selections,
        trimResult: trims.slice(0, 1),
      },
      {
        status: 'FAILED',
        templateId,
        inputSnapshot: legacySnapshot,
        classificationResult: classifications,
        selectionResult: selections,
        trimResult: trims,
      },
    ]);
    const updatedState = JSON.parse(JSON.stringify(state)) as EffectTemplateMixDraft;
    updatedState.templates.push({
      id: 'other-template',
      workspace: JSON.parse(JSON.stringify(state.templates[0]!.workspace)),
    });
    working.getNodeState.mockResolvedValue({ revision: 8, state: updatedState });

    await service.createAiRun('project', 'run', templateId, 8, 'new-key');

    const resumed = create.mock.calls[1]![0];
    expect(resumed.initialClassifications).toHaveLength(6);
    expect(resumed.initialSelections).toHaveLength(6);
    expect(resumed.initialTrims).toHaveLength(6);

    const filledState = JSON.parse(JSON.stringify(state)) as EffectTemplateMixDraft;
    const filledEntry = filledState.templates[0]!;
    const originalSlots = JSON.parse(JSON.stringify(filledEntry.workspace.template.slots));
    filledEntry.workspace.template.editVersion += 1;
    filledEntry.workspace.template.slots = filledEntry.workspace.template.slots.map((slot) => ({
      ...slot,
      duration: 5,
    }));
    filledEntry.workspace.variants.push({
      id: variantId,
      name: '跑量模板 · 1',
      appliedTemplateVersion: 2,
      slots: originalSlots,
      bindings: Object.fromEntries(clips.map((clip, index) => [`slot-${index}`, clip.id])),
      bindingRevisions: Object.fromEntries(clips.map((clip, index) => [`slot-${index}`, 3])),
      offsets: Object.fromEntries(clips.map((clip, index) => [`slot-${index}`, 0])),
      bindingMetadata: {},
      manualSlotIds: [],
      conflictSlotIds: [],
      status: 'CURRENT',
      captions: [],
      subtitleStyle: 'standard',
      bgm: null,
      voice: null,
      originalVolume: 1,
    } as EffectTemplateMixVariant);
    working.getNodeState.mockResolvedValue({ revision: 9, state: filledState });
    aiRepository.listRecent.mockResolvedValue([
      {
        status: 'COMPLETED',
        templateId,
        inputSnapshot: snapshot,
        classificationResult: classifications,
        selectionResult: selections,
        trimResult: trims,
      },
    ]);
    await service.createAiRun('project', 'run', templateId, 9, 'refill-key', variantId);
    const refilling = create.mock.calls[2]![0];
    expect(refilling.initialSelections).toHaveLength(6);
    expect(refilling.initialSelections).toEqual(
      expect.arrayContaining(
        clips.map((clip, index) =>
          expect.objectContaining({ slotId: `slot-${index}`, materialId: clip.id, duration: 5 }),
        ),
      ),
    );
    expect(refilling.initialClassifications).toHaveLength(6);

    // A regeneration that does have a published version to protect lands in the forked child, and
    // the DTO tells the editor which Run it has to follow.
    working.beginEffectNodeEdit.mockResolvedValue({
      run: { id: 'child-run' },
      parentWorkflowRunId: 'run',
      productIdMap: {},
      taskIdMap: {},
      created: true,
    });
    const forked = await service.createAiRun(
      'project',
      'run',
      templateId,
      9,
      'fork-key',
      variantId,
    );
    expect(create.mock.calls[3]![0].workflowRunId).toBe('child-run');
    expect(forked.workflowRunId).toBe('child-run');

    // A transport failure before the first trim must still reuse confirmed classification
    // and server-selected bindings, rather than paying to classify the whole pool again.
    working.getNodeState.mockResolvedValue({ revision: 7, state });
    working.beginEffectNodeEdit.mockResolvedValue({
      run: { id: 'run' },
      parentWorkflowRunId: null,
      productIdMap: {},
      taskIdMap: {},
      created: false,
    });
    aiRepository.listRecent.mockResolvedValue([
      {
        status: 'FAILED',
        templateId,
        inputSnapshot: snapshot,
        classificationResult: classifications,
        selectionResult: selections,
        trimResult: [],
      },
    ]);
    await service.createAiRun('project', 'run', templateId, 7, 'zero-trim-key');
    expect(create.mock.calls[4]![0].initialClassifications).toHaveLength(6);
    expect(create.mock.calls[4]![0].initialSelections).toHaveLength(6);
    expect(create.mock.calls[4]![0].initialTrims).toEqual([]);

    aiRepository.listRecent.mockResolvedValue([
      {
        status: 'FAILED',
        templateId,
        inputSnapshot: snapshot,
        classificationResult: classifications,
        selectionResult: selections,
        trimResult: null,
      },
    ]);
    await service.createAiRun('project', 'run', templateId, 7, 'null-trim-key');
    expect(create.mock.calls[5]![0].initialClassifications).toHaveLength(6);
    expect(create.mock.calls[5]![0].initialSelections).toHaveLength(6);
    expect(create.mock.calls[5]![0].initialTrims).toEqual([]);

    aiRepository.listRecent.mockResolvedValue([
      {
        status: 'FAILED',
        templateId,
        inputSnapshot: snapshot,
        classificationResult: classifications,
        selectionResult: [{ ...selections[0], materialId: 'foreign-material' }],
        trimResult: [],
      },
    ]);
    await service.createAiRun('project', 'run', templateId, 7, 'invalid-zero-trim-key');
    expect(create.mock.calls[6]![0].initialSelections).toBeUndefined();

    // An independent import owns its editable description; it must not borrow an upstream
    // Prompt with a coincident ID. A 4-second import cannot join any of these 5-second slots.
    const importedClip = {
      ...clips[0]!,
      id: 'imported-picture',
      artifactKey: 'render-clip:imported',
      payload: {
        ...clips[0]!.payload,
        origin: 'EXTERNAL_IMPORT',
        promptText: '独立视频的用户描述',
        importedMaterial: { schemaVersion: 1 },
        fileObjectId: 'independent-file',
      },
    };
    const shortImport = {
      ...importedClip,
      id: 'short-import',
      artifactKey: 'render-clip:short-import',
      payload: {
        ...importedClip.payload,
        promptId: 'short-prompt',
        fileObjectId: 'short-file',
        durationSeconds: 4,
      },
    };
    const importState = structuredClone(state);
    importState.templates[0]!.workspace.template.slots.forEach((slot) => {
      slot.duration = 5;
    });
    working.getNodeState.mockResolvedValue({ revision: 7, state: importState });
    aiRepository.sourceArtifacts.mockResolvedValue([
      promptArtifact,
      ...clips.slice(1),
      importedClip,
      shortImport,
    ]);
    await service.createAiRun('project', 'run', templateId, 7, 'import-key');
    const importSnapshot = create.mock.calls[7]![0].snapshot;
    expect(importSnapshot.durationFilteredImports).toBe(true);
    expect(importSnapshot.materials).toHaveLength(6);
    expect(
      importSnapshot.materials.some((material: { id: string }) => material.id === 'short-import'),
    ).toBe(false);
    expect(
      importSnapshot.materials.find(
        (material: { id: string }) => material.id === 'imported-picture',
      ),
    ).toMatchObject({
      prompt: '独立视频的用户描述',
    });
    expect(importSnapshot.promptArtifacts).toContainEqual(
      expect.objectContaining({ id: importedClip.id, revision: importedClip.revision }),
    );
  });

  it('starts a refill on a template that has already been packaged', async () => {
    // A fill lands on a branch of its own, so a finished package is a result to leave alone rather
    // than a reason to refuse the fill. Only packaging that is still running blocks it, and that is
    // enforced inside the repository's transaction.
    const roles = [
      'HOOK',
      'PAIN_POINT',
      'PRODUCT',
      'SELLING_POINT',
      'TRANSFORMATION',
      'END',
    ] as const;
    const state = draft();
    state.templates[0]!.workspace.template.slots = roles.map((role, index) => ({
      id: `slot-${index}`,
      label: role,
      role,
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
    }));
    state.templates[0]!.workspace.variants = [];
    const promptArtifact = {
      id: 'prompt-artifact',
      nodeId: 'PROMPT_GENERATION',
      artifactKey: 'prompt-batch:product',
      revision: 2,
      contentHash: 'p'.repeat(64),
      payload: {
        items: roles.map((_, index) => ({ id: `prompt-${index}`, content: `Prompt ${index}` })),
      },
    };
    const clips = roles.map((_, index) => ({
      ...source,
      id: `material-${index}`,
      artifactKey: `render-clip:${index}`,
      storageKey: `video/${index}.mp4`,
      payload: {
        promptId: `prompt-${index}`,
        renderCode: `V${index}`,
        durationSeconds: 4,
        contentHash: `${index}`.repeat(64),
        fileObjectId: `file-${index}`,
        primaryPurpose: 'HOOK',
        compatiblePurposes: ['HOOK'],
      },
    }));
    const working = {
      getNodeState: vi.fn().mockResolvedValue({ revision: 7, state }),
      beginEffectNodeEdit: vi.fn().mockResolvedValue({
        run: { id: 'packaged-run' },
        parentWorkflowRunId: 'run',
        productIdMap: {},
        taskIdMap: {},
        created: true,
      }),
    };
    const create = vi.fn().mockResolvedValue({
      kind: 'CREATED',
      run: {
        id: 'fill-run',
        templateId,
        workflowRunId: 'packaged-run',
        targetVariantId: null,
        outputVariantId: null,
        status: 'QUEUED',
        stage: 'CLASSIFYING',
        progress: 0,
        errorCode: null,
        errorMessage: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
    const aiRepository = {
      sourceArtifacts: vi.fn().mockResolvedValue([promptArtifact, ...clips]),
      listRecent: vi.fn().mockResolvedValue([]),
      // The template already owns a CURRENT timeline-package in the Run the fill forked from.
      packagedTemplateIds: vi.fn().mockResolvedValue([templateId]),
      create,
    };
    const service = new EffectTemplateMixService(
      working as unknown as WorkflowWorkingService,
      aiRepository as unknown as EffectTemplateMixAiRepository,
    );

    await expect(
      service.createAiRun('project', 'run', templateId, 7, 'key'),
    ).resolves.toMatchObject({ workflowRunId: 'packaged-run' });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('fills from scratch when a fresh branch cannot reach the assignment it forked from', async () => {
    // A re-fill on an already assigned project used to be refused unless the classification behind
    // that assignment could be reused — but the fill always forks, and cloning re-identifies the
    // materials, so on a fresh branch the history never matches and every re-fill failed with
    // 找不到完整的历史归槽结果. It now classifies and assigns from scratch instead.
    const roles = [
      'HOOK',
      'PAIN_POINT',
      'PRODUCT',
      'SELLING_POINT',
      'TRANSFORMATION',
      'END',
    ] as const;
    const state = draft();
    state.templates[0]!.workspace.template.slots = roles.map((role, index) => ({
      id: `slot-${index}`,
      label: role,
      role,
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
    }));
    state.templates[0]!.workspace.variants = [];
    const promptArtifact = {
      id: 'prompt-artifact',
      nodeId: 'PROMPT_GENERATION',
      artifactKey: 'prompt-batch:product',
      revision: 2,
      contentHash: 'p'.repeat(64),
      payload: {
        items: roles.map((_, index) => ({ id: `prompt-${index}`, content: `Prompt ${index}` })),
      },
    };
    const clips = roles.map((_, index) => ({
      ...source,
      id: `material-${index}`,
      artifactKey: `render-clip:${index}`,
      storageKey: `video/${index}.mp4`,
      payload: {
        promptId: `prompt-${index}`,
        renderCode: `V${index}`,
        durationSeconds: 4,
        contentHash: `${index}`.repeat(64),
        fileObjectId: `file-${index}`,
        primaryPurpose: 'HOOK',
        compatiblePurposes: ['HOOK'],
      },
    }));
    const working = {
      getNodeState: vi.fn().mockResolvedValue({ revision: 7, state }),
      beginEffectNodeEdit: vi.fn().mockResolvedValue({
        run: { id: 'child-run' },
        parentWorkflowRunId: 'run',
        productIdMap: {},
        taskIdMap: {},
        created: true,
      }),
    };
    const create = vi.fn().mockImplementation((input) =>
      Promise.resolve({
        kind: 'CREATED',
        run: {
          id: 'fill-run',
          templateId,
          workflowRunId: input.workflowRunId,
          targetVariantId: null,
          outputVariantId: null,
          status: 'QUEUED',
          stage: 'CLASSIFYING',
          progress: 0,
          errorCode: null,
          errorMessage: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      }),
    );
    const listRecent = vi.fn().mockResolvedValue([]);
    const aiRepository = {
      sourceArtifacts: vi.fn().mockResolvedValue([promptArtifact, ...clips]),
      listRecent,
      create,
    };
    const service = new EffectTemplateMixService(
      working as unknown as WorkflowWorkingService,
      aiRepository as unknown as EffectTemplateMixAiRepository,
    );

    // The first fill on the branch has nothing assigned yet, so it needs no history.
    await service.createAiRun('project', 'run', templateId, 7, 'first-key');
    const snapshot = create.mock.calls[0]![0].snapshot;

    // The branch the re-fill runs in knows the fill that produced this project, so the assignment can
    // still be reused when the history is genuinely reachable.
    const scores = Object.fromEntries(roles.map((role) => [role, 0.8]));
    listRecent.mockResolvedValue([
      {
        status: 'COMPLETED',
        templateId,
        inputSnapshot: snapshot,
        classificationResult: clips.map((clip) => ({ materialId: clip.id, scores, reasons: {} })),
      },
    ]);
    state.templates[0]!.workspace.variants.push({
      id: variantId,
      name: '跑量模板 · 1',
      appliedTemplateVersion: 2,
      slots: JSON.parse(JSON.stringify(state.templates[0]!.workspace.template.slots)),
      bindings: Object.fromEntries(clips.map((clip, index) => [`slot-${index}`, clip.id])),
      bindingRevisions: Object.fromEntries(clips.map((_clip, index) => [`slot-${index}`, 3])),
      offsets: Object.fromEntries(clips.map((_clip, index) => [`slot-${index}`, 0])),
      bindingMetadata: {},
      manualSlotIds: [],
      conflictSlotIds: [],
      status: 'CURRENT',
      captions: [],
      subtitleStyle: 'standard',
      bgm: null,
      voice: null,
      originalVolume: 1,
    } as EffectTemplateMixVariant);
    working.getNodeState.mockResolvedValue({ revision: 8, state });

    await service.createAiRun('project', 'run', templateId, 8, 'refill-key', variantId);

    const refill = create.mock.calls[1]![0];
    expect(refill.workflowRunId).toBe('child-run');
    expect(refill.initialClassifications).toHaveLength(6);
    expect(refill.initialSelections).toHaveLength(6);

    // A fresh branch has no history at all, because cloning re-identifies the materials, so the
    // classification that produced the current assignment is unreachable. The fill then starts from
    // scratch instead of refusing — the branch it lands on is new, so nothing the user already has is
    // overwritten.
    listRecent.mockResolvedValue([]);
    await service.createAiRun('project', 'run', templateId, 8, 'no-history-key', variantId);
    const fromScratch = create.mock.calls[2]![0];
    expect(fromScratch.workflowRunId).toBe('child-run');
    expect(fromScratch.initialSelections).toBeUndefined();
    expect(fromScratch.initialClassifications).toBeUndefined();

    // Even pure additions (including new clips edited before their first fill) trigger a full
    // classification for a new batch. Existing manual roles, selections and trims cannot leak in.
    Object.assign(promptArtifact, { freshness: 'CURRENT', availability: 'AVAILABLE' });
    const baseline = { status: 'COMPLETED', templateId, inputSnapshot: snapshot,
      classificationResult: snapshot.materials.map((clip: { id: string }) => ({ materialId: clip.id, scores, reasons: {} })) };
    listRecent.mockResolvedValue([baseline]);
    const newClip = { ...clips[0]!, id: 'new-material', artifactKey: 'render-clip:new', revision: 9,
      payload: { ...clips[0]!.payload, promptId: 'new-prompt', renderCode: 'VNEW', fileObjectId: 'new-file', durationSeconds: 6 } };
    promptArtifact.payload.items.push({ id: 'new-prompt', content: '新增后又编辑的画面' });
    Object.assign(state.templates[0]!, { materialRoleOverrides: { 'material-0': 'HOOK', 'new-material': 'PRODUCT' } });
    aiRepository.sourceArtifacts.mockResolvedValue([promptArtifact, ...clips, newClip]);
    await service.createAiRun('project', 'run', templateId, 8, 'pure-add-refill');
    const additions = create.mock.calls[3]![0];
    expect(additions.initialClassifications).toBeUndefined();
    expect(additions.initialSelections).toBeUndefined();
    expect(additions.initialTrims).toBeUndefined();
    expect(additions.snapshot).toMatchObject({ replaceExistingVariants: true, requireAllMaterials: true });
    expect(additions.snapshot.materials).toHaveLength(7);
    expect(additions.snapshot.materialRoleAssignments).toEqual({});
    expect(additions.snapshot.manualMaterialRoles).toEqual({});
    expect(additions.snapshot.incremental).toBeUndefined();

    // Locally adopting a source into the timeline must not turn the next full fill into a reuse.
    const changedOld = { ...clips[0]!, revision: 4,
      payload: { ...clips[0]!.payload, fileObjectId: 'edited-old-file' } };
    state.templates[0]!.workspace.variants[0]!.bindingRevisions['slot-0'] = 4;
    aiRepository.sourceArtifacts.mockResolvedValue([promptArtifact, changedOld, ...clips.slice(1), newClip]);
    await service.createAiRun('project', 'run', templateId, 8, 'mixed-refill');
    const mixed = create.mock.calls[4]![0];
    expect(mixed.initialClassifications).toBeUndefined();
    expect(mixed.snapshot.materialRoleAssignments).toEqual({});
    expect(mixed.snapshot.materials[0].fileObjectId).toBe('edited-old-file');

    Object.assign(state.templates[0]!, { materialRoleOverrides: {} });

    aiRepository.sourceArtifacts.mockResolvedValue([promptArtifact, ...clips.slice(1), newClip,
      { ...newClip, id: 'second-added', artifactKey: 'render-clip:second-added',
        payload: { ...newClip.payload, fileObjectId: 'second-added-file' } }]);
    await service.createAiRun('project', 'run', templateId, 8, 'deleted-and-added-refill');
    const deletion = create.mock.calls[5]![0];
    expect(deletion.initialClassifications).toBeUndefined();
    expect(deletion.snapshot.materialRoleAssignments).toEqual({});
    expect(deletion.snapshot.materials.some((m: { fileObjectId: string }) => m.fileObjectId === 'file-0')).toBe(false);

    aiRepository.sourceArtifacts.mockResolvedValue([promptArtifact, changedOld, ...clips.slice(1)]);
    await service.createAiRun('project', 'run', templateId, 8, 'edited-only-refill');
    expect(create.mock.calls[6]![0].initialClassifications).toBeUndefined();
    expect(create.mock.calls[6]![0].snapshot.materials).toHaveLength(6);
    aiRepository.sourceArtifacts.mockResolvedValue([promptArtifact, ...clips.slice(1)]);
    await expect(service.createAiRun('project', 'run', templateId, 8, 'deleted-only-refill'))
      .rejects.toThrow('不足以再生成一条完整成片');
    expect(create).toHaveBeenCalledTimes(7);
  });

  it('confirms the filled timeline as this Run’s mix version so the tree stops showing a draft', async () => {
    // A finished smart fill is a paid regeneration of the mix node, so the timeline it just wrote is
    // the node's version from that moment on — the same way a completed render batch confirms the
    // render node. Without this the branch tree shows 待校验 and packaging has no version to fork from.
    const { working } = harness();
    const snapshot = {
      schemaVersion: 1,
      template: {
        id: templateId,
        name: '跑量模板',
        editVersion: 2,
        slots: [{ id: slotId, role: 'HOOK', label: '片头钩子', duration: 4, transition: '硬切' }],
      },
      draftRevision: 7,
      targetVariantId: variantId,
      maxOutputVariants: 1,
      lockedBindings: [],
      existingVariantBindings: [],
      reuseCounts: {},
      promptArtifacts: [],
      materials: [
        {
          id: sourceId,
          duration: 4,
          artifactId: sourceId,
          artifactRevision: 2,
          fileObjectId: 'file-1',
        },
      ],
    };
    const scores = {
      HOOK: 0.9,
      PAIN_POINT: 0.8,
      PRODUCT: 0.8,
      SELLING_POINT: 0.8,
      TRANSFORMATION: 0.8,
      END: 0.8,
    };
    const classifications = [{ materialId: sourceId, scores, reasons: {} }];
    const selections = [
      {
        variantIndex: 0,
        slotId,
        materialId: sourceId,
        duration: 4,
        matchScore: 0.9,
        matchLevel: 'HIGH',
        classificationReason: '动作完整',
      },
    ];
    const trims = [
      {
        variantIndex: 0,
        slotId,
        materialId: sourceId,
        trimStartSeconds: 0,
        trimReason: '动作完整',
      },
    ];
    const now = new Date('2026-09-29T04:00:00.000Z');
    const aiRuns = {
      find: vi.fn().mockResolvedValue({
        id: 'ai-run',
        templateId,
        workflowRunId: 'run',
        targetVariantId: variantId,
        outputVariantId: null,
        status: 'RUNNING',
        stage: 'FILLING',
        progress: 80,
        attemptToken: 'token',
        inputSnapshot: snapshot,
        classificationResult: classifications,
        selectionResult: selections,
        trimResult: trims,
        errorCode: null,
        errorMessage: null,
        createdAt: now,
        updatedAt: now,
      }),
      sourceArtifacts: vi.fn().mockResolvedValue([source]),
      completeWithDraft: vi.fn().mockResolvedValue('COMPLETED'),
    };
    const service = new EffectTemplateMixService(
      working as unknown as WorkflowWorkingService,
      aiRuns as unknown as EffectTemplateMixAiRepository,
    );

    await service.completeAiRun('project', 'ai-run', 'token', trims);

    expect(working.commitValidatedArtifacts).toHaveBeenCalledWith(
      'project',
      'run',
      'TEMPLATE_MIX',
      expect.arrayContaining([
        expect.objectContaining({ artifactKey: 'mix-template:' + templateId }),
        expect.objectContaining({
          artifactKey: 'timeline-project:' + templateId + ':' + variantId,
        }),
      ]),
    );
    expect(working.publishEffectNodeEdit).toHaveBeenCalledWith('project', 'run', 'TEMPLATE_MIX');
  });

  it('creates a trim-only refresh for changed clips without changing their slot assignments', async () => {
    const roles = [
      'HOOK',
      'PAIN_POINT',
      'PRODUCT',
      'SELLING_POINT',
      'TRANSFORMATION',
      'END',
    ] as const;
    const state = draft();
    const entry = state.templates[0]!;
    entry.workspace.template.slots = roles.map((role, index) => ({
      id: `refresh-slot-${index}`,
      label: `槽位 ${index + 1}`,
      role,
      purpose: 'HOOK',
      duration: 4,
      transition: '硬切',
    }));
    entry.workspace.variants = [
      {
        id: variantId,
        name: '跑量模板 · 1',
        appliedTemplateVersion: entry.workspace.template.editVersion,
        slots: JSON.parse(
          JSON.stringify(entry.workspace.template.slots),
        ) as typeof entry.workspace.template.slots,
        bindings: Object.fromEntries(
          roles.map((_, index) => [`refresh-slot-${index}`, `material-${index}`]),
        ),
        bindingRevisions: Object.fromEntries(roles.map((_, index) => [`refresh-slot-${index}`, 2])),
        offsets: Object.fromEntries(roles.map((_, index) => [`refresh-slot-${index}`, 0])),
        manualSlotIds: [],
        conflictSlotIds: [],
        status: 'CURRENT',
        captions: [],
        subtitleStyle: 'standard',
        bgm: null,
        voice: null,
        originalVolume: 1,
      } as EffectTemplateMixVariant,
    ];
    const promptArtifact = {
      id: 'prompt-artifact',
      nodeId: 'PROMPT_GENERATION',
      artifactKey: 'prompt-batch:product',
      revision: 3,
      contentHash: 'p'.repeat(64),
      payload: {
        items: roles.map((_, index) => ({ id: `prompt-${index}`, content: `Prompt ${index}` })),
      },
    };
    const clips = roles.map((_, index) => ({
      id: `material-${index}`,
      nodeId: 'SEGMENT_RENDER',
      artifactKey: `render-clip:${index}`,
      revision: index === 2 ? 3 : 2,
      contentHash: `${index}`.repeat(64),
      freshness: 'CURRENT',
      availability: 'AVAILABLE',
      storageKey: `video/${index}.mp4`,
      name: `素材 ${index} 视频片段`,
      payload: {
        promptId: `prompt-${index}`,
        renderCode: `V${index}`,
        durationSeconds: 5,
        contentHash: 'v'.repeat(64),
        fileObjectId: `file-${index}`,
        primaryPurpose: 'HOOK',
        compatiblePurposes: ['HOOK'],
      },
    }));
    const working = {
      getNodeState: vi.fn().mockResolvedValue({ revision: 11, state }),
      beginEffectNodeEdit: vi.fn().mockResolvedValue({
        run: { id: 'run' },
        parentWorkflowRunId: null,
        productIdMap: {},
        taskIdMap: {},
        created: false,
      }),
    };
    const create = vi.fn().mockResolvedValue({
      kind: 'CREATED',
      run: {
        id: 'refresh-run',
        templateId,
        workflowRunId: 'run',
        targetVariantId: variantId,
        outputVariantId: null,
        status: 'QUEUED',
        stage: 'TRIMMING',
        progress: 0,
        errorCode: null,
        errorMessage: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
    const aiRepository = {
      sourceArtifacts: vi.fn().mockResolvedValue([promptArtifact, ...clips]),
      listRecent: vi.fn().mockResolvedValue([]),
      // A completed package normally locks the template. The explicit
      // trim-only refresh is allowed; active packaging is still blocked by
      // the repository's transactional guard.
      packagedTemplateIds: vi.fn().mockResolvedValue([templateId]),
      create,
    };
    const service = new EffectTemplateMixService(
      working as unknown as WorkflowWorkingService,
      aiRepository as unknown as EffectTemplateMixAiRepository,
    );

    await service.createAiRun('project', 'run', templateId, 11, 'refresh-key', variantId, true);

    const input = create.mock.calls[0]![0];
    expect(input.snapshot).toMatchObject({
      trimOnly: true,
      targetVariantId: variantId,
      refreshBindings: [
        { slotId: 'refresh-slot-2', materialId: 'material-2', artifactRevision: 3 },
      ],
    });
    expect(input.snapshot.lockedBindings).toHaveLength(5);
    expect(input.snapshot.trimOnly).toBe(true);
    expect(input.initialSelections).toHaveLength(1);
    expect(input.initialSelections[0]).toMatchObject({
      slotId: 'refresh-slot-2',
      materialId: 'material-2',
      duration: 4,
    });
    expect(input.initialClassifications).toBeUndefined();
  });

  it('persists a partial Prompt-classification shard for lease-safe resume', async () => {
    const materialId = 'material-1';
    const classifications = [
      {
        materialId,
        scores: {
          HOOK: 0.9,
          PAIN_POINT: 0.1,
          PRODUCT: 0.2,
          SELLING_POINT: 0.3,
          TRANSFORMATION: 0.4,
          END: 0.1,
        },
        reasons: {
          HOOK: 'Prompt 中存在开场动作',
          PAIN_POINT: '未明显体现痛点',
          PRODUCT: '产品可见',
          SELLING_POINT: '卖点较弱',
          TRANSFORMATION: '没有结果对比',
          END: '没有收尾动作',
        },
      },
    ];
    const aiRepository = {
      find: vi.fn().mockResolvedValue({
        status: 'RUNNING',
        attemptToken: 'attempt-token',
        inputSnapshot: {
          materials: [{ id: materialId }, { id: 'material-2' }],
        },
      }),
      saveClassificationCheckpoint: vi.fn().mockResolvedValue({
        kind: 'SAVED',
        classifications,
        progress: 20,
      }),
    };
    const service = new EffectTemplateMixService(
      {} as WorkflowWorkingService,
      aiRepository as unknown as EffectTemplateMixAiRepository,
    );

    await expect(
      service.checkpointAiClassifications('project', 'run', 'attempt-token', classifications),
    ).resolves.toEqual({ classifications, progress: 20 });
    expect(aiRepository.saveClassificationCheckpoint).toHaveBeenCalledWith(
      'project',
      'run',
      'attempt-token',
      classifications,
    );
  });

  it('persists only selected-material sampling checkpoints', async () => {
    const materialId = 'material-1';
    const aiRepository = {
      find: vi.fn().mockResolvedValue({
        status: 'RUNNING',
        attemptToken: 'attempt-token',
        inputSnapshot: { materials: [{ id: materialId, duration: 10 }] },
        selectionResult: [{ materialId, duration: 4 }],
      }),
      saveSamplingCheckpoint: vi.fn().mockResolvedValue({
        kind: 'SAVED',
        materialIds: [materialId],
        samples: [{ materialId, frameTimestampsSeconds: [0.2, 5.5] }],
      }),
    };
    const service = new EffectTemplateMixService(
      {} as unknown as WorkflowWorkingService,
      aiRepository as unknown as EffectTemplateMixAiRepository,
    );

    await expect(
      service.checkpointAiSampling('project', 'run', 'attempt-token', {
        samples: [{ materialId, frameTimestampsSeconds: [0.2, 5.5] }],
      }),
    ).resolves.toEqual({
      materialIds: [materialId],
      samples: [{ materialId, frameTimestampsSeconds: [0.2, 5.5] }],
    });
    expect(aiRepository.saveSamplingCheckpoint).toHaveBeenCalledWith(
      'project',
      'run',
      'attempt-token',
      [{ materialId, frameTimestampsSeconds: [0.2, 5.5] }],
    );
    await expect(
      service.checkpointAiSampling('project', 'run', 'attempt-token', {
        materialIds: ['unselected'],
      }),
    ).rejects.toThrow('关键帧进度分片无效');
  });

  it('persists partial AI trim results for batch resume', async () => {
    const trims = [
      {
        variantIndex: 1,
        slotId,
        materialId: sourceId,
        trimStartSeconds: 0.5,
        trimReason: '动作完整',
      },
    ];
    const aiRepository = {
      find: vi.fn().mockResolvedValue({
        status: 'RUNNING',
        attemptToken: 'attempt-token',
        inputSnapshot: { materials: [{ id: sourceId, duration: 5 }] },
        selectionResult: [
          {
            variantIndex: 1,
            slotId,
            materialId: sourceId,
            duration: 4,
          },
        ],
      }),
      saveTrimCheckpoint: vi.fn().mockResolvedValue({
        kind: 'SAVED',
        trims,
        progress: 72,
      }),
    };
    const service = new EffectTemplateMixService(
      {} as WorkflowWorkingService,
      aiRepository as unknown as EffectTemplateMixAiRepository,
    );

    await expect(
      service.checkpointAiTrims('project', 'run', 'attempt-token', trims),
    ).resolves.toEqual({ trims, progress: 72 });
  });

  const promptBatch = {
    id: 'prompt-artifact',
    nodeId: 'PROMPT_GENERATION',
    artifactKey: 'prompt-batch:product',
    revision: 3,
    contentHash: 'prompt-hash',
    availability: 'AVAILABLE',
    freshness: 'CURRENT',
  } as unknown as WorkingArtifact;
  const scores = Object.fromEntries(
    ['HOOK', 'PAIN_POINT', 'PRODUCT', 'SELLING_POINT', 'TRANSFORMATION', 'END'].map((role) => [
      role,
      0.9,
    ]),
  );
  const inheritedFill = (overrides: Record<string, unknown> = {}) => ({
    id: 'ancestor-fill',
    templateId,
    status: 'COMPLETED',
    createdAt: new Date('2026-09-29T04:00:00.000Z'),
    inputSnapshot: {
      template: { name: '跑量模板', slots: [{ id: slotId, role: 'HOOK', label: '片头钩子' }] },
      materials: [
        {
          id: 'ancestor-clip',
          artifactId: 'ancestor-clip',
          artifactKey: 'render-clip:task-1',
          artifactRevision: 99,
          contentHash: 'ancestor-hash',
          fileObjectId: 'file-1',
          promptId: 'ancestor-prompt',
        },
      ],
      promptArtifacts: [
        {
          id: 'ancestor-prompt-artifact',
          artifactKey: 'prompt-batch:ancestor',
          revision: 9,
          contentHash: 'ancestor-prompt-hash',
        },
      ],
    },
    classificationResult: [{ materialId: 'ancestor-clip', scores, reasons: {} }],
    ...overrides,
  });
  const workspaceWithInherited = async (inherited: unknown[]) => {
    // The committed row carries the hash the pool guard compares, not the one in the clip payload.
    const clip = { ...source, contentHash: 'sha' } as unknown as WorkingArtifact;
    const working = {
      getNodeStateOrNull: vi.fn().mockResolvedValue({ revision: 7, state: draft() }),
      listArtifacts: vi.fn().mockResolvedValue({ items: [promptBatch, clip], total: 2 }),
    };
    const aiRepository = {
      listRecent: vi.fn().mockResolvedValue([]),
      sourceArtifacts: vi.fn().mockResolvedValue([promptBatch, clip]),
      inheritedMixAiRuns: vi.fn().mockResolvedValue(inherited),
    };
    const service = new EffectTemplateMixService(
      working as unknown as WorkflowWorkingService,
      aiRepository as unknown as EffectTemplateMixAiRepository,
    );
    return service.workspace('project', 'run');
  };

  it('reads the pool out of a fill the branch inherited from an ancestor', async () => {
    // The snapshot names the ancestor's artifacts, revisions and hashes; the branch only kept the
    // rendered files. Matching the two up by file is what keeps the material library from falling
    // back to how it looked before the fill.
    const result = await workspaceWithInherited([inheritedFill()]);

    expect(result.classificationPools).toEqual([
      {
        templateId,
        runId: 'ancestor-fill',
        templateEditVersion: draft().templates[0]!.workspace.template.editVersion,
        items: [{ materialId: sourceId, role: 'HOOK', matchScore: 0.9 }],
      },
    ]);
    // The fill is not this Run's own, so the fill history still shows what this Run ran.
    expect(result.aiRuns).toEqual([]);
  });

  it('projects the original purpose onto a regenerated file in lightweight source polling', async () => {
    const currentPrompt = {
      ...promptBatch,
      payload: { items: [{ id: 'stable-prompt', content: '原始镜头' }] },
    };
    const currentClip = {
      ...source,
      id: 'replacement',
      artifactKey: 'render-clip:new-task',
      payload: {
        ...(source.payload as object),
        promptId: 'stable-prompt',
        fileObjectId: 'new-file',
      },
    };
    const fill = inheritedFill();
    Object.assign(fill.inputSnapshot.materials[0]!, {
      promptId: 'stable-prompt',
      prompt: '原始镜头',
      fileObjectId: 'old-file',
    });
    const working = {
      getNodeStateOrNull: vi.fn().mockResolvedValue({ revision: 7, state: draft() }),
      listArtifacts: vi.fn().mockResolvedValue({ items: [currentPrompt, currentClip] }),
    };
    const aiRepository = {
      listRecent: vi.fn().mockResolvedValue([]),
      inheritedMixAiRuns: vi.fn().mockResolvedValue([fill]),
    };
    const service = new EffectTemplateMixService(
      working as unknown as WorkflowWorkingService,
      aiRepository as unknown as EffectTemplateMixAiRepository,
    );
    const result = await service.materialSources('project', 'run');
    expect(result.classificationPools?.[0]?.items).toEqual([
      { materialId: 'replacement', role: 'HOOK', matchScore: 0.9 },
    ]);
    expect(result.materials[0]?.fileObjectId).toBe('new-file');
    expect(result.materials[0]).not.toHaveProperty('trimStartSeconds');
    currentPrompt.payload.items[0]!.content = '已修改的另一创意';
    expect((await service.materialSources('project', 'run')).classificationPools).toEqual([]);
  });

  it('drops an inherited fill whose clips are not the ones this Run holds', async () => {
    const fill = inheritedFill({
      inputSnapshot: {
        ...(inheritedFill().inputSnapshot as Record<string, unknown>),
        materials: [
          {
            id: 'ancestor-clip',
            artifactRevision: 99,
            contentHash: 'ancestor-hash',
            fileObjectId: 'file-elsewhere',
          },
        ],
      },
    });

    const result = await workspaceWithInherited([fill]);

    expect(result.classificationPools).toEqual([]);
  });

  it('drops an inherited fill that froze a different template layout', async () => {
    const fill = inheritedFill({
      inputSnapshot: {
        ...(inheritedFill().inputSnapshot as Record<string, unknown>),
        template: { name: '跑量模板', slots: [{ id: slotId, role: 'PRODUCT', label: '产品展示' }] },
      },
    });

    const result = await workspaceWithInherited([fill]);

    expect(result.classificationPools).toEqual([]);
  });
});
