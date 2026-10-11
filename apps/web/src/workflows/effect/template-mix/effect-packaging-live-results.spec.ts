import { describe, expect, it } from 'vitest';
import { packagingVisualTimeline } from '@ai-marketing/contracts';
import type { EffectTemplateMixVariant, PackagingItem, PackagingRun } from '@ai-marketing/contracts';
import { livePackagingItem } from './effect-packaging-progress';
import component from './EffectTemplateMixPackaging.vue?raw';
import page from './EffectTemplateMixNodePage.vue?raw';

const variant = { id: 'film', slots: [{ id: 'hook', label: '钩子', duration: 6 }],
  bindings: { hook: 'material' }, bindingRevisions: { hook: 2 }, offsets: { hook: 1 } } as unknown as EffectTemplateMixVariant;
const item = { id: 'package', runId: 'child-task', variantId: variant.id, status: 'COMPLETED',
  sourceVisualTimeline: packagingVisualTimeline(variant), checkpoint: { voices: {}, captions: [] },
  name: '成片1', shardIndex: 0, sourceTimelineHash: 'hash', stage: 'READY', errorMessage: null,
  startedAt: null, completedAt: null, updatedAt: '2026-10-11T00:00:00Z' } satisfies PackagingItem;
const task = { id: 'child-task', status: 'RUNNING', items: [item], templateId: 'template', workflowRunId: 'child',
  createdAt: '2026-10-11T00:00:00Z', startedAt: null, completedAt: null,
  counts: { total: 1, completed: 1, failed: 0, shards: 1 } } satisfies PackagingRun;

describe('live completed packaging results', () => {
  it('previews a persisted completed film while siblings are still running or failed', () => {
    for (const status of ['RUNNING', 'PARTIAL', 'COMPLETED'] as const)
      expect(livePackagingItem({ ...task, status }, variant)).toBe(item);
    expect(component).toContain('livePackagingItem(backgroundRun.value, variant)');
    expect(component).toContain("emit('results', [...latest.values()])");
    expect(page.includes('class="packaging-badge"')).toBe(false);
    expect(page).toContain('packagingResultByVariant.get(variant.id)?.status,');
  });
  it('never previews unfinished checkpoints or matches another identity', () => {
    for (const status of ['QUEUED', 'RUNNING', 'FAILED', 'CANCELLED'] as const)
      expect(livePackagingItem({ ...task, items: [{ ...item, status }] }, variant)).toBeNull();
    expect(livePackagingItem(task, { ...variant, id: 'other' })).toBeNull();
    expect(livePackagingItem(null, variant)).toBeNull();
    expect(livePackagingItem(task)).toBeNull();
  });
  it('does not mix a frozen package with newer trims, bindings or material revisions', () => {
    for (const change of [{ offsets: { hook: 2 } }, { bindings: { hook: 'other' } },
      { bindingRevisions: { hook: 3 } }, { slots: [{ ...variant.slots[0]!, duration: 5 }] }])
      expect(livePackagingItem(task, { ...variant, ...change })).toBeNull();
  });
  it('ignores only object key order and editor metadata, without altering either source', () => {
    const frozen = { ...item.sourceVisualTimeline };
    const reordered = Object.fromEntries(Object.entries(frozen).reverse()) as typeof frozen;
    expect(livePackagingItem({ ...task, items: [{ ...item, sourceVisualTimeline: reordered }] },
      { ...variant, name: '编辑器改名' })).not.toBeNull();
    expect(item.sourceVisualTimeline).toEqual(frozen);
  });
  it('keeps live child results read-only and scope resets in the existing guarded polling chain', () => {
    expect(component).toContain('background.workflowRunId !== props.workflowRunId');
    expect(component).toContain('if (version !== generation) return;');
    expect(component).toContain('backgroundRun.value = null;');
    expect(page).toContain('@preview-read-only="packagingPreviewReadOnly = $event"');
    expect(page).toContain('selectedSourceUpdateLocked.value || packagingPreviewReadOnly.value');
    expect(page).toContain('if (packagingPreviewReadOnly.value) {');
    expect(component).toContain('const live = backgroundRun.value?.items.find((item) => item.variantId === entry.variant.id)');
    expect(page.includes('本次包装失败 · 保留原结果')).toBe(false);
    expect(page).toContain('@results="handlePackagingResults"');
    expect(component).not.toContain("await requestJson(`${base.value}/packaging-runs/${runId}/retry`");
  });
});
