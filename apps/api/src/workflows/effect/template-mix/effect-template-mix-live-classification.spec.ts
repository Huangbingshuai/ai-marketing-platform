import type {
  EffectTemplateMixDraft,
  EffectTemplateMixWorkspaceData,
  WorkingArtifact,
} from '@ai-marketing/contracts';
import { describe, expect, it, vi } from 'vitest';
import type { WorkflowWorkingService } from '../../../platform/workflow/workflow-working.service';
import { EffectTemplateMixService } from './effect-template-mix.service';
import type { EffectTemplateMixAiRepository } from './effect-template-mix-ai.repository';

const roles = ['HOOK', 'PAIN_POINT', 'PRODUCT', 'SELLING_POINT', 'TRANSFORMATION', 'END'] as const;
const scores = Object.fromEntries(roles.map((role) => [role, role === 'PRODUCT' ? 0.99 : 0.8]));

function harness() {
  const slots = roles.map((role, index) => ({
    id: `slot-${index}`,
    role,
    label: role,
    purpose: 'HOOK' as const,
    duration: [4, 5, 7, 10, 8, 4][index]!,
    transition: '硬切' as const,
  }));
  const draft: EffectTemplateMixDraft = {
    schemaVersion: 1,
    activeTemplateId: 'template',
    templates: [
      {
        id: 'template',
        workspace: {
          editVersion: 1,
          template: { name: '模板', editVersion: 1, slots },
          variants: [],
        },
      },
    ],
  };
  const clips = ['old', 'new'].map((id) => ({
    id,
    nodeId: 'SEGMENT_RENDER',
    artifactKey: `render-clip:${id}`,
    revision: 2,
    contentHash: `${id}-hash`,
    workflowRunId: 'run',
    availability: 'AVAILABLE',
    freshness: 'CURRENT',
    name: id,
    contentUrl: `/api/files/${id}`,
    kind: 'FILE',
    payload: {
      fileObjectId: `${id}-file`,
      contentHash: `${id}-hash`,
      primaryPurpose: 'HOOK',
      durationSeconds: id === 'new' ? 6 : 10,
    },
  })) as unknown as WorkingArtifact[];
  const service = new EffectTemplateMixService({} as WorkflowWorkingService);
  const projection = service as unknown as {
    toWorkspaceData: (
      draft: EffectTemplateMixDraft,
      revision: number,
      runId: string,
      artifacts: WorkingArtifact[],
      runs?: unknown[],
      sources?: unknown[],
      locks?: string[],
      packageLocks?: string[],
      sourceLocks?: string[],
      ready?: boolean,
      inherited?: unknown[],
    ) => EffectTemplateMixWorkspaceData;
  };
  const read = (runs: unknown[], inherited: unknown[] = []) =>
    projection.toWorkspaceData(draft, 1, 'run', clips, [], [], [], [], [], false, [
      ...runs,
      ...inherited,
    ]);
  const materials = read([]).materials.map((material) => ({
    ...material,
    artifactId: material.id,
    prompt: material.promptText,
    promptId: material.sourcePromptId,
    contentHash: clips.find((clip) => clip.id === material.id)!.contentHash,
  }));
  const old = {
    id: 'completed',
    workflowRunId: 'ancestor',
    templateId: 'template',
    status: 'COMPLETED',
    inputSnapshot: {
      template: draft.templates[0]!.workspace.template,
      materials: [materials[0]],
      materialRoleAssignments: { old: 'HOOK' },
    },
    classificationResult: [{ materialId: 'old', scores }],
  };
  const live = {
    id: 'live',
    workflowRunId: 'run',
    templateId: 'template',
    status: 'RUNNING',
    inputSnapshot: {
      incremental: { newMaterialIds: ['new'] },
      template: structuredClone(draft.templates[0]!.workspace.template),
      materials: structuredClone(materials),
      materialRoleAssignments: { old: 'HOOK' },
    },
    classificationResult: [{ materialId: 'new', scores }],
  };
  const readSources = () =>
    new EffectTemplateMixService(
      {
        getNodeStateOrNull: vi.fn().mockResolvedValue({ state: draft, revision: 1 }),
        listArtifacts: vi.fn().mockResolvedValue({ items: clips }),
      } as unknown as WorkflowWorkingService,
      {
        listRecent: vi.fn().mockResolvedValue([live]),
        inheritedMixAiRuns: vi.fn().mockResolvedValue([old]),
      } as unknown as EffectTemplateMixAiRepository,
    ).materialSources('project', 'run');
  return { read, readSources, live, old, clips, draft };
}

describe('read-only live APPEND classification checkpoint projection', () => {
  it('does not return an already classified addition to pending after a later trim completion', () => {
    const { read, live, old } = harness();
    const append = { ...live, status: 'COMPLETED', inputSnapshot: {
      ...live.inputSnapshot, materials: [live.inputSnapshot.materials[1]],
    } };
    const trim = { ...old, id: 'later-trim', workflowRunId: 'run',
      inputSnapshot: { ...old.inputSnapshot, trimOnly: true } };
    const result = read([trim, append], [old]);
    expect(result.classificationPools).toHaveLength(1);
    expect(result.classificationPools[0]!.items.map(({ materialId }) => materialId).sort())
      .toEqual(['new', 'old']);
    expect(result.classificationPools[0]!.runId).toBe('later-trim');
  });
  it('returns a partial checkpoint through the actual lightweight materialSources method', async () => {
    const { readSources } = harness();
    const result = await readSources();
    expect(
      result.classificationPools?.[0]?.items.map(({ materialId }) => materialId).sort(),
    ).toEqual(['new', 'old']);
    expect(result.draftRevision).toBe(1);
  });
  it('exposes classified new clips before completion while retaining the old completed pool', () => {
    const { read, live, old } = harness();
    const result = read([live], [old]);
    expect(result.classificationPools).toHaveLength(1);
    const pool = result.classificationPools[0]!;
    expect(pool.runId).toBe('live');
    expect(pool.items.map(({ materialId }) => materialId).sort()).toEqual(['new', 'old']);
    expect(pool.items.find(({ materialId }) => materialId === 'old')?.role).toBe('HOOK');
    const newRole = pool.items.find(({ materialId }) => materialId === 'new')!.role;
    expect(
      result.draft.templates[0]!.workspace.template.slots.find(({ role }) => role === newRole)!
        .duration,
    ).toBeLessThanOrEqual(6);
    expect(result.draftRevision).toBe(1);
    expect(result.draft.templates[0]!.workspace.variants).toEqual([]);
  });
  it('prefers live rows and does not duplicate identities already in the completed pool', () => {
    const { read, live, old } = harness();
    live.classificationResult.push({ materialId: 'old', scores });
    expect(
      read([live], [old])
        .classificationPools[0]!.items.map(({ materialId }) => materialId)
        .sort(),
    ).toEqual(['new', 'old']);
  });
  it('compares the canonical WorkingArtifact hash rather than the video checksum in its payload', () => {
    const { read, live, clips } = harness();
    Object.assign(clips[1]!.payload as object, { contentHash: 'video-byte-checksum' });
    expect(read([live]).classificationPools[0]!.items[0]!.materialId).toBe('new');
  });
  it('retains the manual source marker and frozen role in live checkpoints', () => {
    const { read, live } = harness();
    Object.assign(live.inputSnapshot, {
      manualMaterialRoles: { new: 'PAIN_POINT' },
      materialRoleAssignments: { old: 'HOOK', new: 'PAIN_POINT' },
    });
    Object.assign(live.classificationResult[0]!, {
      source: 'MANUAL',
      scores: Object.fromEntries(roles.map((role) => [role, role === 'PAIN_POINT' ? 1 : 0])),
    });
    expect(read([live]).classificationPools[0]!.items).toEqual([
      { materialId: 'new', role: 'PAIN_POINT', matchScore: 1, source: 'MANUAL' },
    ]);
  });
  it.each(['FAILED', 'CANCELLED', 'QUEUED'])('never exposes %s checkpoints', (status) => {
    const { read, live, old } = harness();
    live.status = status;
    expect(read([live], [old]).classificationPools[0]!.runId).toBe('completed');
  });
  it('excludes active full refill and active ancestor/sibling tasks', () => {
    const { read, live } = harness();
    live.workflowRunId = 'sibling';
    expect(read([live]).classificationPools).toEqual([]);
    live.workflowRunId = 'run';
    delete (live.inputSnapshot as { incremental?: unknown }).incremental;
    expect(read([live]).classificationPools).toEqual([]);
  });
  it.each(['fileObjectId', 'artifactRevision', 'contentHash'])(
    'rejects obsolete %s checkpoint rows',
    (field) => {
      const { read, live } = harness();
      Object.assign(live.inputSnapshot.materials[1]!, {
        [field]: field === 'artifactRevision' ? 99 : 'obsolete',
      });
      expect(read([live]).classificationPools).toEqual([]);
    },
  );
  it.each(['editVersion', 'duration'])('rejects changed template %s', (field) => {
    const { read, live } = harness();
    if (field === 'editVersion') live.inputSnapshot.template.editVersion = 99;
    else live.inputSnapshot.template.slots[0]!.duration = 99;
    expect(read([live]).classificationPools).toEqual([]);
  });
  it('rejects incomplete score structures and unclassified checkpoints without losing the old pool', () => {
    const { read, live, old } = harness();
    live.classificationResult[0]!.scores = { HOOK: 1 };
    expect(read([live], [old]).classificationPools[0]!.runId).toBe('completed');
    live.classificationResult = [];
    expect(read([live], [old]).classificationPools[0]!.runId).toBe('completed');
  });
});
