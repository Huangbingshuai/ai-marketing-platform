import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { effectArtifactSourceOwner, projectEffectBranchFreshness } from './effect-branch-freshness';

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
