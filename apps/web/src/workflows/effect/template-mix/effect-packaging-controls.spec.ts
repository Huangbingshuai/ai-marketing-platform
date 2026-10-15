import { computed, reactive, ref } from 'vue';
import { describe, expect, it, vi } from 'vitest';
import { transpileModule } from 'typescript';
import { PACKAGING_STAGES, PACKAGING_STAGE_LABELS } from '@ai-marketing/contracts';
import type { PackagingItem, PackagingRun } from '@ai-marketing/contracts';
import control from './EffectSinglePackagingControl.vue?raw';
import panel from './EffectTemplateMixPackaging.vue?raw';
import page from './EffectTemplateMixNodePage.vue?raw';
import timeline from './EffectTemplateMixTimeline.vue?raw';

function evaluate<T>(source: string, context: Record<string, unknown>, result: string): T {
  const factory = new Function(...Object.keys(context), `${transpileModule(source, {}).outputText}\nreturn ${result};`);
  return factory(...Object.values(context)) as T;
}
const item = (operation: PackagingItem['operation'], status: PackagingItem['status'], stage: PackagingItem['stage'] = 'VOICE') =>
  ({ id: 'item', workflowRunId: 'w', variantId: 'film', operation, status, stage, checkpoint: {} }) as PackagingItem;

function singleControl() {
  const props = reactive<{ item?: PackagingItem; submitting: boolean; disabled: boolean }>({ submitting: false, disabled: false });
  const source = `const active =${control.split('const active =')[1]!.split('</script>')[0]!}`;
  const state = evaluate<{ active: { value: boolean }; detail: { value: string }; progress: { value: number } }>(source,
    { props, computed, PACKAGING_STAGES, PACKAGING_STAGE_LABELS }, '{ active, detail, progress }');
  return { props, ...state };
}

describe('single packaging progress is not a batch item monitor', () => {
  it.each(['BATCH_PACKAGE', 'APPEND_PACKAGE', undefined] as const)('never shows %s item progress beside the single button', (operation) => {
    const h = singleControl();
    for (const status of ['QUEUED', 'RUNNING'] as const) {
      h.props.item = item(operation, status);
      h.props.disabled = true; // The film remains locked by its owning batch task.
      expect(h.active.value).toBe(false);
      expect(h.detail.value).toBe('');
    }
  });
  it('shows only the explicit single task, including READY before its transaction commits', () => {
    const h = singleControl();
    for (const status of ['QUEUED', 'RUNNING'] as const) {
      h.props.item = item('SINGLE_PACKAGE', status, 'READY');
      expect(h.active.value).toBe(true);
      expect(h.progress.value).toBeLessThan(100);
    }
    h.props.item = item('BATCH_PACKAGE', 'RUNNING');
    expect(h.active.value).toBe(false);
  });
  it.each(['COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED'] as const)('hides all single progress for terminal %s', (status) => {
    const h = singleControl();
    h.props.item = item('SINGLE_PACKAGE', status);
    expect(h.active.value).toBe(false);
    expect(h.detail.value).toBe('');
  });
  it('shows submitting immediately without reusing the previous batch stage', () => {
    const h = singleControl();
    h.props.item = item('BATCH_PACKAGE', 'RUNNING', 'MUSIC');
    h.props.submitting = true;
    expect(h.active.value).toBe(true);
    expect(h.progress.value).toBe(0);
    expect(h.detail.value).toBe('正在提交');
  });
});

describe('packaging item lock and track lock agree', () => {
  it('keeps the source editable during batch submission and locks only an explicit single target', () => {
    const context = { props: { projectId: 'p', workflowRunId: 'w' }, activeTemplateId: ref('t'),
      pendingPackagingVariantId: ref('') };
    const pending = evaluate<(template: string, run: string, variant?: string) => void>(
      `const pending =${page.split('const handlePackagingSubmissionPending =')[1]!.split('const handlePackagingSubmissionSettled')[0]!}`,
      context, 'pending');
    pending('other-template', 'w', 'film'); expect(context.pendingPackagingVariantId.value).toBe('');
    pending('t', 'other-run', 'film'); expect(context.pendingPackagingVariantId.value).toBe('');
    pending('t', 'w'); expect(context.pendingPackagingVariantId.value).toBe('');
    pending('t', 'w', 'film');
    expect(context.pendingPackagingVariantId.value).toBe('film');
  });
  it('keeps queued/running READY locked; terminal fallback and other films remain editable', () => {
    const pendingPackagingVariantId = ref('');
    const packagingResults = ref<PackagingItem[]>([item('BATCH_PACKAGE', 'RUNNING', 'READY')]);
    const locked = evaluate<(id: string) => boolean>(
      `const variantPackagingLocked =${page.split('const variantPackagingLocked =')[1]!.split('const packagingPreviewReadOnly')[0]!}`,
      { props: { workflowRunId: 'w' }, pendingPackagingVariantId, packagingResults }, 'variantPackagingLocked');
    expect(locked('film')).toBe(true);
    expect(locked('other')).toBe(false);
    packagingResults.value[0]!.status = 'QUEUED'; expect(locked('film')).toBe(true);
    packagingResults.value[0]!.workflowRunId = 'child'; expect(locked('film')).toBe(false);
    packagingResults.value[0]!.workflowRunId = 'w';
    for (const status of ['COMPLETED', 'FAILED', 'CANCELLED'] as const) {
      packagingResults.value[0]!.status = status; expect(locked('film')).toBe(false);
    }
    pendingPackagingVariantId.value = 'film'; expect(locked('film')).toBe(true);
  });
  it('passes the current item lock to the real track headers and cannot change a manual lock during packaging', () => {
    const binding = page.match(/:packaging-source-lock="([^"]+)"/)![1]!;
    const props = { packagingSourceLock: false, sourceUpdateLock: false };
    props.packagingSourceLock = evaluate<boolean>(`const lock = ${binding};`,
      { packagingSourceAutoLocked: false, selectedVariant: { id: 'film' }, variantPackagingLocked: () => true }, 'lock');
    const trackLocked = { VIDEO: false, CAPTION: true };
    const emit = vi.fn();
    const tracks = evaluate<{ trackIsLocked: (track: string) => boolean; toggleTrackLock: (track: string) => void }>(
      `const trackIsLocked =${timeline.split('const trackIsLocked =')[1]!.split('let resizeObserver')[0]!}`,
      { props, trackLocked, emit }, '{ trackIsLocked, toggleTrackLock }');
    expect(tracks.trackIsLocked('VIDEO')).toBe(true);
    tracks.toggleTrackLock('VIDEO');
    expect(trackLocked.VIDEO).toBe(false);
    expect(emit).toHaveBeenCalledWith('requestNotice', expect.stringContaining('包装'), 'warning');
    props.packagingSourceLock = false;
    expect(tracks.trackIsLocked('VIDEO')).toBe(false);
    expect(tracks.trackIsLocked('CAPTION')).toBe(true);
  });
});

describe('packaging task workspace handoff', () => {
  function handoff(previous: string[], target = { projectId: 'project', workflowRunId: 'child', templateId: 'template' }) {
    const task = { id: 'task', workflowRunId: 'child', templateId: 'template', operation: 'BATCH_PACKAGE',
      status: 'RUNNING', items: [item('BATCH_PACKAGE', 'RUNNING', 'READY')] } as PackagingRun;
    const context = {
      props: target, orderedRuns: computed(() => [task]), backgroundRun: ref(task), runs: ref<PackagingRun[]>([]),
      poller: { stop: vi.fn() }, backgroundReader: { invalidate: vi.fn() },
      backgroundTimer: undefined, requestError: ref(''), readUnavailable: ref(false), previewError: ref(''),
      busy: ref(false), starting: ref(false), startingVariantId: ref('old'), close: vi.fn(), sampleClock: { dispose: vi.fn() },
      refresh: vi.fn(), loadBackgroundRun: vi.fn(),
      watch: (_: unknown, callback: (scope: string[], previous: string[]) => void) => callback(Object.values(target), previous),
    };
    const source = panel.slice(panel.indexOf('watch(\n  () => [props.projectId, props.workflowRunId, props.templateId],'), panel.indexOf('onMounted(() =>'));
    evaluate(`let generation = 0; let pendingCreate = null; ${source}`, context, 'null');
    return { ...context, task };
  }
  it('carries the exact child task into the new scope before history responds', () => {
    const h = handoff(['project', 'parent', 'template']);
    expect(h.runs.value).toEqual([h.task]);
    expect(h.runs.value[0]!.items[0]!.status).toBe('RUNNING');
    expect(h.startingVariantId.value).toBe('');
    expect(h.refresh).toHaveBeenCalledOnce();
  });
  it.each([
    [['other-project', 'parent', 'template'], { projectId: 'project', workflowRunId: 'child', templateId: 'template' }],
    [['project', 'parent', 'template'], { projectId: 'project', workflowRunId: 'other-run', templateId: 'template' }],
    [['project', 'parent', 'template'], { projectId: 'project', workflowRunId: 'child', templateId: 'other-template' }],
  ] as const)('never carries a task into an unrelated scope %#', (previous, target) => {
    expect(handoff([...previous], target).runs.value).toEqual([]);
  });
  it('retains page item locks only for its installed task-workspace handoff', () => {
    const source = page.slice(page.indexOf('// Opening the first committed'), page.indexOf('packagingPreviewReadOnly.value = false;', page.indexOf('// Opening the first committed')));
    const context = { props: { projectId: 'p', workflowRunId: 'child' }, activeTemplateId: ref('t'),
      packagingTaskWorkspaceScope: 'p:child:t', packagingResults: ref([
        { ...item('BATCH_PACKAGE', 'RUNNING'), workflowRunId: 'child' },
        { ...item('BATCH_PACKAGE', 'RUNNING'), workflowRunId: 'other-run' },
      ]) };
    evaluate(source, context, 'null');
    expect(context.packagingResults.value).toHaveLength(1);
    context.props.workflowRunId = 'unrelated';
    evaluate(source, context, 'null');
    expect(context.packagingResults.value).toEqual([]);
  });
});
