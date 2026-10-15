import type {
  EffectTemplateMixVariant,
  FinalOutputSnapshot,
  PackagingCheckpoint,
} from '@ai-marketing/contracts';
import { effectTemplateMixContentDuration } from '@ai-marketing/contracts';
import { describe, expect, it, vi } from 'vitest';
import { WorkflowWorkingService } from '../../../platform/workflow/workflow-working.service';
import { effectSavedMixSourcesStale } from '../../../platform/workflow/effect-branch-freshness';
import { visualHash } from '../template-mix/effect-packaging.domain';
import {
  finalOutputSavedBatchStale,
  finalOutputConfirmedProjectIds,
  finalOutputSavedDraftDiffers,
  finalOutputSavedProjectChanges,
} from './effect-final-output-freshness';

const variant = (): EffectTemplateMixVariant => ({
  id: 'v',
  name: '成片',
  slots: [
    { id: 's', label: '画面', role: 'HOOK', purpose: 'HOOK', duration: 4, transition: '硬切' },
  ],
  bindings: { s: 'clip' },
  bindingRevisions: { s: 1 },
  offsets: { s: 0 },
  manualSlotIds: [],
  appliedTemplateVersion: 1,
  conflictSlotIds: [],
  status: 'CURRENT',
  captions: [],
  subtitleStyle: 'standard',
  bgm: null,
  voice: null,
  originalVolume: 1,
});
const snapshot = (v = variant()): FinalOutputSnapshot =>
  ({
    timeline: {
      variant: structuredClone(v),
      sourceTimelineHash: visualHash(v),
      clips: [],
      duration: effectTemplateMixContentDuration(v),
      detachedAudios: structuredClone(v.detachedAudios ?? []),
    },
    packaging: { voices: {}, captions: [] },
    originalVolume: v.originalVolume ?? 1,
  }) as unknown as FinalOutputSnapshot;
const batch = (v = variant()) => ({
  status: 'COMPLETED',
  items: [
    {
      id: 'film',
      variantId: v.id,
      status: 'COMPLETED',
      fileObjectId: 'file',
      assetId: 'asset',
      snapshot: snapshot(v),
    },
  ],
});

describe('saved engineering and final output freshness', () => {
  it.each([
    [
      '截取',
      (v: EffectTemplateMixVariant) => {
        v.offsets.s = 1;
      },
    ],
    [
      '位置',
      (v: EffectTemplateMixVariant) => {
        v.timelineStarts = { s: 1 };
      },
    ],
    [
      '轨道',
      (v: EffectTemplateMixVariant) => {
        v.videoLanes = { s: 1 };
      },
    ],
    [
      '转场',
      (v: EffectTemplateMixVariant) => {
        v.slots[0]!.transition = '叠化';
      },
    ],
    [
      '变换',
      (v: EffectTemplateMixVariant) => {
        v.videoTransforms = {
          s: {
            x: 0.1,
            y: 0,
            scaleX: 1,
            scaleY: 1,
            rotation: 0,
            uniform: true,
          },
        };
      },
    ],
    [
      '画幅',
      (v: EffectTemplateMixVariant) => {
        v.canvasRatio = '16:9';
      },
    ],
    [
      '原声',
      (v: EffectTemplateMixVariant) => {
        v.originalVolume = 0.5;
      },
    ],
    [
      '音频',
      (v: EffectTemplateMixVariant) => {
        v.detachedAudios = [
          {
            id: 'audio',
            name: '音频',
            fileObjectId: 'a',
            sourceType: 'FILE',
            start: 0,
            offset: 0,
            duration: 2,
            volume: 0.5,
          },
        ];
      },
    ],
  ] as const)('detects saved %s without an artifact revision change', (_, change) => {
    const v = variant(),
      frozen = snapshot(v),
      output = batch(v);
    expect(finalOutputSavedDraftDiffers(v, frozen)).toBe(false);
    change(v);
    expect(finalOutputSavedDraftDiffers(v, frozen)).toBe(true);
    expect(finalOutputSavedBatchStale(output, [v])).toBe(true);
    output.items[0]!.snapshot = snapshot(v);
    expect(finalOutputSavedBatchStale(output, [v])).toBe(false);
  });

  it('ignores names and normalized default transforms, but compares rendered packaging', () => {
    const v = variant(),
      frozen = snapshot(v);
    v.name = '仅改名';
    v.manualSlotIds = ['s'];
    v.videoTransforms = { s: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, uniform: true } };
    expect(finalOutputSavedDraftDiffers(v, frozen)).toBe(false);
    const cp: PackagingCheckpoint = {
      voices: {},
      captions: [{ id: 'caption', text: '字幕', start: 0, end: 2 }],
    };
    expect(finalOutputSavedDraftDiffers(v, frozen, cp)).toBe(true);
    expect(finalOutputSavedDraftDiffers(v, frozen, { voices: {}, captions: [], script: [] })).toBe(
      false,
    );
  });

  it('handles additions, deletions, all-delete, empty signs and missing drafts separately', () => {
    const v = variant(),
      output = batch(v);
    const empty = { ...variant(), id: 'new', slots: [], bindings: {}, preservedTimelineEnd: 10 };
    expect(finalOutputSavedBatchStale(output, [v, empty])).toBe(false);
    expect(finalOutputSavedBatchStale(output, [v, { ...variant(), id: 'new' }])).toBe(false);
    expect(finalOutputSavedBatchStale(output, [v, { ...variant(), id: 'new' }],
      new Map(), new Set(), new Set(['new']))).toBe(true);
    expect(finalOutputSavedBatchStale(output, [])).toBe(true);
    expect(finalOutputSavedBatchStale(output, null)).toBe(false);
    expect(finalOutputSavedBatchStale({ ...output, items: [] }, [])).toBe(false);
    expect(finalOutputSavedBatchStale(output, [v])).toBe(false);
  });

  it('requires an available confirmed timeline of the selected template for additions, not deletions', () => {
    const v = variant(), added = { ...variant(), id: 'new' };
    const artifacts = [
      { nodeId: 'TEMPLATE_MIX', artifactKey: 'timeline-project:t:new', availability: 'AVAILABLE' },
      { nodeId: 'TEMPLATE_MIX', artifactKey: 'timeline-project:other:sibling', availability: 'AVAILABLE' },
      { nodeId: 'TEMPLATE_MIX', artifactKey: 'timeline-project:t:missing', availability: 'MISSING' },
      { nodeId: 'FINAL_OUTPUT', artifactKey: 'timeline-project:t:wrong-node', availability: 'AVAILABLE' },
      { nodeId: 'TEMPLATE_MIX', artifactKey: 'timeline-package:t:package-only', availability: 'AVAILABLE' },
    ];
    const ids = finalOutputConfirmedProjectIds('t', artifacts);
    expect(ids).toEqual(new Set(['new']));
    expect(finalOutputSavedProjectChanges([v, added], batch(v).items, new Set())).toEqual({
      added: [], removedItemIds: [],
    });
    expect(finalOutputSavedProjectChanges([v, added], batch(v).items, ids)).toEqual({
      added: [added], removedItemIds: [],
    });
    expect(finalOutputSavedProjectChanges([added], batch(v).items, ids)).toEqual({
      added: [added], removedItemIds: ['film'],
    });
    expect(artifacts).toHaveLength(5);
  });

  it('does not warn for a frozen in-flight edit but retains failed local updates', () => {
    const v = variant(),
      output = batch(v);
    v.offsets.s = 1;
    for (const status of ['QUEUED', 'RUNNING'])
      expect(finalOutputSavedBatchStale({ ...output, status }, [v])).toBe(false);
    output.items[0]!.status = 'FAILED';
    output.items[0]!.snapshot = {
      ...snapshot(),
      sourceDraft: { revision: 1 },
    } as unknown as FinalOutputSnapshot;
    expect(finalOutputSavedBatchStale({ ...output, status: 'FAILED' }, [variant()])).toBe(true);
  });

  it('reuses source provenance for a missing adopted source without changing graph rows', () => {
    const v = variant();
    v.bindingSources = {
      s: {
        id: 'clip',
        artifactId: 'clip',
        artifactKey: 'render-clip:task',
        artifactRevision: 1,
        fileObjectId: 'old-file',
        sourcePromptId: 'prompt',
        contentHash: 'hash',
        contentUrl: '',
        duration: 4,
        available: true,
        code: '',
        name: '',
        ratio: '4:3',
        resolution: '480p',
        purpose: 'HOOK',
        compatiblePurposes: [],
      },
    };
    const branches = [
      { id: 'root', parentWorkflowRunId: null, forkNodeId: null },
      { id: 'output', parentWorkflowRunId: 'root', forkNodeId: 'FINAL_OUTPUT' },
    ];
    const output = batch(v);
    const pending = effectSavedMixSourcesStale(branches, [], 'output', 't', [v]);
    expect(pending).toEqual(new Set(['v']));
    expect(finalOutputSavedBatchStale(output, [v], new Map(), pending)).toBe(true);
    expect(
      finalOutputSavedBatchStale({ ...output, status: 'RUNNING' }, [v], new Map(), pending),
    ).toBe(false);
    expect(branches).toHaveLength(2);
    const sources = [
      {
        id: 'clip',
        workflowRunId: 'root',
        nodeId: 'SEGMENT_RENDER',
        artifactKey: 'render-clip:task',
        revision: 1,
        freshness: 'CURRENT',
        availability: 'AVAILABLE',
        payload: {
          promptId: 'prompt',
          fileObjectId: 'old-file',
          contentHash: 'hash',
          durationSeconds: 4,
        },
      },
      {
        id: 'batch',
        workflowRunId: 'root',
        nodeId: 'SEGMENT_RENDER',
        artifactKey: 'render-batch:p',
        revision: 1,
        freshness: 'CURRENT',
        payload: { clips: [{ taskId: 'task', promptId: 'prompt' }] },
      },
    ];
    const before = structuredClone(sources);
    expect(effectSavedMixSourcesStale(branches, sources, 'output', 't', [v])).toEqual(new Set());
    expect(sources).toEqual(before);
  });
});

describe('branch tree final-output saved-draft projection', () => {
  it('marks only the edited delivery, clears on success and preserves a second change and siblings', async () => {
    const date = new Date('2026-10-09T00:00:00Z');
    const artifact = (key: string, runId: string, payload: unknown = null) => ({
      id: `${runId}:${key}`,
      workflowRunId: runId,
      nodeId: key.startsWith('final-')
        ? 'FINAL_OUTPUT'
        : key.startsWith('render-')
          ? 'SEGMENT_RENDER'
          : 'TEMPLATE_MIX',
      artifactKey: key,
      name: key,
      revision: 1,
      freshness: 'CURRENT',
      availability: 'AVAILABLE',
      createdAt: date,
      updatedAt: date,
      payload,
      dependencies: [],
    });
    const row = (id: string, parent: string | null, templateId = 't') => ({
      id,
      projectId: 'project',
      parentWorkflowRunId: parent,
      forkNodeId: parent ? 'FINAL_OUTPUT' : null,
      forkTemplateId: parent ? templateId : null,
      branchPublishedAt: date,
      branchLabel: id,
      activeKey: id === 'edited' ? 'ACTIVE' : null,
      currentNodeId: 'FINAL_OUTPUT',
      createdAt: date,
      updatedAt: date,
      nodeStates: [
        {
          nodeId: 'TEMPLATE_MIX',
          state: {
            schemaVersion: 1,
            templates: [
              {
                id: templateId,
                workspace: { template: { name: templateId }, variants: [variant()] },
              },
            ],
          },
        },
      ],
      effectFinalOutputRuns: [{ ...batch(), id: `output-${id}`, templateId }],
      effectPackagingRuns: [],
      workingArtifacts: [
        artifact(`mix-template:${templateId}`, id),
        artifact(`timeline-project:${templateId}:v`, id),
        ...(parent
          ? [artifact(`final-delivery:${templateId}`, id, { runId: `output-${id}` })]
          : [artifact('render-clip:clip', id)]),
      ],
    });
    const rows = [
      row('root', null),
      row('edited', 'root'),
      row('sibling', 'root'),
      row('other-template', 'root', 'other'),
    ];
    const service = new WorkflowWorkingService(
      { listEffectRunBranches: vi.fn().mockResolvedValue(rows) } as never,
      { get: vi.fn().mockResolvedValue({ id: 'project' }) } as never,
      {} as never,
    );
    const edited = rows[1]!,
      saved = edited.nodeStates[0]!.state.templates[0]!.workspace.variants[0]!;
    const status = async () =>
      (await service.getEffectBranchTree('project')).branches
        .filter((b) => b.templates.some((t) => (t.deliveryCount ?? 0) > 0))
        .map((b) => [
          b.workflowRunId,
          b.templates.find((t) => (t.deliveryCount ?? 0) > 0)!.deliveryStatus,
          b.nodes.find((n) => n.nodeId === 'FINAL_OUTPUT')!.status,
        ]);
    expect(await status()).toEqual([
      ['edited', 'CONFIRMED', 'CONFIRMED'],
      ['sibling', 'CONFIRMED', 'CONFIRMED'],
      ['other-template', 'CONFIRMED', 'CONFIRMED'],
    ]);
    // Historical unsubmitted drafts are not newly added films after an export.
    const extra = { ...variant(), id: 'unsubmitted' };
    edited.nodeStates[0]!.state.templates[0]!.workspace.variants.push(extra);
    rows[2]!.workingArtifacts.push(artifact('timeline-project:t:unsubmitted', 'sibling'));
    rows[3]!.workingArtifacts.push(artifact('timeline-project:other:unsubmitted', 'other-template'));
    expect((await status())[0]).toEqual(['edited', 'CONFIRMED', 'CONFIRMED']);
    edited.workingArtifacts.push(artifact('timeline-project:t:unsubmitted', 'edited'));
    expect((await status())[0]).toEqual(['edited', 'STALE', 'STALE']);
    edited.workingArtifacts.pop();
    edited.nodeStates[0]!.state.templates[0]!.workspace.variants.pop();
    expect((await status())[0]).toEqual(['edited', 'CONFIRMED', 'CONFIRMED']);
    saved.offsets.s = 1;
    const before = JSON.stringify(rows);
    expect(await status()).toEqual([
      ['edited', 'STALE', 'STALE'],
      ['sibling', 'CONFIRMED', 'CONFIRMED'],
      ['other-template', 'CONFIRMED', 'CONFIRMED'],
    ]);
    expect(JSON.stringify(rows)).toBe(before);
    edited.effectFinalOutputRuns[0]!.items[0]!.snapshot = snapshot(saved);
    expect((await status())[0]).toEqual(['edited', 'CONFIRMED', 'CONFIRMED']);
    saved.offsets.s = 2;
    expect((await status())[0]).toEqual(['edited', 'STALE', 'STALE']);
    saved.offsets.s = 1;
    expect((await status())[0]).toEqual(['edited', 'CONFIRMED', 'CONFIRMED']);
    edited.nodeStates[0]!.state.templates[0]!.workspace.variants = [];
    expect((await status())[0]).toEqual(['edited', 'STALE', 'STALE']);
    expect(rows.flatMap((r) => r.workingArtifacts).every((a) => a.revision === 1)).toBe(true);
  });
});
