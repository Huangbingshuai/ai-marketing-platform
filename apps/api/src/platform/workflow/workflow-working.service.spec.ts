import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { effectTemplateBranchTips } from '@ai-marketing/contracts';
import { WorkflowWorkingService, workflowStateHash } from './workflow-working.service';

describe('effect mix version scopes', () => {
  const at = (minute: number) => new Date(Date.UTC(2026, 9, 4, 0, minute));
  const artifact = (key: string, minute: number, payload: unknown = null) => ({
    nodeId: key.startsWith('final-delivery:') ? 'FINAL_OUTPUT' : 'TEMPLATE_MIX',
    artifactKey: key, name: key, revision: 1, freshness: 'CURRENT',
    createdAt: at(minute), payload,
  });
  const run = (id: string, parent: string | null, minute: number,
    stage: 'TEMPLATE' | 'FILL' | 'PACKAGING' | 'DELIVERY', templateId = 'a') => ({
    id, parentWorkflowRunId: parent, activeKey: id === 'root' ? 'ACTIVE' : null,
    forkNodeId: parent ? stage === 'DELIVERY' ? 'FINAL_OUTPUT' : 'TEMPLATE_MIX' : null,
    forkTemplateId: parent ? templateId : null, branchLabel: null,
    currentNodeId: stage === 'DELIVERY' ? 'FINAL_OUTPUT' : 'TEMPLATE_MIX',
    createdAt: at(minute), updatedAt: at(minute), branchPublishedAt: at(minute),
    effectTemplateMixAiRuns: stage === 'FILL'
      ? [{ templateId, outputVariantId: 'v', idempotencyKey: `fill-${id}` }] : [],
    effectPackagingRuns: stage === 'PACKAGING'
      ? [{ templateId, status: 'COMPLETED', idempotencyKey: `package-${id}`, completedAt: at(minute) }]
      : [],
    workingArtifacts: [
      ...(stage === 'TEMPLATE' ? [artifact(`mix-template:${templateId}`, minute, { template: { name: id } })] : []),
      ...(['FILL', 'PACKAGING'].includes(stage) ? [artifact(`timeline-project:${templateId}:v`, minute)] : []),
      ...(stage === 'PACKAGING' ? [artifact(`timeline-package:${templateId}:v`, minute)] : []),
      ...(stage === 'DELIVERY' ? [artifact(`final-delivery:${templateId}`, minute)] : []),
    ],
  });
  const treeOf = async (rows: ReturnType<typeof run>[]) => {
    const service = new WorkflowWorkingService(
      { listEffectRunBranches: vi.fn().mockResolvedValue(rows) } as never,
      { get: vi.fn().mockResolvedValue({ id: 'project-a' }) } as never, {} as never,
    );
    return (await service.getEffectBranchTree('project-a')).branches;
  };

  it('shows render pending on the saved Prompt path while its shared media owner and sibling stay current', async () => {
    const hash = (value: string) => createHash('sha256').update(value).digest('hex');
    const item = { id: 'prompt', content: 'original', targetDurationSeconds: 5,
      primaryPurpose: 'PRODUCT_DISPLAY', compatiblePurposes: ['PRODUCT_DISPLAY'] };
    const prompt = { ...artifact('prompt-batch:p', 0), id: 'prompt-root', workflowRunId: 'root',
      nodeId: 'PROMPT_GENERATION', payload: { items: [item], sharedPrompt: { contentHash: hash('shared') } } };
    const media = { ...artifact('render-clip:task', 0), id: 'clip', workflowRunId: 'root', nodeId: 'SEGMENT_RENDER',
      dependencies: [{ sourceType: 'WORKING_ARTIFACT', sourceNodeId: 'PROMPT_GENERATION', sourceArtifactId: prompt.id, sourceRevision: 1 }],
      payload: { taskId: 'task', promptId: item.id, promptContentHash: hash(item.content),
        adoptedPrompt: { promptContentHash: hash(item.content), sharedPromptHash: hash('shared'),
          targetDurationSeconds: 5, primaryPurpose: item.primaryPurpose, compatiblePurposes: item.compatiblePurposes } } };
    const pool = { ...media, id: 'pool', artifactKey: 'render-batch:p', payload: { clips: [media.payload] } };
    const root = { ...run('root', null, 0, 'TEMPLATE'), workingArtifacts: [prompt, media, pool] };
    const changed = { ...run('changed', 'root', 1, 'FILL'), workingArtifacts: [{ ...prompt,
      id: 'prompt-local', workflowRunId: 'changed', revision: 2,
      payload: { ...prompt.payload, items: [{ ...item, content: 'saved change' }] } }] };
    const sibling = run('sibling', 'root', 2, 'FILL');
    const states = (rows: Awaited<ReturnType<typeof treeOf>>) => rows.map(branch =>
      branch.nodes.find(node => node.nodeId === 'SEGMENT_RENDER')?.status);
    expect(states(await treeOf([root, changed, sibling]))).toEqual(['CONFIRMED', 'STALE', 'CONFIRMED']);
    changed.workingArtifacts[0]!.payload = prompt.payload;
    expect(states(await treeOf([root, changed, sibling]))).toEqual(['CONFIRMED', 'CONFIRMED', 'CONFIRMED']);
  });

  it('projects only explicit choices stored in their actual branch, not inherited copies', async () => {
    const selected = { ...run('chosen', 'root', 1, 'FILL'), nodeStates: [{
      nodeId: 'TEMPLATE_MIX:current-paths', state: { schemaVersion: 1, workflowRunId: 'chosen',
        selectedTemplates: { a: at(30).toISOString() } },
    }] };
    const copied = { ...run('copied', 'chosen', 2, 'PACKAGING'), nodeStates: selected.nodeStates };
    const result = await treeOf([run('root', null, 0, 'TEMPLATE'), selected, copied]);
    expect(result.find(b => b.workflowRunId === 'chosen')?.templates[0]?.currentSelectedAt).toBe(at(30).toISOString());
    expect(result.find(b => b.workflowRunId === 'copied')?.templates[0]?.currentSelectedAt).toBeNull();
  });

  it('exposes only the current locally owned revision immutable confirmation, not draft or stale timestamps', async () => {
    const local = { ...run('fill', 'root', 1, 'FILL'), updatedAt: at(59),
      workingArtifacts: [{ ...artifact('timeline-project:a:v', 1), id: 'local',
        workflowRunId: 'fill', revision: 2, updatedAt: at(59) }],
      workingArtifactRevisions: [
        { workingArtifactId: 'local', revision: 1, confirmedAt: at(58) },
        { workingArtifactId: 'local', revision: 2, confirmedAt: at(30) },
      ],
    };
    const inherited = { ...run('copy', 'fill', 2, 'PACKAGING'),
      workingArtifacts: [{ ...local.workingArtifacts[0]!, id: 'copied', workflowRunId: 'copy',
        metadata: { branchSource: { artifactId: 'local' } } }],
      workingArtifactRevisions: [{ workingArtifactId: 'copied', revision: 2, confirmedAt: at(50) }],
    };
    const result = await treeOf([run('root', null, 0, 'TEMPLATE'), local, inherited]);
    expect(result.find(b => b.workflowRunId === 'fill')?.templates[0]?.currentConfirmedAt).toBe(at(30).toISOString());
    expect(result.find(b => b.workflowRunId === 'copy')?.templates[0]?.currentConfirmedAt).toBeNull();
    expect(result.find(b => b.workflowRunId === 'root')?.templates[0]?.currentConfirmedAt).toBeNull();
  });

  it('numbers sibling packages together but restarts for a sibling fill', async () => {
    const branches = await treeOf([
      run('root', null, 0, 'TEMPLATE'), run('fill-1', 'root', 1, 'FILL'),
      run('package-1', 'fill-1', 2, 'PACKAGING'),
      run('package-2', 'fill-1', 3, 'PACKAGING'),
      run('fill-2', 'root', 4, 'FILL'), run('package-3', 'fill-2', 5, 'PACKAGING'),
    ]);
    expect(branches.map((b) => b.templates[0]?.fillRevision)).toEqual([null, 1, 1, 1, 2, 2]);
    expect(branches.map((b) => b.templates[0]?.packagingRevision)).toEqual([null, null, 1, 2, null, 1]);
    expect(branches[3]?.templates[0]?.packagingRevisions).toEqual([1]);
  });

  it('dates a repackage by its first successful local film rather than copied baseline artifacts', async () => {
    const packaged = run('repackage', 'fill', 20, 'PACKAGING');
    packaged.workingArtifacts.forEach((entry) => { entry.createdAt = at(2); });
    Object.assign(packaged.effectPackagingRuns[0]!, { items: [
      { variantId: 'failed', status: 'FAILED', completedAt: at(19) },
      { variantId: 'first', status: 'COMPLETED', completedAt: at(21) },
      { variantId: 'later', status: 'COMPLETED', completedAt: at(22) },
    ], completedAt: at(25) });
    packaged.effectPackagingRuns.push({ templateId: 'a', status: 'COMPLETED',
      idempotencyKey: 'inherit:package:old', completedAt: at(1) });
    const rows = [run('root', null, 0, 'TEMPLATE'), run('fill', 'root', 1, 'FILL'), packaged];
    const first = (await treeOf(rows))[2]!.templates[0]!;
    expect(first.packagingCreatedAt).toBe(at(21).toISOString());
    packaged.effectPackagingRuns.push({ templateId: 'a', status: 'COMPLETED',
      idempotencyKey: 'append-new-films', completedAt: at(40) });
    const after = (await treeOf(rows))[2]!.templates[0]!;
    expect(after.packagingCreatedAt).toBe(first.packagingCreatedAt);
    expect(after.packagingRevision).toBe(first.packagingRevision);
  });

  it.each(['COMPLETED', 'PARTIAL', 'RUNNING', 'FAILED', 'CANCELED'])('retains a published fill head after first in-place packaging is %s', async (status) => {
    const fill = run('fill', 'root', 1, 'FILL');
    const before = await treeOf([run('root', null, 0, 'TEMPLATE'), fill]);
    fill.effectPackagingRuns = [{ templateId: 'a', status, idempotencyKey: 'first-package', completedAt: at(2) }];
    fill.workingArtifacts.push(artifact('timeline-package:a:v', 2));
    const branches = await treeOf([run('root', null, 0, 'TEMPLATE'), fill]);
    expect(branches.map(b => b.workflowRunId)).toEqual(['root', 'fill']);
    expect(branches[1]?.forkMixStage).toBe('FILL');
    expect(branches[1]?.templates[0]?.fillRevision).toBe(before[1]?.templates[0]?.fillRevision);
    expect(branches[1]?.templates[0]?.timelineVariantCount).toBe(1);
  });

  it('keeps a re-fill and its first package together without reparenting later packages or renumbering siblings', async () => {
    const first = run('fill-1', 'root', 1, 'FILL');
    first.effectPackagingRuns = run('unused', null, 2, 'PACKAGING').effectPackagingRuns;
    first.workingArtifacts.push(artifact('timeline-package:a:v', 2));
    const second = run('fill-2', 'fill-1', 3, 'FILL');
    second.effectPackagingRuns = run('unused', null, 4, 'PACKAGING').effectPackagingRuns;
    second.workingArtifacts.push(artifact('timeline-package:a:v', 4));
    const rows = [run('root', null, 0, 'TEMPLATE'), first, second,
      run('repackage-1', second.id, 5, 'PACKAGING'),
      run('repackage-2', second.id, 6, 'PACKAGING')];
    const branches = await treeOf(rows);
    expect(branches.map(b => b.forkMixStage)).toEqual([null, 'FILL', 'FILL', 'PACKAGING', 'PACKAGING']);
    expect(branches.map(b => b.templates[0]?.fillRevision)).toEqual([null, 1, 2, 2, 2]);
    expect(branches.map(b => b.templates[0]?.packagingRevision)).toEqual([null, 1, 1, 2, 3]);
    // Updating the same confirmed timelines is not a new fill or package branch.
    second.workingArtifacts[0]!.revision = 8;
    expect((await treeOf(rows)).map(b => b.templates[0]?.fillRevision)).toEqual([null, 1, 2, 2, 2]);
  });

  it.each([
    { idempotencyKey: 'inherit:package:mix:old', inputSnapshot: {} },
    { idempotencyKey: 'append', inputSnapshot: { incremental: true } },
    { idempotencyKey: 'trim', inputSnapshot: { trimOnly: true } },
  ])('does not mistake $idempotencyKey for an owned full fill in a packaging fork', async (task) => {
    const packaged = run('package', 'fill', 2, 'PACKAGING');
    Object.assign(packaged, { effectTemplateMixAiRuns: [{ templateId: 'a', outputVariantId: 'v', ...task }] });
    const branches = await treeOf([run('root', null, 0, 'TEMPLATE'), run('fill', 'root', 1, 'FILL'), packaged]);
    expect(branches[2]?.forkMixStage).toBe('PACKAGING');
    expect(branches[2]?.templates[0]?.fillRevision).toBe(1);
  });

  it('does not let another template own the targeted packaging fork', async () => {
    const packaged = run('package', 'fill', 2, 'PACKAGING');
    Object.assign(packaged, { effectTemplateMixAiRuns: [{ templateId: 'b', outputVariantId: 'v', idempotencyKey: 'fill-b' }] });
    packaged.workingArtifacts.push(artifact('timeline-project:b:v', 2));
    const branches = await treeOf([run('root', null, 0, 'TEMPLATE'), run('fill', 'root', 1, 'FILL'), packaged]);
    expect(branches[2]?.forkMixStage).toBe('PACKAGING');
  });

  it('retains the fill layer when its template was only a draft in the parent', async () => {
    const root = run('root', null, 0, 'TEMPLATE');
    root.workingArtifacts = [];
    const fill = run('fill', root.id, 1, 'FILL');
    fill.workingArtifacts.push(artifact('mix-template:a', 1, { template: { name: '测试1' } }));
    const before = await treeOf([root, fill]);
    fill.effectPackagingRuns = run('unused', null, 2, 'PACKAGING').effectPackagingRuns;
    fill.workingArtifacts.push(artifact('timeline-package:a:v', 2));
    const after = await treeOf([root, fill]);
    expect(after[1]?.forkMixStage).toBe('TEMPLATE');
    expect(after[1]?.forkMixStage).toBe(before[1]?.forkMixStage);
    expect(after[1]?.templates[0]).toMatchObject({ timelineVariantCount: 1,
      fillRevision: 1, packagingVariantCount: 1, packagingRevision: 1 });
  });

  it('exposes a published modern partial batch as the current packaging path and next export head', async () => {
    const partial = run('partial-package', 'fill', 2, 'PACKAGING');
    Object.assign(partial.effectPackagingRuns[0]!, { status: 'PARTIAL', operation: 'BATCH_PACKAGE',
      items: [{ variantId: 'v', status: 'COMPLETED' }, { variantId: 'failed', status: 'FAILED' }] });
    Object.assign(partial.workingArtifacts[1]!, { id: 'confirmed-package', workflowRunId: partial.id });
    const published = { ...partial, workingArtifactRevisions: [
      { workingArtifactId: 'confirmed-package', revision: 1, confirmedAt: at(3) },
    ] };
    const next = run('repackage', partial.id, 4, 'PACKAGING');
    const rows = [run('root', null, 0, 'TEMPLATE'), run('fill', 'root', 1, 'FILL'), published];
    const branches = await treeOf(rows);
    expect(branches.map(b => b.workflowRunId)).toEqual(['root', 'fill', partial.id]);
    expect(branches[2]?.templates[0]?.packagingRevision).toBe(1);
    expect(effectTemplateBranchTips(branches, 'root', { current: true }).get('a')?.workflowRunId)
      .toBe(partial.id);
    const withChildren = await treeOf([...rows, next, run('export', partial.id, 5, 'DELIVERY')]);
    expect(withChildren.find(b => b.workflowRunId === next.id)?.templates[0]?.packagingRevision).toBe(2);
    expect(withChildren.find(b => b.workflowRunId === 'export')?.templates[0]?.deliveryRevision).toBe(1);
    expect(withChildren.find(b => b.workflowRunId === 'export')?.templates[0]?.packagingRevision).toBe(1);
    // Re-reading or editing a completed film cannot hide or renumber the published head.
    partial.workingArtifacts[1]!.revision = 7;
    expect((await treeOf(rows))[2]?.templates[0]?.packagingRevision).toBe(1);
  });

  it.each([
    { operation: undefined, status: 'PARTIAL', successful: true, published: true },
    { operation: 'BATCH_PACKAGE', status: 'PARTIAL', successful: true, published: false },
    { operation: 'BATCH_PACKAGE', status: 'RUNNING', successful: true, published: true },
    { operation: 'BATCH_PACKAGE', status: 'PARTIAL', successful: false, published: true },
    { operation: 'BATCH_PACKAGE', status: 'FAILED', successful: false, published: true },
    { operation: 'SINGLE_PACKAGE', status: 'PARTIAL', successful: true, published: true },
    { operation: 'APPEND_PACKAGE', status: 'PARTIAL', successful: true, published: true },
  ])('does not expose an ineligible partial packaging head: %j', async (example) => {
    const partial = run('partial', 'fill', 2, 'PACKAGING');
    Object.assign(partial.effectPackagingRuns[0]!, { operation: example.operation, status: example.status,
      items: [{ variantId: 'v', status: example.successful ? 'COMPLETED' : 'FAILED' }] });
    if (!example.published) Object.assign(partial, { branchPublishedAt: null });
    const branches = await treeOf([run('root', null, 0, 'TEMPLATE'), run('fill', 'root', 1, 'FILL'), partial]);
    expect(branches.map(b => b.workflowRunId)).toEqual(['root', 'fill']);
    expect(effectTemplateBranchTips(branches, 'root', { current: true }).get('a')?.workflowRunId).toBe('fill');
  });

  it('counts each fill branch once, regardless of local-update artifact revisions or film count', async () => {
    const first = run('fill-1', 'root', 1, 'FILL');
    const second = run('fill-2', 'fill-1', 2, 'FILL');
    const third = run('fill-3', 'fill-2', 3, 'FILL');
    for (const fill of [first, second, third]) {
      fill.workingArtifacts[0]!.revision = 3;
      fill.workingArtifacts.push({ ...artifact('timeline-project:a:another-film', 4), revision: 2 });
    }
    const rows = [run('root', null, 0, 'TEMPLATE'), first, second, third];
    const versions = async () => (await treeOf(rows)).map(branch => branch.templates[0]?.fillRevision);
    expect(await versions()).toEqual([null, 1, 2, 3]);
    expect((await treeOf(rows))[1]?.templates[0]?.fillRevisions).toEqual([2, 3]);
    first.workingArtifacts[0]!.revision = 9;
    second.workingArtifacts[1]!.revision = 12;
    expect(await versions()).toEqual([null, 1, 2, 3]);
    expect(first.workingArtifacts[0]!.revision).toBe(9);
    expect(second.workingArtifacts[1]!.revision).toBe(12);
    // Repository order and repeated reads cannot reserve extra version numbers.
    expect((await treeOf([third, rows[0]!, second, first]))
      .filter(branch => branch.workflowRunId !== 'root')
      .map(branch => branch.templates[0]?.fillRevision).sort()).toEqual([1, 2, 3]);
  });

  it('counts a root delivery head once after in-place updates, without gaps in sibling exports', async () => {
    const root = run('root', null, 0, 'FILL');
    root.workingArtifacts.push({ ...artifact('final-delivery:a', 1), revision: 7 });
    const rows = [root, run('output', 'root', 2, 'DELIVERY')];
    expect((await treeOf(rows)).map(branch => branch.templates[0]?.deliveryRevision)).toEqual([1, 2]);
    root.workingArtifacts.at(-1)!.revision = 11;
    expect((await treeOf(rows)).map(branch => branch.templates[0]?.deliveryRevision)).toEqual([1, 2]);
  });

  it('shows a historical first in-place delivery without counting its inherited copies as exports', async () => {
    const packaged = run('package', 'fill', 2, 'PACKAGING');
    const delivery = artifact('final-delivery:a', 3);
    packaged.workingArtifacts.push(delivery);
    const copy = run('repackage', packaged.id, 4, 'PACKAGING');
    copy.workingArtifacts.push({ ...delivery, metadata: { branchSource: { artifactId: 'old-delivery' } } } as typeof delivery);
    const rows = [run('root', null, 0, 'TEMPLATE'), run('fill', 'root', 1, 'FILL'), packaged, copy,
      run('export', packaged.id, 5, 'DELIVERY')];
    const result = await treeOf(rows);
    expect(result[2]!.templates[0]!.deliveryRevision).toBe(1);
    expect(result[4]!.templates[0]!.deliveryRevision).toBe(2);
    expect(result[2]!.templates[0]!.deliveryCreatedAt).toBe(at(3).toISOString());
  });

  it('keeps the first package at 01 after local updates and numbers subsequent branches without gaps', async () => {
    const first = run('package-1', 'fill-1', 2, 'PACKAGING');
    first.workingArtifacts.find((item) => item.artifactKey.startsWith('timeline-package:'))!.revision = 2;
    const rows = [run('root', null, 0, 'TEMPLATE'), run('fill-1', 'root', 1, 'FILL'),
      first, run('package-2', 'package-1', 3, 'PACKAGING')];
    const branches = await treeOf(rows);
    expect(branches.map((item) => item.templates[0]?.packagingRevision)).toEqual([null, null, 1, 2]);
    expect(branches[2]?.templates[0]?.packagingRevisions).toEqual([2]);
    first.workingArtifacts.find((item) => item.artifactKey.startsWith('timeline-package:'))!.revision = 5;
    expect((await treeOf(rows)).map((item) => item.templates[0]?.packagingRevision))
      .toEqual([null, null, 1, 2]);
  });

  it('does not move an old package behind its siblings when newly appended films finish packaging later', async () => {
    const first = run('package-1', 'fill', 2, 'PACKAGING');
    first.effectPackagingRuns.push({ templateId: 'a', status: 'COMPLETED',
      idempotencyKey: 'package-new-films', completedAt: at(59) });
    const branches = await treeOf([run('root', null, 0, 'TEMPLATE'),
      run('fill', 'root', 1, 'FILL'), first,
      run('package-2', 'package-1', 3, 'PACKAGING'),
      run('package-3', 'package-2', 4, 'PACKAGING')]);
    expect(branches.map(branch => branch.templates[0]?.packagingRevision))
      .toEqual([null, null, 1, 2, 3]);
  });

  it.each([{ incremental: { materialIds: ['new-material'] } }, { trimOnly: true }])('does not create a fill head or renumber package paths for local repair %j', async (inputSnapshot) => {
    const second = run('package-2', 'package-1', 3, 'PACKAGING');
    const rows = [run('root', null, 0, 'TEMPLATE'), run('fill', 'root', 1, 'FILL'),
      run('package-1', 'fill', 2, 'PACKAGING'), second, run('package-3', 'package-2', 4, 'PACKAGING')];
    const before = await treeOf(rows);
    second.effectTemplateMixAiRuns.push({ templateId: 'a', outputVariantId: 'v',
      idempotencyKey: 'local-update', inputSnapshot } as never);
    second.effectPackagingRuns.push({ templateId: 'a', status: 'COMPLETED',
      idempotencyKey: 'package-new-films', completedAt: at(59) });
    const after = await treeOf(rows);
    const identities = (branches: typeof before) => branches.map(b => ({ run: b.workflowRunId,
      fill: b.templates[0]?.fillRevision, packaging: b.templates[0]?.packagingRevision }));
    expect(identities(after)).toEqual(identities(before));
    expect(after.map(b => b.templates[0]?.packagingRevision)).toEqual([null, null, 1, 2, 3]);
    expect(after.map(b => b.templates[0]?.fillRevision)).toEqual([null, 1, 1, 1, 1]);
  });

  it('uses the named mix draft rather than navigation row order when counting appended films', async () => {
    const second = run('package-2', 'package-1', 3, 'PACKAGING');
    second.workingArtifacts.push(artifact('timeline-project:a:new', 59), artifact('timeline-package:a:new', 59));
    const selected = { ...second, nodeStates: [
      { nodeId: 'TEMPLATE_MIX:current-paths', state: { schemaVersion: 1, workflowRunId: second.id,
        selectedTemplates: { a: at(59).toISOString() } } },
      { nodeId: 'TEMPLATE_MIX', state: { schemaVersion: 1, templates: [{ id: 'a', workspace: {
        template: { name: 'a' }, variants: [{ id: 'v' }, { id: 'new' }],
      } }] } },
    ] };
    const rows = [run('root', null, 0, 'TEMPLATE'), run('fill', 'root', 1, 'FILL'),
      run('package-1', 'fill', 2, 'PACKAGING'), selected];
    const project = async () => (await treeOf(rows)).find(b => b.workflowRunId === second.id)?.templates[0];
    expect(await project()).toMatchObject({ timelineVariantCount: 2, packagingVariantCount: 2,
      packagingRevision: 2, currentSelectedAt: at(59).toISOString() });
    selected.nodeStates.reverse();
    expect(await project()).toMatchObject({ timelineVariantCount: 2, packagingVariantCount: 2, packagingRevision: 2 });
  });

  it('scopes picture-only exports to fill heads and packaged exports to package heads', async () => {
    const branches = await treeOf([
      run('root', null, 0, 'TEMPLATE'), run('fill-1', 'root', 1, 'FILL'),
      run('output-1', 'fill-1', 2, 'DELIVERY'), run('output-2', 'fill-1', 3, 'DELIVERY'),
      run('fill-2', 'root', 4, 'FILL'), run('output-3', 'fill-2', 5, 'DELIVERY'),
      run('package-1', 'fill-1', 6, 'PACKAGING'),
      run('output-4', 'package-1', 7, 'DELIVERY'), run('output-5', 'package-1', 8, 'DELIVERY'),
      run('package-2', 'fill-1', 9, 'PACKAGING'), run('output-6', 'package-2', 10, 'DELIVERY'),
    ]);
    const outputs = branches.filter((b) => b.forkNodeId === 'FINAL_OUTPUT');
    expect(outputs.map((b) => b.templates[0]?.deliveryRevision)).toEqual([1, 2, 1, 1, 2, 1]);
  });

  it('starts an in-place first package at 01 even after packages under an older fill', async () => {
    const output = run('output', 'fill-2', 5, 'DELIVERY');
    const packaged = run('unused', null, 9, 'PACKAGING');
    output.effectPackagingRuns = packaged.effectPackagingRuns;
    output.workingArtifacts.push(...packaged.workingArtifacts);
    const branches = await treeOf([
      run('root', null, 0, 'TEMPLATE'), run('fill-1', 'root', 1, 'FILL'),
      run('package-1', 'fill-1', 2, 'PACKAGING'), run('package-2', 'package-1', 3, 'PACKAGING'),
      run('fill-2', 'package-2', 4, 'FILL'), output,
    ]);
    expect(branches[5]).toMatchObject({ workflowRunId: 'output', packagingInOutputBranch: true });
    expect(branches[5]?.templates[0]).toMatchObject({
      fillRevision: 2, packagingRevision: 1, packagingRevisions: [1], deliveryRevision: 1,
    });
  });

  it('does not renumber an earlier picture-only delivery when packaging is added in place', async () => {
    const output = run('output-1', 'fill', 2, 'DELIVERY');
    const packaged = run('unused', null, 9, 'PACKAGING');
    output.effectPackagingRuns = packaged.effectPackagingRuns;
    output.workingArtifacts.push(...packaged.workingArtifacts);
    const branches = await treeOf([
      run('root', null, 0, 'TEMPLATE'), run('fill', 'root', 1, 'FILL'), output,
      run('output-2', 'fill', 3, 'DELIVERY'), run('output-3', 'output-1', 10, 'DELIVERY'),
    ]);
    expect(branches.filter((b) => b.forkNodeId === 'FINAL_OUTPUT')
      .map((b) => b.templates[0]?.deliveryRevision)).toEqual([1, 2, 1]);
  });

  it('restarts fills when the template configuration head changes and isolates template ids', async () => {
    const branches = await treeOf([
      run('root', null, 0, 'TEMPLATE'), run('fill-1', 'root', 1, 'FILL'),
      run('fill-2', 'root', 2, 'FILL'), run('template-2', 'fill-2', 3, 'TEMPLATE'),
      run('fill-3', 'template-2', 4, 'FILL'), run('template-b', 'root', 5, 'TEMPLATE', 'b'),
      run('fill-b', 'template-b', 6, 'FILL', 'b'), run('package-b', 'fill-b', 7, 'PACKAGING', 'b'),
    ]);
    expect(branches[4]?.templates.find((t) => t.templateId === 'a')?.fillRevision).toBe(1);
    expect(branches[7]?.templates.find((t) => t.templateId === 'b')).toMatchObject({
      fillRevision: 1, packagingRevision: 1,
    });
  });
});

describe('workflowStateHash', () => {
  it('normalizes object key order while preserving array order', () => {
    expect(workflowStateHash({ b: 2, a: { y: 2, x: 1 } })).toBe(
      workflowStateHash({ a: { x: 1, y: 2 }, b: 2 }),
    );
    expect(workflowStateHash({ values: [1, 2] })).not.toBe(workflowStateHash({ values: [2, 1] }));
  });
});

describe('WorkflowWorkingService node activation', () => {
  it('returns the activated run without writing node state', async () => {
    const timestamp = new Date('2026-08-26T03:00:00.000Z');
    const repository = {
      activateNode: vi.fn().mockResolvedValue({
        id: 'run-a',
        projectId: 'project-a',
        workflow: 'EFFECT',
        workflowSpace: 'EFFECT',
        status: 'ACTIVE',
        currentNodeId: 'INFORMATION_EXTRACTION',
        lastActiveAt: timestamp,
        createdAt: timestamp,
        updatedAt: timestamp,
      }),
    };
    const projects = { get: vi.fn().mockResolvedValue({ id: 'project-a' }) };
    const service = new WorkflowWorkingService(repository as never, projects as never, {} as never);

    await expect(
      service.activateNode('project-a', 'run-a', 'INFORMATION_EXTRACTION'),
    ).resolves.toEqual({
      run: expect.objectContaining({
        id: 'run-a',
        currentNodeId: 'INFORMATION_EXTRACTION',
        lastActiveAt: timestamp.toISOString(),
      }),
    });
    expect(repository.activateNode).toHaveBeenCalledWith(
      'project-a',
      'run-a',
      'INFORMATION_EXTRACTION',
    );
  });
});

describe('WorkflowWorkingService effect branch tree', () => {
  it.each([false, true])('dates a published upstream fork by publication, including when an old projection is cached (%s)', async (cached) => {
    const originalAt = new Date('2026-10-15T12:37:00.000Z');
    const publishedAt = new Date('2026-10-16T05:31:48.000Z');
    const base = {
      projectId: 'project-a', workflow: 'EFFECT', workflowSpace: 'EFFECT', status: 'ACTIVE',
      forkTemplateId: null, branchLabel: null, currentNodeId: 'PROMPT_GENERATION',
      updatedAt: publishedAt, nodeStates: [], effectTemplateMixAiRuns: [], effectPackagingRuns: [],
    };
    const artifact = (revision: number) => ({
      nodeId: 'PROMPT_GENERATION', artifactKey: 'prompt-batch:product', name: 'Prompt',
      revision, freshness: 'CURRENT', createdAt: originalAt,
    });
    const repository = { listEffectRunBranches: vi.fn().mockResolvedValue([
      { ...base, id: 'root', parentWorkflowRunId: null, forkNodeId: null, activeKey: 'ACTIVE',
        createdAt: originalAt, branchPublishedAt: originalAt, workingArtifacts: [artifact(1)] },
      { ...base, id: 'fork', parentWorkflowRunId: 'root', forkNodeId: 'PROMPT_GENERATION', activeKey: null,
        createdAt: new Date('2026-10-16T05:14:45.000Z'), branchPublishedAt: publishedAt,
        workingArtifacts: [artifact(4)] },
    ]) };
    const oldProjection = { branches: [{ workflowRunId: 'fork', nodes: [{
      nodeId: 'PROMPT_GENERATION', revision: 4, artifactCreatedAt: originalAt.toISOString(),
    }] }] };
    const cache = { read: vi.fn(async (_scope: unknown, _resource: unknown,
      loader: () => Promise<unknown>, vary: unknown) =>
      vary === 'fill-head-lineage-v6:confirmed-output-membership-v1' ? oldProjection : loader()) };
    const service = new WorkflowWorkingService(repository as never,
      { get: vi.fn().mockResolvedValue({ id: 'project-a' }) } as never, {} as never,
      cached ? cache as never : undefined);
    const tree = await service.getEffectBranchTree('project-a');
    expect(tree.branches.find(b => b.workflowRunId === 'fork')?.nodes
      .find(n => n.nodeId === 'PROMPT_GENERATION'))
      .toMatchObject({ revision: 4, artifactCreatedAt: publishedAt.toISOString() });
    expect(tree.branches.find(b => b.workflowRunId === 'root')?.nodes
      .find(n => n.nodeId === 'PROMPT_GENERATION')?.artifactCreatedAt)
      .toBe(originalAt.toISOString());
  });

  it.each(['old-sibling', 'new-fill'])(
    'keeps a new template and its results visible when the active catalog is %s', async (activeId) => {
      const at = (minute: number) => new Date(Date.UTC(2026, 9, 6, 5, minute));
      const catalog = (ids: string[], filled = false) => [{ state: { schemaVersion: 1,
        templates: ids.map((id) => ({ id, workspace: { template: { name: id },
          variants: filled && id === '测试2' ? [{ id: 'v' }] : [] } })),
      } }];
      const artifact = (key: string, minute: number) => ({
        nodeId: key.startsWith('render-') ? 'SEGMENT_RENDER' : 'TEMPLATE_MIX',
        artifactKey: key, name: key, revision: 1, freshness: 'CURRENT', createdAt: at(minute),
      });
      const run = (id: string, parent: string | null, minute: number, ids: string[]) => ({
        id, projectId: 'project-a', workflow: 'EFFECT', workflowSpace: 'EFFECT', status: 'ACTIVE',
        parentWorkflowRunId: parent, activeKey: id === activeId ? 'ACTIVE' : null,
        forkNodeId: parent ? 'TEMPLATE_MIX' : null, forkTemplateId: parent ? '测试2' : null,
        branchPublishedAt: at(minute), branchLabel: null, currentNodeId: 'TEMPLATE_MIX',
        createdAt: at(minute), updatedAt: at(minute), nodeStates: catalog(ids),
        effectTemplateMixAiRuns: [], effectPackagingRuns: [], workingArtifacts: [] as ReturnType<typeof artifact>[],
      });
      const root = run('root', null, 0, ['测试1']);
      root.workingArtifacts = [artifact('render-batch:product', 0), artifact('mix-template:测试1', 0)];
      const origin = run('origin', 'root', 1, ['测试1', '测试2']);
      const old = run('old-sibling', 'root', 2, ['测试1']);
      const filled = run('new-fill', 'origin', 3, ['测试1', '测试2']);
      filled.nodeStates = catalog(['测试1', '测试2'], true);
      filled.workingArtifacts = [artifact('mix-template:测试2', 3), artifact('timeline-project:测试2:v', 3)];
      const packaged = run('new-package', 'new-fill', 4, ['测试1', '测试2']);
      packaged.nodeStates = catalog(['测试1', '测试2'], true);
      packaged.workingArtifacts = [artifact('timeline-package:测试2:v', 4)];
      const repository = { listEffectRunBranches: vi.fn().mockResolvedValue([root, origin, old, filled, packaged]) };
      const service = new WorkflowWorkingService(repository as never,
        { get: vi.fn().mockResolvedValue({ id: 'project-a' }) } as never, {} as never);
      const tree = await service.getEffectBranchTree('project-a');
      expect(tree.branches.find((branch) => branch.workflowRunId === 'old-sibling')?.templates
        .map((template) => template.templateId)).toEqual(['测试1']);
      expect(tree.branches.find((branch) => branch.workflowRunId === 'origin')?.templates)
        .toContainEqual(expect.objectContaining({ templateId: '测试2', templateRevision: null }));
      expect(tree.branches.find((branch) => branch.workflowRunId === 'new-fill')?.templates)
        .toContainEqual(expect.objectContaining({ templateId: '测试2', timelineVariantCount: 1 }));
      expect(tree.branches.find((branch) => branch.workflowRunId === 'new-package')?.templates)
        .toContainEqual(expect.objectContaining({ templateId: '测试2', packagingVariantCount: 1 }));
    },
  );

  it('does not resurrect removed templates from historical branch artifacts', async () => {
    const createdAt = new Date('2026-10-04T01:00:00.000Z');
    const templateArtifact = (templateId: string, name: string) => ({
      nodeId: 'TEMPLATE_MIX',
      artifactKey: `mix-template:${templateId}`,
      revision: 1,
      createdAt,
      freshness: 'CURRENT',
      name,
      payload: { template: { name } },
    });
    const base = {
      projectId: 'project-a',
      workflow: 'EFFECT',
      workflowSpace: 'EFFECT',
      status: 'ACTIVE',
      currentNodeId: 'TEMPLATE_MIX',
      createdAt,
      updatedAt: createdAt,
      lastActiveAt: createdAt,
      branchLabel: null,
      forkTemplateId: null,
      nodeStates: [],
      effectTemplateMixAiRuns: [],
      effectPackagingRuns: [],
    };
    const repository = {
      listEffectRunBranches: vi.fn().mockResolvedValue([
        {
          ...base,
          id: 'root',
          activeKey: 'ACTIVE',
          parentWorkflowRunId: null,
          forkNodeId: null,
          nodeStates: [{ state: {
            schemaVersion: 1,
            templates: [{ id: 'template-current', workspace: { template: { name: '测试1' } } }],
          } }],
          workingArtifacts: [
            templateArtifact('template-current', '测试1'),
            templateArtifact('template-removed', '测试8'),
          ],
        },
        {
          ...base,
          id: 'historical-child',
          activeKey: null,
          parentWorkflowRunId: 'root',
          forkNodeId: 'TEMPLATE_MIX',
          forkTemplateId: 'template-removed',
          branchPublishedAt: createdAt,
          workingArtifacts: [templateArtifact('template-removed', '测试8')],
        },
      ]),
    };
    const service = new WorkflowWorkingService(
      repository as never,
      { get: vi.fn().mockResolvedValue({ id: 'project-a' }) } as never,
      {} as never,
    );

    const tree = await service.getEffectBranchTree('project-a');

    expect(tree.branches.map(({ templates }) => templates.map(({ templateId }) => templateId)))
      .toEqual([['template-current'], ['template-current']]);
  });

  it.each(['remaining', 'empty', 'legacy'])(
    'projects %s mix projects without counting deleted artifacts or changing historical deliveries',
    async (mode) => {
      const createdAt = new Date('2026-10-06T01:00:00.000Z');
      const draft = (ids: string[] | null) => [{ state: { schemaVersion: 1, templates: [{
        id: 'template-a', workspace: { template: { name: '测试2' },
          ...(ids === null ? {} : { variants: ids.map((id) => ({ id })) }) },
      }] } }];
      const artifact = (key: string, runId: string, stale = false) => ({
        id: `${runId}:${key}`, workflowRunId: runId, artifactKey: key,
        nodeId: key.startsWith('final-') ? 'FINAL_OUTPUT' : 'TEMPLATE_MIX',
        name: key, createdAt, revision: 1, freshness: stale ? 'STALE' : 'CURRENT',
      });
      const mixArtifacts = (runId: string) => [
        artifact('mix-template:template-a', runId),
        ...['v1', 'v2', 'v3', 'v4'].flatMap((id) => [
          artifact(`timeline-project:template-a:${id}`, runId, id === 'v2'),
          artifact(`timeline-package:template-a:${id}`, runId, id === 'v2'),
        ]),
      ];
      const base = { projectId: 'project-a', forkNodeId: 'TEMPLATE_MIX',
        forkTemplateId: 'template-a', branchLabel: null, currentNodeId: 'TEMPLATE_MIX',
        createdAt, updatedAt: createdAt, branchPublishedAt: createdAt, activeKey: null,
        effectPackagingRuns: [{ templateId: 'template-a', status: 'COMPLETED',
          idempotencyKey: 'own-package', completedAt: createdAt }] };
      const rows = [
        { ...base, id: 'parent', parentWorkflowRunId: null, forkNodeId: null,
          nodeStates: draft(['v1', 'v2', 'v3', 'v4']), workingArtifacts: mixArtifacts('parent') },
        { ...base, id: 'current', parentWorkflowRunId: 'parent', activeKey: 'ACTIVE',
          nodeStates: draft(mode === 'empty' ? [] : mode === 'legacy' ? null : ['v1', 'v3', 'v4']),
          workingArtifacts: mixArtifacts('current') },
        { ...base, id: 'sibling', parentWorkflowRunId: 'parent',
          nodeStates: draft(['v1', 'v2', 'v3', 'v4']), workingArtifacts: mixArtifacts('sibling') },
        { ...base, id: 'delivery', parentWorkflowRunId: 'current', forkNodeId: 'FINAL_OUTPUT',
          nodeStates: [], workingArtifacts: [artifact('final-delivery:template-a', 'delivery'),
            artifact('final-video:template-a:v2', 'delivery', true)] },
      ];
      const before = JSON.stringify(rows);
      const service = new WorkflowWorkingService(
        { listEffectRunBranches: vi.fn().mockResolvedValue(rows) } as never,
        { get: vi.fn().mockResolvedValue({ id: 'project-a' }) } as never, {} as never,
      );
      const tree = await service.getEffectBranchTree('project-a');
      const expectedCount = mode === 'empty' ? 0 : mode === 'legacy' ? 4 : 3;
      const expectedStatus = mode === 'empty' ? 'PENDING' : mode === 'legacy' ? 'STALE' : 'CONFIRMED';
      for (const id of ['current', 'delivery']) {
        expect(tree.branches.find((branch) => branch.workflowRunId === id)?.templates[0])
          .toMatchObject({ timelineVariantCount: expectedCount, packagingVariantCount: expectedCount,
            fillStatus: expectedStatus, packagingStatus: expectedStatus });
      }
      for (const id of ['parent', 'sibling']) {
        expect(tree.branches.find((branch) => branch.workflowRunId === id)?.templates[0])
          .toMatchObject({ timelineVariantCount: 4, packagingVariantCount: 4,
            fillStatus: 'STALE', packagingStatus: 'STALE' });
      }
      expect(tree.branches.find((branch) => branch.workflowRunId === 'delivery')?.templates[0])
        .toMatchObject({ deliveryCount: 1, deliveryStatus: 'STALE' });
      expect(JSON.stringify(rows)).toBe(before);
    },
  );

  it('includes unconfirmed mix templates from the active run draft without creating a version', async () => {
    const createdAt = new Date('2026-09-28T01:00:00.000Z');
    const repository = {
      listEffectRunBranches: vi.fn().mockResolvedValue([
        {
          id: 'root',
          activeKey: 'ACTIVE',
          parentWorkflowRunId: null,
          forkNodeId: null,
          forkTemplateId: null,
          branchLabel: null,
          currentNodeId: 'TEMPLATE_MIX',
          createdAt,
          updatedAt: createdAt,
          nodeStates: [
            {
              state: {
                schemaVersion: 1,
                activeTemplateId: 'template-new',
                templates: [
                  {
                    id: 'template-new',
                    createdAt: '2026-09-27T08:00:00.000Z',
                    workspace: { template: { name: '新品跑量模板' } },
                  },
                  { id: 'template-old', workspace: { template: { name: '测试1' } } },
                ],
              },
            },
          ],
          workingArtifacts: [
            {
              nodeId: 'SEGMENT_RENDER',
              artifactKey: 'render-batch:product-a',
              revision: 1,
              createdAt,
              freshness: 'CURRENT',
              name: '已确认素材池',
            },
            {
              nodeId: 'TEMPLATE_MIX',
              artifactKey: 'mix-template:template-old',
              revision: 3,
              createdAt,
              freshness: 'CURRENT',
              name: '测试1',
            },
          ],
        },
      ]),
    };
    const service = new WorkflowWorkingService(
      repository as never,
      { get: vi.fn().mockResolvedValue({ id: 'project-a' }) } as never,
      {} as never,
    );

    const tree = await service.getEffectBranchTree('project-a');

    expect(tree.branches).toHaveLength(1);
    expect(tree.branches[0]?.templates).toEqual([
      expect.objectContaining({
        templateId: 'template-old',
        name: '测试1',
        templateRevision: 3,
        templateCreatedAt: createdAt.toISOString(),
      }),
      expect.objectContaining({
        templateId: 'template-new',
        name: '新品跑量模板',
        templateRevision: null,
        templateCreatedAt: '2026-09-27T08:00:00.000Z',
        fillRevision: null,
        packagingRevision: null,
        timelineVariantCount: 0,
      }),
    ]);
    expect(
      tree.branches[0]?.nodes.find((node) => node.nodeId === 'TEMPLATE_MIX')?.artifactCount,
    ).toBe(1);
  });

  it('includes a newly created template when a confirmed render clip exists without a batch artifact', async () => {
    const createdAt = new Date('2026-09-30T02:00:00.000Z');
    const repository = {
      listEffectRunBranches: vi.fn().mockResolvedValue([{
        id: 'root', activeKey: 'ACTIVE', parentWorkflowRunId: null, forkNodeId: null,
        forkTemplateId: null, branchLabel: null, currentNodeId: 'TEMPLATE_MIX',
        createdAt, updatedAt: createdAt,
        nodeStates: [{ state: { schemaVersion: 1, templates: [{
          id: 'template-new', createdAt: createdAt.toISOString(),
          workspace: { template: { name: '新模板' }, variants: [] },
        }] } }],
        workingArtifacts: [{
          nodeId: 'SEGMENT_RENDER', artifactKey: 'render-clip:clip-a',
          revision: 1, createdAt, freshness: 'CURRENT', name: '视频片段',
        }],
      }]),
    };
    const service = new WorkflowWorkingService(
      repository as never,
      { get: vi.fn().mockResolvedValue({ id: 'project-a' }) } as never,
      {} as never,
    );

    const tree = await service.getEffectBranchTree('project-a');

    expect(tree.branches[0]?.templates).toEqual([
      expect.objectContaining({
        templateId: 'template-new', name: '新模板', templateRevision: null,
        templateCreatedAt: createdAt.toISOString(),
      }),
    ]);
    expect(tree.branches[0]?.nodes.find((node) => node.nodeId === 'SEGMENT_RENDER')
      ?.artifactCount).toBe(1);
  });

  it('reveals a draft fill only after its completed AI output still exists in the draft', async () => {
    const createdAt = new Date('2026-09-28T01:00:00.000Z');
    const makeRun = (variantIds: string[], idempotencyKey = 'fill-new') => ({
      id: 'root',
      activeKey: 'ACTIVE',
      parentWorkflowRunId: null,
      forkNodeId: null,
      forkTemplateId: null,
      branchLabel: null,
      currentNodeId: 'TEMPLATE_MIX',
      createdAt,
      updatedAt: createdAt,
      nodeStates: [
        {
          state: {
            schemaVersion: 1,
            activeTemplateId: 'template-new',
            templates: [
              {
                id: 'template-new',
                workspace: {
                  template: { name: '新品跑量模板' },
                  variants: variantIds.map((id) => ({ id })),
                },
              },
            ],
          },
        },
      ],
      effectTemplateMixAiRuns: [
        { templateId: 'template-new', outputVariantId: 'variant-ai', idempotencyKey },
      ],
      workingArtifacts: [{
        nodeId: 'SEGMENT_RENDER', artifactKey: 'render-batch:product-a', revision: 1,
        createdAt, freshness: 'CURRENT', name: '已确认素材池',
      }],
    });
    const repository = {
      listEffectRunBranches: vi.fn().mockResolvedValue([makeRun(['variant-ai'])]),
    };
    const service = new WorkflowWorkingService(
      repository as never,
      { get: vi.fn().mockResolvedValue({ id: 'project-a' }) } as never,
      {} as never,
    );

    const filled = await service.getEffectBranchTree('project-a');
    expect(filled.branches[0]?.templates[0]).toMatchObject({
      templateRevision: null,
      templateCreatedAt: null,
      fillRevision: null,
      draftFillReady: true,
    });

    repository.listEffectRunBranches.mockResolvedValue([makeRun([])]);
    const cleared = await service.getEffectBranchTree('project-a');
    expect(cleared.branches[0]?.templates[0]?.draftFillReady).toBe(false);

    repository.listEffectRunBranches.mockResolvedValue([
      makeRun(['variant-ai'], 'inherit:child:mix:parent-fill'),
    ]);
    const inherited = await service.getEffectBranchTree('project-a');
    expect(inherited.branches[0]?.templates[0]?.draftFillReady).toBe(false);
  });

  it('keeps an early mix draft out of the version tree until render output is confirmed', async () => {
    const createdAt = new Date('2026-09-29T01:22:00.000Z');
    const repository = {
      listEffectRunBranches: vi.fn().mockResolvedValue([{
        id: 'root', activeKey: 'ACTIVE', parentWorkflowRunId: null, forkNodeId: null,
        forkTemplateId: null, branchLabel: null, currentNodeId: 'SEGMENT_RENDER',
        createdAt, updatedAt: createdAt,
        nodeStates: [{ state: { schemaVersion: 1, templates: [{
          id: 'template-new', createdAt: createdAt.toISOString(),
          workspace: { template: { name: '测试1' }, variants: [] },
        }] } }],
        workingArtifacts: [{
          nodeId: 'PROMPT_GENERATION', artifactKey: 'prompt-batch:product-a',
          revision: 2, createdAt, freshness: 'CURRENT', name: '版本02',
        }],
      }]),
    };
    const service = new WorkflowWorkingService(
      repository as never,
      { get: vi.fn().mockResolvedValue({ id: 'project-a' }) } as never,
      {} as never,
    );

    const tree = await service.getEffectBranchTree('project-a');
    expect(tree.branches[0]?.templates).toEqual([]);
  });

  it('preserves content revisions separately from packaging branch numbers and mixed product revisions', async () => {
    const createdAt = new Date('2026-09-28T01:00:00.000Z');
    const artifacts = [
      ['SOURCE_IMPORT', 'source-package:a', 1],
      ['SOURCE_IMPORT', 'source-package:b', 3],
      ['TEMPLATE_MIX', 'mix-template:template-a', 5],
      ['TEMPLATE_MIX', 'timeline-project:template-a:variant-a', 2],
      ['TEMPLATE_MIX', 'timeline-package:template-a:variant-a', 4],
    ] as const;
    const repository = {
      listEffectRunBranches: vi.fn().mockResolvedValue([
        {
          id: 'root',
          activeKey: 'ACTIVE',
          parentWorkflowRunId: null,
          forkNodeId: null,
          forkTemplateId: null,
          branchLabel: null,
          currentNodeId: 'TEMPLATE_MIX',
          createdAt,
          updatedAt: createdAt,
          effectTemplateMixAiRuns: [
            { templateId: 'template-a', outputVariantId: 'variant-a', idempotencyKey: 'fill-a' },
          ],
          effectPackagingRuns: [{ templateId: 'template-a', status: 'COMPLETED', idempotencyKey: 'own-package', completedAt: null }],
          workingArtifacts: artifacts.map(([nodeId, artifactKey, revision]) => ({
            nodeId,
            artifactKey,
            revision,
            createdAt,
            freshness: 'CURRENT',
            name: artifactKey,
          })),
        },
      ]),
    };
    const service = new WorkflowWorkingService(
      repository as never,
      { get: vi.fn().mockResolvedValue({ id: 'project-a' }) } as never,
      {} as never,
    );
    const tree = await service.getEffectBranchTree('project-a');
    expect(tree.branches[0]?.nodes[0]?.revision).toBeNull();
    expect(tree.branches[0]?.nodes[0]?.revisions).toEqual([1, 3]);
    expect(tree.branches[0]?.nodes[0]?.artifactCreatedAt).toBe(createdAt.toISOString());
    expect(tree.branches[0]?.templates[0]).toMatchObject({
      templateRevision: 5,
      templateRevisions: [5],
      fillRevision: 1,
      fillRevisions: [2],
      packagingRevision: 1,
      packagingRevisions: [4],
      fillCreatedAt: createdAt.toISOString(),
      packagingCreatedAt: createdAt.toISOString(),
    });
  });

  it('shows inherited templates except the template replaced by a scoped fork', async () => {
    const createdAt = new Date('2026-09-28T01:00:00.000Z');
    const artifact = (artifactKey: string) => ({
      nodeId: 'TEMPLATE_MIX',
      artifactKey,
      freshness: 'CURRENT',
      revision: 2,
      createdAt,
      name: artifactKey,
    });
    const base = {
      projectId: 'project-a',
      workflow: 'EFFECT',
      workflowSpace: 'EFFECT',
      status: 'ACTIVE',
      currentNodeId: 'TEMPLATE_MIX',
      createdAt,
      updatedAt: createdAt,
      lastActiveAt: createdAt,
      branchPublishedAt: createdAt,
    };
    const repository = {
      listEffectRunBranches: vi.fn().mockResolvedValue([
        {
          ...base,
          id: 'root',
          activeKey: null,
          parentWorkflowRunId: null,
          forkNodeId: null,
          forkTemplateId: null,
          branchLabel: null,
          effectTemplateMixAiRuns: [
            { templateId: 'template-b', outputVariantId: 'variant-1', idempotencyKey: 'fill-b' },
          ],
          effectPackagingRuns: [{ templateId: 'template-b', status: 'COMPLETED', idempotencyKey: 'own-package', completedAt: null }],
          workingArtifacts: [
            artifact('mix-template:template-a'),
            artifact('mix-template:template-b'),
            artifact('timeline-project:template-b:variant-1'),
            artifact('timeline-package:template-b:variant-1'),
            { ...artifact('final-delivery:template-b'), nodeId: 'FINAL_OUTPUT' },
          ],
        },
        {
          ...base,
          id: 'child',
          activeKey: 'ACTIVE',
          parentWorkflowRunId: 'root',
          forkNodeId: 'TEMPLATE_MIX',
          forkTemplateId: 'template-a',
          branchLabel: null,
          workingArtifacts: [artifact('mix-template:template-a')],
        },
      ]),
    };
    const service = new WorkflowWorkingService(
      repository as never,
      { get: vi.fn().mockResolvedValue({ id: 'project-a' }) } as never,
      {} as never,
    );

    const tree = await service.getEffectBranchTree('project-a');

    expect(tree.branches[1]?.templates.map((template) => template.templateId)).toEqual([
      'template-a',
      'template-b',
    ]);
    expect(tree.branches[1]?.nodes[4]?.artifactCount).toBe(4);
    expect(tree.branches[1]?.forkMixStage).toBe('TEMPLATE');
    expect(tree.branches[1]?.templates[0]).toMatchObject({
      templateRevision: 2,
      fillRevision: null,
      packagingRevision: null,
    });
    expect(tree.branches[1]?.templates[1]).toMatchObject({
      templateRevision: 2,
      fillRevision: 1,
      fillRevisions: [2],
      packagingRevision: 1,
      packagingRevisions: [2],
      deliveryRevision: 1,
      deliveryCount: 1,
      deliveryCreatedAt: createdAt.toISOString(),
    });
  });

  it('classifies a mix fork by what the branch changed, not by the copies it re-committed', async () => {
    const createdAt = new Date('2026-09-28T01:00:00.000Z');
    const template = { name: '测试1', slots: [] };
    const artifact = (artifactKey: string, payload?: unknown) => ({
      nodeId: 'TEMPLATE_MIX',
      artifactKey,
      freshness: 'CURRENT',
      revision: 1,
      createdAt,
      name: artifactKey,
      payload: payload ?? null,
    });
    const base = {
      projectId: 'project-a',
      workflow: 'EFFECT',
      workflowSpace: 'EFFECT',
      status: 'ACTIVE',
      currentNodeId: 'TEMPLATE_MIX',
      createdAt,
      updatedAt: createdAt,
      lastActiveAt: createdAt,
      activeKey: null,
      branchLabel: null,
      forkTemplateId: null,
      branchPublishedAt: createdAt,
    };
    const repository = {
      listEffectRunBranches: vi.fn().mockResolvedValue([
        {
          ...base,
          id: 'root',
          parentWorkflowRunId: null,
          forkNodeId: null,
          workingArtifacts: [artifact('mix-template:template-a', { template, workspaceVersion: 13 })],
        },
        {
          ...base,
          id: 'packaged',
          parentWorkflowRunId: 'root',
          forkNodeId: 'TEMPLATE_MIX',
          workingArtifacts: [
            artifact('mix-template:template-a', { template, workspaceVersion: 13 }),
            artifact('timeline-project:template-a:variant-1'),
            artifact('timeline-package:template-a:variant-1'),
          ],
        },
        {
          ...base,
          id: 'filled',
          parentWorkflowRunId: 'root',
          forkNodeId: 'TEMPLATE_MIX',
          workingArtifacts: [
            // A re-fill saves the draft first, so the workspace version it re-commits is one ahead
            // of its parent's even though the template itself is untouched.
            artifact('mix-template:template-a', { template, workspaceVersion: 14 }),
            artifact('timeline-project:template-a:variant-1'),
          ],
        },
        {
          ...base,
          id: 'retemplated',
          parentWorkflowRunId: 'root',
          forkNodeId: 'TEMPLATE_MIX',
          activeKey: 'ACTIVE',
          workingArtifacts: [
            artifact('mix-template:template-a', {
              template: { name: '测试1', slots: ['a'] },
              workspaceVersion: 14,
            }),
            artifact('timeline-project:template-a:variant-1'),
          ],
        },
      ]),
    };
    const service = new WorkflowWorkingService(
      repository as never,
      { get: vi.fn().mockResolvedValue({ id: 'project-a' }) } as never,
      {} as never,
    );

    const tree = await service.getEffectBranchTree('project-a');

    expect(tree.branches.map((branch) => branch.forkMixStage)).toEqual([
      null,
      'PACKAGING',
      'FILL',
      'TEMPLATE',
    ]);
  });

  it('numbers a re-filled mix layer along the branch chain instead of restarting at 01', async () => {
    const at = (minute: number) => new Date(`2026-09-29T01:${String(minute).padStart(2, '0')}:00.000Z`);
    const artifact = (artifactKey: string, createdAt: Date, revision = 1) => ({
      nodeId: 'TEMPLATE_MIX',
      artifactKey,
      freshness: 'CURRENT',
      revision,
      createdAt,
      name: artifactKey,
      payload: null,
    });
    const base = {
      projectId: 'project-a',
      workflow: 'EFFECT',
      workflowSpace: 'EFFECT',
      status: 'ACTIVE',
      currentNodeId: 'TEMPLATE_MIX',
      createdAt: at(0),
      updatedAt: at(0),
      lastActiveAt: at(0),
      activeKey: null,
      branchLabel: null,
      forkNodeId: 'TEMPLATE_MIX',
      forkTemplateId: null,
      branchPublishedAt: at(0),
    };
    // A fork never clones the mix layer, so every branch stores its own fill at revision 1. The tree
    // used to label both fills 版本01; it now numbers them by the fills along the chain. The middle
    // branch only re-packaged the timelines it inherited, so it is not a fill generation and must not
    // push the second real fill to 版本03.
    const fill = (minute: number) => artifact('timeline-project:template-a:variant-1', at(minute));
    const repository = {
      listEffectRunBranches: vi.fn().mockResolvedValue([
        {
          ...base,
          id: 'first',
          parentWorkflowRunId: null,
          forkNodeId: null,
          effectTemplateMixAiRuns: [
            { templateId: 'template-a', outputVariantId: 'variant-1', idempotencyKey: 'fill-a' },
          ],
          workingArtifacts: [artifact('mix-template:template-a', at(0)), fill(10)],
        },
        {
          ...base,
          id: 'packaged',
          parentWorkflowRunId: 'first',
          // The packaging fork carries the fills it inherited, marked so the tree does not read
          // them as a fill generation of this branch.
          effectTemplateMixAiRuns: [
            {
              templateId: 'template-a', outputVariantId: 'variant-1',
              idempotencyKey: 'inherit:packaged:mix:first-fill',
            },
          ],
          workingArtifacts: [
            artifact('mix-template:template-a', at(0)),
            fill(10),
            artifact('timeline-package:template-a:variant-1', at(20)),
          ],
        },
        {
          ...base,
          id: 'refilled',
          parentWorkflowRunId: 'packaged',
          activeKey: 'ACTIVE',
          effectTemplateMixAiRuns: [
            { templateId: 'template-a', outputVariantId: 'variant-1', idempotencyKey: 'fill-a' },
          ],
          workingArtifacts: [artifact('mix-template:template-a', at(0)), fill(30)],
        },
      ]),
    };
    const service = new WorkflowWorkingService(
      repository as never,
      { get: vi.fn().mockResolvedValue({ id: 'project-a' }) } as never,
      {} as never,
    );

    const tree = await service.getEffectBranchTree('project-a');

    expect(tree.branches.map((branch) => branch.forkMixStage)).toEqual([null, 'PACKAGING', 'FILL']);
    expect(tree.branches.map((branch) => branch.templates[0]?.fillRevision)).toEqual([1, 1, 2]);
  });

  it('restarts packaging versions under a new fill head without inheriting an old package', async () => {
    const at = (minute: number) => new Date(`2026-09-29T01:${String(minute).padStart(2, '0')}:00.000Z`);
    const artifact = (artifactKey: string, createdAt: Date, revision = 1) => ({
      nodeId: 'TEMPLATE_MIX',
      artifactKey,
      freshness: 'CURRENT',
      revision,
      createdAt,
      name: artifactKey,
      payload: null,
    });
    const base = {
      projectId: 'project-a',
      workflow: 'EFFECT',
      workflowSpace: 'EFFECT',
      status: 'ACTIVE',
      currentNodeId: 'TEMPLATE_MIX',
      createdAt: at(0),
      updatedAt: at(0),
      lastActiveAt: at(0),
      activeKey: null,
      branchLabel: null,
      forkNodeId: 'TEMPLATE_MIX',
      forkTemplateId: null,
      branchPublishedAt: at(0),
    };
    // Each fill head owns a separate set of packaging versions. A fresh fill has no package;
    // its first package must not count packages belonging to the previous fill.
    const fill = (minute: number) => artifact('timeline-project:template-a:variant-1', at(minute));
    const pack = (minute: number) => artifact('timeline-package:template-a:variant-1', at(minute));
    const repository = {
      listEffectRunBranches: vi.fn().mockResolvedValue([
        {
          ...base,
          id: 'first',
          parentWorkflowRunId: null,
          forkNodeId: null,
          effectTemplateMixAiRuns: [
            { templateId: 'template-a', outputVariantId: 'variant-1', idempotencyKey: 'fill-a' },
          ],
          workingArtifacts: [artifact('mix-template:template-a', at(0)), fill(10)],
        },
        {
          ...base,
          id: 'packaged',
          parentWorkflowRunId: 'first',
          effectPackagingRuns: [{ templateId: 'template-a', status: 'COMPLETED', idempotencyKey: 'own-package', completedAt: null }],
          workingArtifacts: [fill(10), pack(20)],
        },
        {
          ...base,
          id: 'refilled',
          parentWorkflowRunId: 'packaged',
          activeKey: 'ACTIVE',
          effectTemplateMixAiRuns: [
            { templateId: 'template-a', outputVariantId: 'variant-1', idempotencyKey: 'fill-a' },
          ],
          workingArtifacts: [fill(30)],
        },
        {
          ...base,
          id: 'repackaged',
          parentWorkflowRunId: 'refilled',
          effectPackagingRuns: [{ templateId: 'template-a', status: 'COMPLETED', idempotencyKey: 'own-package', completedAt: null }],
          workingArtifacts: [fill(30), pack(40)],
        },
      ]),
    };
    const service = new WorkflowWorkingService(
      repository as never,
      { get: vi.fn().mockResolvedValue({ id: 'project-a' }) } as never,
      {} as never,
    );

    const tree = await service.getEffectBranchTree('project-a');

    expect(tree.branches.map((branch) => branch.templates[0]?.packagingRevision)).toEqual([
      null, 1, null, 1,
    ]);
  });

  it('keeps an unpublished packaging child out of the tree without losing the branch under it', async () => {
    const at = (minute: number) => new Date(`2026-09-29T01:${String(minute).padStart(2, '0')}:00.000Z`);
    const artifact = (artifactKey: string, createdAt: Date, revision = 1) => ({
      nodeId: 'TEMPLATE_MIX',
      artifactKey,
      freshness: 'CURRENT',
      revision,
      createdAt,
      name: artifactKey,
      payload: null,
    });
    const base = {
      projectId: 'project-a',
      workflow: 'EFFECT',
      workflowSpace: 'EFFECT',
      status: 'ACTIVE',
      currentNodeId: 'TEMPLATE_MIX',
      createdAt: at(0),
      updatedAt: at(0),
      lastActiveAt: at(0),
      activeKey: null,
      branchLabel: null,
      forkNodeId: 'TEMPLATE_MIX',
      forkTemplateId: null,
    };
    // A packaging that only got some films out leaves its child unpublished and active, waiting for
    // the failed ones to be recovered. It must not show up as a version, and the branch the user
    // opens from there later has to hang off the packaging they can see rather than start a trunk.
    const fill = (minute: number) => artifact('timeline-project:template-a:variant-1', at(minute));
    const pack = (minute: number) => artifact('timeline-package:template-a:variant-1', at(minute));
    const repository = {
      listEffectRunBranches: vi.fn().mockResolvedValue([
        {
          ...base,
          id: 'first',
          parentWorkflowRunId: null,
          forkNodeId: null,
          branchPublishedAt: at(0),
          effectTemplateMixAiRuns: [
            { templateId: 'template-a', outputVariantId: 'variant-1', idempotencyKey: 'fill-a' },
          ],
          workingArtifacts: [artifact('mix-template:template-a', at(0)), fill(10)],
        },
        {
          ...base,
          id: 'packaged',
          parentWorkflowRunId: 'first',
          branchPublishedAt: at(0),
          effectTemplateMixAiRuns: [
            {
              templateId: 'template-a', outputVariantId: 'variant-1',
              idempotencyKey: 'inherit:packaged:mix:first-fill',
            },
          ],
          effectPackagingRuns: [{ templateId: 'template-a', status: 'COMPLETED', idempotencyKey: 'own-package', completedAt: null }],
          workingArtifacts: [fill(10), pack(20)],
        },
        {
          ...base,
          id: 'partial',
          parentWorkflowRunId: 'packaged',
          activeKey: 'ACTIVE',
          // Published by the rule that shipped before a partial batch stopped counting, so the
          // hidden check has to hold on its own rather than lean on the publish gate.
          branchPublishedAt: at(0),
          effectTemplateMixAiRuns: [
            {
              templateId: 'template-a', outputVariantId: 'variant-1',
              idempotencyKey: 'inherit:partial:mix:first-fill',
            },
          ],
          effectPackagingRuns: [{ templateId: 'template-a', status: 'PARTIAL' }],
          workingArtifacts: [fill(10), pack(30)],
        },
        {
          ...base,
          id: 'refilled',
          parentWorkflowRunId: 'partial',
          branchPublishedAt: at(0),
          effectTemplateMixAiRuns: [
            { templateId: 'template-a', outputVariantId: 'variant-1', idempotencyKey: 'fill-a' },
          ],
          workingArtifacts: [fill(40)],
        },
      ]),
    };
    const service = new WorkflowWorkingService(
      repository as never,
      { get: vi.fn().mockResolvedValue({ id: 'project-a' }) } as never,
      {} as never,
    );

    const tree = await service.getEffectBranchTree('project-a');

    expect(tree.branches.map((branch) => branch.workflowRunId)).toEqual([
      'first',
      'packaged',
      'refilled',
    ]);
    // The partial child is not a version. The new fill remains the second fill, but has no package.
    expect(tree.branches[2]?.parentWorkflowRunId).toBe('packaged');
    expect(tree.branches[2]?.templates[0]?.fillRevision).toBe(2);
    expect(tree.branches[2]?.templates[0]?.packagingRevision).toBeNull();
  });

  it('keeps a packaging fork that already has a whole batch in the tree', async () => {
    const createdAt = new Date('2026-09-29T01:00:00.000Z');
    const base = {
      projectId: 'project-a',
      workflow: 'EFFECT',
      workflowSpace: 'EFFECT',
      status: 'ACTIVE',
      currentNodeId: 'TEMPLATE_MIX',
      createdAt,
      updatedAt: createdAt,
      lastActiveAt: createdAt,
      activeKey: null,
      branchLabel: null,
      forkNodeId: 'TEMPLATE_MIX',
      forkTemplateId: null,
      branchPublishedAt: createdAt,
    };
    const artifact = (artifactKey: string) => ({
      nodeId: 'TEMPLATE_MIX',
      artifactKey,
      freshness: 'CURRENT',
      revision: 1,
      createdAt,
      name: artifactKey,
      payload: null,
    });
    const repository = {
      listEffectRunBranches: vi.fn().mockResolvedValue([
        { ...base, id: 'first', parentWorkflowRunId: null, forkNodeId: null, workingArtifacts: [] },
        {
          ...base,
          id: 'packaged',
          parentWorkflowRunId: 'first',
          activeKey: 'ACTIVE',
          // One template packaged whole, a second batch failed. The version the user did get must
          // not disappear from the tree while the failed one waits to be recovered.
          effectPackagingRuns: [
            { templateId: 'template-a', status: 'COMPLETED', idempotencyKey: 'own-package', completedAt: null },
            { templateId: 'template-b', status: 'PARTIAL' },
          ],
          workingArtifacts: [artifact('timeline-package:template-a:variant-1')],
        },
      ]),
    };
    const service = new WorkflowWorkingService(
      repository as never,
      { get: vi.fn().mockResolvedValue({ id: 'project-a' }) } as never,
      {} as never,
    );

    const tree = await service.getEffectBranchTree('project-a');

    expect(tree.branches.map((branch) => branch.workflowRunId)).toEqual(['first', 'packaged']);
    expect(tree.activeWorkflowRunId).toBe('packaged');
  });

  it('points the active branch at the last version the tree can draw', async () => {    const createdAt = new Date('2026-09-29T01:00:00.000Z');
    const base = {
      projectId: 'project-a',
      workflow: 'EFFECT',
      workflowSpace: 'EFFECT',
      status: 'ACTIVE',
      currentNodeId: 'TEMPLATE_MIX',
      createdAt,
      updatedAt: createdAt,
      lastActiveAt: createdAt,
      forkNodeId: 'TEMPLATE_MIX',
      forkTemplateId: null,
      branchLabel: null,
      workingArtifacts: [],
    };
    const repository = {
      listEffectRunBranches: vi.fn().mockResolvedValue([
        { ...base, id: 'root', parentWorkflowRunId: null, activeKey: null, forkNodeId: null },
        {
          ...base,
          id: 'published',
          parentWorkflowRunId: 'root',
          activeKey: null,
          branchPublishedAt: createdAt,
        },
        { ...base, id: 'partial', parentWorkflowRunId: 'published', activeKey: 'ACTIVE' },
      ]),
    };
    const service = new WorkflowWorkingService(
      repository as never,
      { get: vi.fn().mockResolvedValue({ id: 'project-a' }) } as never,
      {} as never,
    );

    const tree = await service.getEffectBranchTree('project-a');

    expect(tree.activeWorkflowRunId).toBe('published');
    expect(tree.branches.find((branch) => branch.isActive)?.workflowRunId).toBe('published');
  });

  it('keeps an inherited mix layer on its ancestor version instead of inventing a new one', async () => {
    const at = (minute: number) => new Date(`2026-09-29T01:${String(minute).padStart(2, '0')}:00.000Z`);
    const artifact = (artifactKey: string, createdAt: Date, revision = 1) => ({
      nodeId: 'TEMPLATE_MIX',
      artifactKey,
      freshness: 'CURRENT',
      revision,
      createdAt,
      name: artifactKey,
      payload: null,
    });
    const base = {
      projectId: 'project-a',
      workflow: 'EFFECT',
      workflowSpace: 'EFFECT',
      status: 'ACTIVE',
      currentNodeId: 'FINAL_OUTPUT',
      createdAt: at(0),
      updatedAt: at(0),
      lastActiveAt: at(0),
      activeKey: null,
      branchLabel: null,
      forkTemplateId: null,
      branchPublishedAt: at(0),
    };
    // An output fork clones the mix layer, so the copy keeps its ancestor's createdAt and the branch
    // must keep the ancestor's version rather than count the copy as another generation.
    const fill = (minute: number) => artifact('timeline-project:template-a:variant-1', at(minute));
    const repository = {
      listEffectRunBranches: vi.fn().mockResolvedValue([
        {
          ...base,
          id: 'filled',
          parentWorkflowRunId: null,
          forkNodeId: null,
          effectTemplateMixAiRuns: [
            { templateId: 'template-a', outputVariantId: 'variant-1', idempotencyKey: 'fill-a' },
          ],
          workingArtifacts: [artifact('mix-template:template-a', at(0)), fill(10)],
        },
        {
          ...base,
          id: 're-exported',
          parentWorkflowRunId: 'filled',
          forkNodeId: 'FINAL_OUTPUT',
          activeKey: 'ACTIVE',
          // The fork copies the fills that produced the pool it shows, and the copy is marked as
          // inherited: counting it would read the export as a fill generation of its own.
          effectTemplateMixAiRuns: [
            {
              templateId: 'template-a', outputVariantId: 'variant-1',
              idempotencyKey: 'inherit:re-exported:mix:filled-fill',
            },
          ],
          workingArtifacts: [
            artifact('mix-template:template-a', at(0)),
            fill(10),
            artifact('final-delivery:template-a', at(20)),
          ],
        },
      ]),
    };
    const service = new WorkflowWorkingService(
      repository as never,
      { get: vi.fn().mockResolvedValue({ id: 'project-a' }) } as never,
      {} as never,
    );

    const tree = await service.getEffectBranchTree('project-a');

    expect(tree.branches.map((branch) => branch.templates[0]?.fillRevision)).toEqual([1, 1]);
    expect(tree.branches.map((branch) => branch.templates[0]?.deliveryRevision)).toEqual([null, 1]);
  });

  it('keeps unrelated historical runs out of the active tree', async () => {
    const createdAt = new Date('2026-09-28T01:00:00.000Z');
    const run = (id: string, parentWorkflowRunId: string | null, activeKey: string | null) => ({
      id,
      projectId: 'project-a',
      workflow: 'EFFECT',
      workflowSpace: 'EFFECT',
      status: 'ACTIVE',
      activeKey,
      parentWorkflowRunId,
      forkNodeId: null,
      forkTemplateId: null,
      branchLabel: null,
      currentNodeId: 'SOURCE_IMPORT',
      createdAt,
      updatedAt: createdAt,
      lastActiveAt: createdAt,
      branchPublishedAt: createdAt,
      workingArtifacts:
        id === 'root'
          ? [
              {
                nodeId: 'SOURCE_IMPORT',
                artifactKey: 'source-package:a',
                freshness: 'CURRENT',
                createdAt,
              },
            ]
          : [],
    });
    const repository = {
      listEffectRunBranches: vi
        .fn()
        .mockResolvedValue([
          run('history', null, null),
          run('root', null, 'ACTIVE'),
          { ...run('child', 'root', null), forkNodeId: 'PROMPT_GENERATION' },
        ]),
    };
    const service = new WorkflowWorkingService(
      repository as never,
      { get: vi.fn().mockResolvedValue({ id: 'project-a' }) } as never,
      {} as never,
    );

    const tree = await service.getEffectBranchTree('project-a');
    expect(tree.activeWorkflowRunId).toBe('root');
    expect(tree.branches.map((branch) => branch.workflowRunId)).toEqual(['root', 'child']);
    expect(tree.branches[0]?.nodes[0]).toEqual({
      nodeId: 'SOURCE_IMPORT',
      status: 'CONFIRMED',
      artifactCount: 1,
      revision: null,
      revisions: [],
      artifactCreatedAt: createdAt.toISOString(),
    });
    expect(tree.branches[1]?.nodes[0]?.status).toBe('CONFIRMED');
  });
});

describe('WorkflowWorkingService effect manual branch copy', () => {
  const projects = { get: vi.fn().mockResolvedValue({ id: 'project-a' }) };

  it('namespaces the caller key so a repeated request cannot create a second branch', async () => {
    const repository = { createEffectManualBranch: vi.fn().mockResolvedValue(null) };
    const service = new WorkflowWorkingService(repository as never, projects as never, {} as never);

    await expect(service.createEffectManualBranch('project-a', 'run-a', ' key-1 ')).rejects.toThrow(
      '当前分支无法复制，请先保存或取消编辑',
    );
    expect(repository.createEffectManualBranch).toHaveBeenCalledWith(
      'project-a',
      'run-a',
      'manual:run-a:key-1',
    );
  });

  it('rejects an over-long idempotency key before touching the database', async () => {
    const repository = { createEffectManualBranch: vi.fn() };
    const service = new WorkflowWorkingService(repository as never, projects as never, {} as never);

    await expect(
      service.createEffectManualBranch('project-a', 'run-a', 'x'.repeat(200)),
    ).rejects.toThrow('幂等键过长');
    expect(repository.createEffectManualBranch).not.toHaveBeenCalled();
  });
});
