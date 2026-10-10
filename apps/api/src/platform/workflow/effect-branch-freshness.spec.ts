import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { effectArtifactSourceOwner, effectRenderClipHeads, projectEffectBranchFreshness } from './effect-branch-freshness';
import type { EffectTemplateMixMaterial, EffectTemplateMixVariant } from '@ai-marketing/contracts';

const branches = [
  { id: 'render', parentWorkflowRunId: null, forkNodeId: null },
  { id: 'fill-a', parentWorkflowRunId: 'render', forkNodeId: 'TEMPLATE_MIX' },
  { id: 'fill-b', parentWorkflowRunId: 'render', forkNodeId: 'TEMPLATE_MIX' },
  { id: 'package-a', parentWorkflowRunId: 'fill-a', forkNodeId: 'TEMPLATE_MIX' },
];
const clip = (id: string, workflowRunId: string, revision = 1, file = 'old', prompt = 'prompt') => ({
  id, workflowRunId, nodeId: 'SEGMENT_RENDER', artifactKey: `render-clip:${id}`,
  revision, freshness: 'CURRENT', payload: { promptId: prompt, fileObjectId: file },
});
const project = (id: string, workflowRunId: string, source: string, revision = 1) => ({
  id, workflowRunId, nodeId: 'TEMPLATE_MIX', artifactKey: `timeline-project:t:${id}`,
  revision: 1, freshness: 'CURRENT', dependencies: [{ sourceType: 'WORKING_ARTIFACT',
    sourceArtifactId: source, sourceRevision: revision }],
});
describe('branch dependency freshness projection', () => {
  it('projects authoritative render media against the viewing branch Prompt without changing siblings', () => {
    const hash = (text: string) => createHash('sha256').update(text).digest('hex');
    const item = { id: 'prompt', content: 'original', targetDurationSeconds: 5,
      primaryPurpose: 'PRODUCT_DISPLAY', compatiblePurposes: ['PRODUCT_DISPLAY'] };
    const prompt = { id: 'prompt-root', workflowRunId: 'render', nodeId: 'PROMPT_GENERATION',
      artifactKey: 'prompt-batch:p', revision: 1, freshness: 'CURRENT',
      payload: { items: [item], sharedPrompt: { contentHash: hash('shared') } } };
    const rendered = { ...clip('a', 'render'), payload: { taskId: 'a', promptId: item.id,
      promptContentHash: hash(item.content), adoptedPrompt: { promptContentHash: hash(item.content),
        sharedPromptHash: hash('shared'), targetDurationSeconds: 5,
        primaryPurpose: item.primaryPurpose, compatiblePurposes: item.compatiblePurposes } },
      dependencies: [{ sourceType: 'WORKING_ARTIFACT', sourceNodeId: 'PROMPT_GENERATION', sourceArtifactId: prompt.id, sourceRevision: 1 }] };
    const batch = { ...rendered, id: 'batch', artifactKey: 'render-batch:p', payload: { clips: [rendered.payload] } };
    for (const items of [[{ ...item, content: 'changed' }], [], [item, { ...item, id: 'added' }]]) {
      const local = { ...prompt, id: 'prompt-local', workflowRunId: 'fill-a', revision: 2,
        payload: { ...prompt.payload, items } };
      const rows = [prompt, rendered, batch, local];
      expect(projectEffectBranchFreshness(branches, rows, undefined, 'fill-a').find(row => row.id === 'batch')?.freshness).toBe('STALE');
      expect(projectEffectBranchFreshness(branches, rows, undefined, 'fill-b').find(row => row.id === 'batch')?.freshness).toBe('CURRENT');
      expect(projectEffectBranchFreshness(branches, rows).find(row => row.id === 'batch')?.freshness).toBe('CURRENT');
    }
    const restored = { ...prompt, id: 'prompt-local', workflowRunId: 'fill-a', revision: 3 };
    expect(projectEffectBranchFreshness(branches, [prompt, rendered, batch, restored], undefined, 'fill-a')
      .find(row => row.id === 'batch')?.freshness).toBe('CURRENT');
  });
  it('reconciles body, shared constraints and membership by net content without staling saved video consumers', () => {
    const hash = (text: string) => createHash('sha256').update(text).digest('hex');
    const baseline = { promptContentHash: hash('正文'), sharedPromptHash: hash('约束'),
      targetDurationSeconds: 5, primaryPurpose: 'PRODUCT_DISPLAY', compatiblePurposes: ['PRODUCT_DISPLAY'],
      creativeCore: '创意', dimensions: {} };
    const adoptedClip = { taskId: 'a', promptId: 'prompt', promptText: '正文',
      promptContentHash: baseline.promptContentHash, primaryPurpose: 'PRODUCT_DISPLAY',
      compatiblePurposes: ['PRODUCT_DISPLAY'], adoptedPrompt: baseline, fileObjectId: 'file' };
    const prompt = { id: 'prompts', workflowRunId: 'render', nodeId: 'PROMPT_GENERATION',
      artifactKey: 'prompt-batch:p', revision: 7, contentHash: 'latest', freshness: 'CURRENT', availability: 'AVAILABLE',
      payload: { items: [{ id: 'prompt', content: '正文', targetDurationSeconds: 5,
        primaryPurpose: 'PRODUCT_DISPLAY', compatiblePurposes: ['PRODUCT_DISPLAY'], creativeCore: '创意', dimensions: {} }],
        sharedPrompt: { contentHash: baseline.sharedPromptHash } } };
    const dependency = [{ sourceType: 'WORKING_ARTIFACT', sourceArtifactId: 'prompts', sourceRevision: 1, sourceHash: 'old' }];
    const rendered = { ...clip('a', 'render'), availability: 'AVAILABLE', freshness: 'STALE',
      payload: adoptedClip, dependencies: dependency };
    const batch = { ...rendered, id: 'pool', artifactKey: 'render-batch:p', payload: { clips: [adoptedClip], removedSources: [] } };
    const unchanged = projectEffectBranchFreshness(branches, [prompt, rendered, batch, project('film', 'fill-a', 'a')]);
    expect(unchanged.slice(1).map(row => row.freshness)).toEqual(['CURRENT', 'CURRENT', 'CURRENT']);
    for (const updated of [
      { ...prompt.payload, items: [{ ...prompt.payload.items[0]!, content: '修改正文' }] },
      { ...prompt.payload, sharedPrompt: { contentHash: hash('新约束') } },
      { ...prompt.payload, items: [...prompt.payload.items, { ...prompt.payload.items[0]!, id: 'new' }] },
      { ...prompt.payload, items: [] },
    ]) {
      const output = projectEffectBranchFreshness(branches, [{ ...prompt, payload: updated }, rendered, batch,
        project('film', 'fill-a', 'a')]);
      expect(output[2]?.freshness).toBe('STALE');
      expect(output[3]?.freshness).toBe('CURRENT'); // No published render change yet.
    }
    const unavailable = projectEffectBranchFreshness(branches, [{ ...prompt, availability: 'UNAVAILABLE' }, rendered]);
    expect(unavailable[1]?.freshness).toBe('STALE');
  });
  const adopted = { id: 'a', artifactId: 'a', artifactKey: 'render-clip:a', artifactRevision: 1,
    fileObjectId: 'old', contentHash: 'old-hash', sourcePromptId: 'prompt', duration: 10 } as EffectTemplateMixMaterial;
  const frozenFilm = (id: string, file = 'old', revision = 1) => ({ ...project(id, 'fill-a', 'a', revision),
    freshness: 'STALE', payload: { variant: { id, slots: [{ id: 's', duration: 4 }], bindings: { s: 'a' },
      bindingRevisions: { s: revision }, bindingSources: { s: { ...adopted, fileObjectId: file,
        contentHash: `${file}-hash`, artifactRevision: revision } } } as unknown as EffectTemplateMixVariant } });
  const pool = (extra = false) => ({ ...clip('pool', 'render'), artifactKey: 'render-batch:p', payload: {
    clips: [{ taskId: 'a', promptId: 'prompt' }, ...(extra ? [{ taskId: 'b', promptId: 'new-prompt' }] : [])],
    removedSources: extra ? [] : [{ taskId: 'b', promptId: 'new-prompt' }],
  } });
  it('clears sticky render warnings when the net adopted difference disappears and advances films independently', () => {
    const latest = { ...clip('a', 'render', 3, 'latest'), payload: { promptId: 'prompt', fileObjectId: 'latest',
      contentHash: 'latest-hash', durationSeconds: 10 } };
    const result = projectEffectBranchFreshness(branches, [latest, pool(), frozenFilm('finished', 'latest', 3), frozenFilm('remaining')]);
    expect(result.find((row) => row.id === 'finished')?.freshness).toBe('CURRENT');
    expect(result.find((row) => row.id === 'remaining')?.freshness).toBe('STALE');
    expect(projectEffectBranchFreshness(branches, [{ ...latest, revision: 1,
      payload: { ...latest.payload, fileObjectId: 'old', contentHash: 'old-hash' } }, pool(), frozenFilm('film')])
      .find((row) => row.id === 'film')?.freshness).toBe('CURRENT');
  });
  it('reconciles saved additions and their cancellation with the same template baseline', () => {
    const withHistory = branches.map((branch) => branch.id === 'fill-a' ? { ...branch, effectTemplateMixAiRuns: [{
      templateId: 't', status: 'COMPLETED', inputSnapshot: { materials: [{ id: 'a', promptId: 'prompt' }] },
    }] } : branch);
    const a = { ...clip('a', 'render'), payload: { promptId: 'prompt', fileObjectId: 'old', contentHash: 'old-hash', durationSeconds: 10 } };
    const b = { ...clip('b', 'render', 1, 'new', 'new-prompt'), payload: { promptId: 'new-prompt', fileObjectId: 'new', durationSeconds: 10 } };
    const template = { ...project('template', 'fill-a', 'a'), artifactKey: 'mix-template:t', freshness: 'STALE' };
    expect(projectEffectBranchFreshness(withHistory, [a, b, pool(true), frozenFilm('film'), template]).at(-1)?.freshness).toBe('STALE');
    expect(projectEffectBranchFreshness(withHistory, [a, b, pool(false), frozenFilm('film'), template]).at(-1)?.freshness).toBe('CURRENT');
  });
  const audioPackage = () => ({
    ...project('audio', 'fill-a', 'film'), artifactKey: 'timeline-package:t:film',
    freshness: 'STALE', payload: { schemaVersion: 1, voices: {}, captions: [] },
  });
  it('keeps confirmed independent audio current after a visual local update without hiding picture staleness', () => {
    const picture = { ...project('film', 'fill-a', 'source'), revision: 2 };
    const original = [clip('source', 'render', 2), picture, audioPackage()];
    const result = projectEffectBranchFreshness(branches, original);
    expect(result.find(row => row.id === 'film')?.freshness).toBe('STALE');
    expect(result.find(row => row.id === 'audio')?.freshness).toBe('CURRENT');
    expect(original[2]?.freshness).toBe('STALE'); // Projection does not rewrite a stored artifact.
  });
  it('does not clear real non-visual dependency changes or an unproven legacy package', () => {
    const picture = { ...project('film', 'fill-a', 'source'), revision: 2 };
    const fact = { ...clip('facts', 'render', 2), nodeId: 'INFORMATION_EXTRACTION',
      artifactKey: 'marketing-insight:product' };
    const dependent = { ...audioPackage(), dependencies: [...audioPackage().dependencies,
      { sourceType: 'WORKING_ARTIFACT', sourceArtifactId: 'facts', sourceRevision: 1 }] };
    expect(projectEffectBranchFreshness(branches, [picture, fact, dependent])[2]?.freshness).toBe('STALE');
    expect(projectEffectBranchFreshness(branches, [picture, { ...audioPackage(), payload: undefined }])[1]?.freshness)
      .toBe('STALE');
    expect(projectEffectBranchFreshness(branches, [{ ...picture, artifactKey: 'timeline-project:t:other' },
      audioPackage()])[1]?.freshness).toBe('STALE');
  });
  it('does not stale unrelated material consumers when a confirmed Prompt batch revision changes', () => {
    const prompt = { id: 'prompts', workflowRunId: 'render', nodeId: 'PROMPT_GENERATION',
      artifactKey: 'prompt-batch:p', revision: 2, contentHash: 'new-batch', freshness: 'CURRENT',
      payload: { items: [{ id: 'prompt', content: '未变化正文', primaryPurpose: 'PRODUCT_DISPLAY',
        compatiblePurposes: ['PRODUCT_DISPLAY'] }] } };
    const unchanged = { ...clip('a', 'render'), payload: { ...clip('a', 'render').payload,
      promptContentHash: createHash('sha256').update('未变化正文').digest('hex'),
      primaryPurpose: 'PRODUCT_DISPLAY', compatiblePurposes: ['PRODUCT_DISPLAY'] },
      dependencies: [{ sourceType: 'WORKING_ARTIFACT', sourceArtifactId: prompt.id,
        sourceRevision: 1, sourceHash: 'old-batch' }] };
    const result = projectEffectBranchFreshness(branches, [prompt, unchanged, project('film', 'fill-a', 'a')]);
    expect(result.find((row) => row.id === 'a')?.freshness).toBe('CURRENT');
    expect(result.find((row) => row.id === 'film')?.freshness).toBe('CURRENT');
    const explicit = projectEffectBranchFreshness(branches, [prompt, { ...unchanged, freshness: 'STALE' },
      project('film', 'fill-a', 'a')]);
    expect(explicit.find((row) => row.id === 'film')?.freshness).toBe('STALE');
    const changed = projectEffectBranchFreshness(branches, [{ ...prompt,
      payload: { items: [{ ...prompt.payload.items[0], content: '修改正文' }] } }, unchanged,
      project('film', 'fill-a', 'a')]);
    expect(changed.find((row) => row.id === 'film')?.freshness).toBe('STALE');
  });
  it('saved removal warns only actual consumers and clears when the empty project drops that dependency', () => {
    const inputs = [clip('a', 'render'), clip('b', 'render', 1, 'b', 'other'),
      { ...clip('pool', 'render'), artifactKey: 'render-batch:p', payload: {
        clips: [{ taskId: 'b', promptId: 'other' }], removedSources: [{ taskId: 'a', promptId: 'prompt' }],
      } }, project('affected', 'fill-a', 'a'), project('unaffected', 'fill-a', 'b')];
    const projected = projectEffectBranchFreshness(branches, inputs);
    expect(projected.find((row) => row.id === 'affected')?.freshness).toBe('STALE');
    expect(projected.find((row) => row.id === 'unaffected')?.freshness).toBe('CURRENT');
    expect(projected.find((row) => row.id === 'a')?.freshness).toBe('CURRENT');
    const cleared = projectEffectBranchFreshness(branches, inputs.map((row) => row.id === 'affected'
      ? { ...row, dependencies: [] } : row));
    expect(cleared.find((row) => row.id === 'affected')?.freshness).toBe('CURRENT');
  });
  it('an addition preserves independently confirmed repairs without making their consumers stale', () => {
    const rows = [clip('original', 'render'), clip('old-copy', 'fill-a'),
      { ...clip('repair', 'fill-b', 2, 'repaired'), updatedAt: '2026-10-06' },
      clip('added', 'fill-a', 1, 'new-file', 'new-prompt'),
      { ...clip('root-pool', 'render'), artifactKey: 'render-batch:root', payload: { clips: [{ taskId: 'original' }] }, updatedAt: '2026-10-01' },
      { ...clip('new-pool', 'fill-a', 3), artifactKey: 'render-batch:added', payload: { clips: [{ taskId: 'old-copy' }, { taskId: 'added' }] }, updatedAt: '2026-10-07' },
      project('repaired-film', 'fill-a', 'repair', 2), project('old-film', 'fill-a', 'old-copy')];
    expect(effectRenderClipHeads(branches, 'fill-a', rows).get('prompt')?.id).toBe('repair');
    const result = projectEffectBranchFreshness(branches, rows);
    expect(result.find((row) => row.id === 'repaired-film')?.freshness).toBe('CURRENT');
    expect(result.find((row) => row.id === 'old-film')?.freshness).toBe('STALE');
    expect(result.find((row) => row.id === 'repair')?.freshness).toBe('CURRENT');
  });
  it('clip merging cannot resurrect removed members or adopt copies, drafts or independent render heads', () => {
    const runs = [...branches, { id: 'draft', parentWorkflowRunId: 'fill-a', forkNodeId: 'TEMPLATE_MIX', branchPublishedAt: null },
      { id: 'independent', parentWorkflowRunId: 'render', forkNodeId: 'SEGMENT_RENDER' },
      { id: 'manual', parentWorkflowRunId: 'render', forkNodeId: 'MANUAL_COPY' }];
    const rows = [clip('original', 'render'), clip('removed', 'render', 1, 'removed', 'deleted-prompt'),
      { ...clip('root-pool', 'render'), artifactKey: 'render-batch:root', payload: { clips: [] }, updatedAt: '2026-10-01' },
      { ...clip('new-pool', 'fill-a', 2), artifactKey: 'render-batch:new', payload: { clips: [{ taskId: 'original' }] }, updatedAt: '2026-10-07' },
      { ...clip('original', 'fill-a'), id: 'baseline-copy', metadata: { branchSource: { artifactId: 'original' } } },
      { ...clip('fake-copy', 'fill-b', 100, 'fake'), metadata: { branchSource: { artifactId: 'original' } } },
      clip('unsaved', 'draft', 100), clip('other', 'independent', 100), clip('manual', 'manual', 100)];
    const heads = effectRenderClipHeads(runs, 'fill-a', rows);
    expect([...heads.keys()]).toEqual(['prompt']);
    expect(heads.get('prompt')?.payload).toMatchObject({ fileObjectId: 'old' });
  });
  const batch = (workflowRunId: string, revision: number, updatedAt: string) => ({
    ...clip(`batch-${workflowRunId}`, workflowRunId, revision),
    artifactKey: `render-batch:${workflowRunId}`, payload: { clips: [] }, updatedAt,
  });
  it('a confirmed pool addition wins over an older repair even though new clips start at revision 1', () => {
    const inputs = [batch('render', 1, '2026-10-01'),
      batch('fill-a', 2, '2026-10-07'), batch('fill-b', 2, '2026-10-06'),
      clip('old', 'render'),
      { ...clip('repair', 'fill-b', 2), updatedAt: '2026-10-06' },
      clip('imported', 'fill-a', 1, 'imported-file', 'imported-prompt')];
    for (const run of ['render', 'fill-a', 'fill-b', 'package-a'])
      expect(effectArtifactSourceOwner(branches, run, 'SEGMENT_RENDER', inputs)).toBe('fill-a');
  });
  it('recognizes a confirmed pool deletion without requiring a changed clip', () => {
    const inputs = [batch('render', 1, '2026-10-01'), batch('fill-a', 2, '2026-10-07')];
    expect(effectArtifactSourceOwner(branches, 'fill-b', 'SEGMENT_RENDER', inputs)).toBe('fill-a');
  });
  it('a later save at the root render head wins over an old sibling edit', () => {
    const inputs = [batch('render', 3, '2026-10-08'), batch('fill-a', 2, '2026-10-07'),
      clip('original', 'render'), { ...clip('repair', 'fill-a', 2), updatedAt: '2026-10-07' }];
    expect(effectArtifactSourceOwner(branches, 'fill-a', 'SEGMENT_RENDER', inputs)).toBe('render');
  });
  it('ignores copied pools and unpublished edits, and does not cross independent render heads', () => {
    const runs = [...branches,
      { id: 'draft', parentWorkflowRunId: 'fill-a', forkNodeId: 'TEMPLATE_MIX', branchPublishedAt: null },
      { id: 'independent', parentWorkflowRunId: 'render', forkNodeId: 'SEGMENT_RENDER' }];
    const inputs = [batch('render', 1, '2026-10-01'), batch('fill-a', 2, '2026-10-07'),
      { ...batch('fill-b', 8, '2026-10-09'), metadata: { branchSource: { artifactId: 'batch-render' } } },
      batch('draft', 9, '2026-10-10'), batch('independent', 10, '2026-10-11')];
    expect(effectArtifactSourceOwner(runs, 'fill-b', 'SEGMENT_RENDER', inputs)).toBe('fill-a');
    expect(effectArtifactSourceOwner(runs, 'independent', 'SEGMENT_RENDER', inputs)).toBe('independent');
  });
  it('regeneration in the newest fill warns older and sibling consumers, but not independent render heads', () => {
    const runs = [...branches, { id: 'fill-c', parentWorkflowRunId: 'fill-b', forkNodeId: 'TEMPLATE_MIX',
      branchPublishedAt: new Date('2026-10-06') },
      { id: 'unsaved', parentWorkflowRunId: 'fill-c', forkNodeId: 'TEMPLATE_MIX', branchPublishedAt: null },
      { id: 'separate', parentWorkflowRunId: 'render', forkNodeId: 'SEGMENT_RENDER' }];
    const inputs = [clip('original', 'render'), clip('copy-a', 'fill-a'), clip('copy-b', 'fill-b'),
      { ...clip('regenerated', 'fill-c', 2, 'new'), updatedAt: new Date('2026-10-06') },
      { ...clip('candidate', 'unsaved', 3, 'unsaved'), updatedAt: new Date('2026-10-07') },
      clip('independent', 'separate'), project('separate-film', 'separate', 'independent'),
      project('film-a', 'fill-a', 'copy-a'), project('film-b', 'fill-b', 'copy-b'),
      project('film-c', 'fill-c', 'regenerated', 1), project('pack-a', 'package-a', 'film-a')];
    for (const runId of ['render', 'fill-a', 'fill-b', 'fill-c'])
      expect(effectArtifactSourceOwner(runs, runId, 'SEGMENT_RENDER', inputs)).toBe('fill-c');
    const before = projectEffectBranchFreshness(runs, inputs);
    expect(before.filter((row) => row.id.startsWith('film-') || row.id === 'pack-a')
      .every((row) => row.freshness === 'STALE')).toBe(true);
    expect(before.find((row) => row.id === 'separate-film')?.freshness).toBe('CURRENT');
    const after = projectEffectBranchFreshness(runs, inputs.map((row) => row.id === 'film-b'
      ? project('film-b', 'fill-b', 'regenerated', 2) : row));
    expect(after.find((row) => row.id === 'film-b')?.freshness).toBe('CURRENT');
    expect(after.find((row) => row.id === 'film-a')?.freshness).toBe('STALE');
    expect(after.find((row) => row.id === 'film-c')?.freshness).toBe('STALE');
    // A material read hydrates only the selected Run/ancestors plus the winning source pool.
    // Owner detection must still use all identities, even when the winning Run's parent is absent.
    const minimal = inputs.filter((row) => ['original', 'copy-a', 'regenerated', 'film-a'].includes(row.id));
    expect(projectEffectBranchFreshness(runs, minimal, inputs)
      .find((row) => row.id === 'film-a')?.freshness).toBe('STALE');
  });
  it('uses a confirmed upstream edit inside a packaging Run and keeps its two descendants stale', () => {
    const runs = [
      { id: 'render', parentWorkflowRunId: null, forkNodeId: null },
      { id: 'pack-01', parentWorkflowRunId: 'render', forkNodeId: 'TEMPLATE_MIX' },
      { id: 'pack-02', parentWorkflowRunId: 'pack-01', forkNodeId: 'TEMPLATE_MIX' },
      { id: 'pack-03', parentWorkflowRunId: 'pack-02', forkNodeId: 'TEMPLATE_MIX' },
    ];
    const inputs = [clip('original', 'render'), clip('repaired', 'pack-01', 2, 'new'),
      clip('copy-02', 'pack-02'), clip('copy-03', 'pack-03'),
      project('film-01', 'pack-01', 'repaired', 2),
      project('film-02', 'pack-02', 'copy-02'), project('film-03', 'pack-03', 'copy-03')];
    for (const id of ['pack-01', 'pack-02', 'pack-03'])
      expect(effectArtifactSourceOwner(runs, id, 'SEGMENT_RENDER', inputs)).toBe('pack-01');
    const result = projectEffectBranchFreshness(runs, inputs);
    expect(result.find((item) => item.id === 'film-01')?.freshness).toBe('CURRENT');
    expect(result.filter((item) => item.freshness === 'STALE').map((item) => item.id))
      .toEqual(['original', 'copy-02', 'copy-03', 'film-02', 'film-03']);
    const updated = inputs.map((item) => item.id === 'film-02'
      ? project('film-02', 'pack-02', 'repaired', 2) : item);
    expect(projectEffectBranchFreshness(runs, updated).filter((item) => item.id.startsWith('film-'))
      .map((item) => item.freshness)).toEqual(['CURRENT', 'CURRENT', 'STALE']);
  });

  it('warns every actual sibling/descendant consumer, not unrelated clips or empty stages', () => {
    const originals = [clip('root-clip', 'render', 2, 'new'), clip('other', 'render', 1, 'same', 'other'),
      clip('copy-a', 'fill-a'), clip('copy-b', 'fill-b'),
      project('film-a', 'fill-a', 'copy-a'), project('film-b', 'fill-b', 'copy-b'),
      project('package', 'package-a', 'film-a'), project('unrelated', 'fill-a', 'other')];
    const result = projectEffectBranchFreshness(branches, originals);
    expect(result.filter((row) => row.freshness === 'STALE').map((row) => row.id))
      .toEqual(['copy-a', 'copy-b', 'film-a', 'film-b', 'package']);
    expect(originals.every((row) => row.freshness === 'CURRENT')).toBe(true);
    expect(result).toHaveLength(originals.length);
  });
  it('updating one branch clears only its own dependency; the sibling and old package stay stale', () => {
    const result = projectEffectBranchFreshness(branches, [clip('root-clip', 'render', 2, 'new'),
      clip('copy-a', 'fill-a'), clip('copy-b', 'fill-b'),
      project('film-a', 'fill-a', 'root-clip', 2), project('film-b', 'fill-b', 'copy-b'),
      { ...project('package', 'package-a', 'film-a'), dependencies: [{
        sourceType: 'WORKING_ARTIFACT', sourceArtifactId: 'copy-a', sourceRevision: 1 }] }]);
    expect(result.find((row) => row.id === 'film-a')?.freshness).toBe('CURRENT');
    expect(result.find((row) => row.id === 'film-b')?.freshness).toBe('STALE');
    expect(result.find((row) => row.id === 'package')?.freshness).toBe('STALE');
  });
  it('does not treat an unchanged file clone as an edited source', () => {
    const result = projectEffectBranchFreshness(branches, [clip('root', 'render'),
      clip('copy', 'fill-a'), project('film', 'fill-a', 'copy')]);
    expect(result.every((row) => row.freshness === 'CURRENT')).toBe(true);
  });
  it('does not promote an explicit clone to a local head just because its revision is greater', () => {
    const input = [clip('root', 'render'), { ...clip('copy', 'fill-a', 2),
      metadata: { branchSource: { artifactId: 'root', revision: 2 } } }];
    expect(effectArtifactSourceOwner(branches, 'fill-a', 'SEGMENT_RENDER', input)).toBe('render');
  });
  it('warns a cloned output timeline after its mix head changes, but respects a local-update commit', () => {
    const rows = [...branches, { id: 'output', parentWorkflowRunId: 'fill-a', forkNodeId: 'FINAL_OUTPUT' }];
    const head = { ...project('head', 'fill-a', 'clip'), revision: 2 };
    const copy = { ...project('copy', 'output', 'clip'), revision: 1,
      artifactKey: head.artifactKey, metadata: { branchSource: { artifactId: head.id } } };
    expect(projectEffectBranchFreshness(rows, [head, copy])[1]?.freshness).toBe('STALE');
    const committed = { ...copy, revision: 3, metadata: { variantId: 'copy' } };
    expect(projectEffectBranchFreshness(rows, [head, committed])[1]?.freshness).toBe('CURRENT');
  });
  it.each(['SEGMENT_RENDER', 'MANUAL_COPY'])('stops at independent %s heads', (forkNodeId) => {
    const independent = [...branches, { id: 'independent', parentWorkflowRunId: 'render', forkNodeId }];
    expect(effectArtifactSourceOwner(independent, 'independent', 'SEGMENT_RENDER')).toBe('independent');
    const result = projectEffectBranchFreshness(independent, [clip('root', 'render', 2, 'new'),
      clip('copy', 'independent'), project('film', 'independent', 'copy')]);
    expect(result.every((row) => row.freshness === 'CURRENT')).toBe(true);
  });
  it('uses explicit provenance for reminted aggregates and propagates through all node types', () => {
    const insight = { ...clip('insight', 'render', 2), nodeId: 'INFORMATION_EXTRACTION',
      artifactKey: 'marketing-insight:root-product', payload: undefined };
    const copy = { ...insight, id: 'copy', workflowRunId: 'fill-a', revision: 1,
      artifactKey: 'marketing-insight:copy-product', metadata: { branchSource: { artifactId: 'insight' } } };
    const result = projectEffectBranchFreshness(branches, [insight, copy,
      { ...project('prompt', 'fill-a', 'copy'), nodeId: 'PROMPT_GENERATION' },
      { ...project('delivery', 'fill-a', 'prompt'), nodeId: 'FINAL_OUTPUT' }]);
    expect(result.map((row) => row.freshness)).toEqual(['CURRENT', 'STALE', 'STALE', 'STALE']);
  });
  it('handles missing parents and dependency cycles without leaking to a different lineage', () => {
    const a = project('a', 'fill-a', 'b'); const b = project('b', 'fill-a', 'a');
    expect(projectEffectBranchFreshness(branches, [a, b]).map((row) => row.freshness))
      .toEqual(['CURRENT', 'CURRENT']);
    expect(effectArtifactSourceOwner([], 'foreign', 'SEGMENT_RENDER')).toBe('foreign');
  });
});
