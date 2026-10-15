import { describe, expect, it } from 'vitest';
import { computed, reactive, ref } from 'vue';
import { transpileModule } from 'typescript';
import type { EffectTemplateMixAiRun, PackagingRun } from '@ai-marketing/contracts';
import page from './EffectTemplateMixNodePage.vue?raw';
import {
  mixAppendProgress,
  mixLocalUpdateProgress,
  createMixLocalUpdateProgressTracker,
} from './effect-template-mix-operation-progress';

const run = (
  status: EffectTemplateMixAiRun['status'],
  operation: EffectTemplateMixAiRun['operation'] = 'APPEND',
) => ({ status, operation, stage: 'TRIMMING', progress: 68 }) as EffectTemplateMixAiRun;

describe('one confirmed local operation spans source updates and append', () => {
  it.each([true, false])(
    'restores a completed append handoff without falling back to 50%% (packaging=%s)',
    (packageNewVariants) => {
      expect(
        mixLocalUpdateProgress({
          source: null,
          append: null,
          hasAdditions: true,
          handoff: true,
          appendCompleted: true,
          packageNewVariants,
        })?.progress,
      ).toBe(packageNewVariants ? 80 : 99);
    },
  );
  it('prefers accepted automatic packaging over a stale source or append projection', () => {
    expect(
      mixLocalUpdateProgress({
        source: { progress: 40, detail: '旧读取' },
        append: { progress: 30, detail: '旧追加' },
        hasAdditions: true,
        handoff: true,
        packaging: {
          operation: 'APPEND_PACKAGE',
          status: 'RUNNING',
          execution: { progressPercent: 50 },
          counts: { completed: 2, total: 6 },
          items: [],
        } as unknown as PackagingRun,
      })?.progress,
    ).toBe(90);
  });
  it('retains real observed progress across handoff, lower retry results and changing stages', () => {
    const track = createMixLocalUpdateProgressTracker();
    expect(
      [50, 74, 80, 50, 90, 82, 97].map(
        (progress) =>
          track('project/run/template', 'operation', { progress, detail: `stage ${progress}` })
            ?.progress,
      ),
    ).toEqual([50, 74, 80, 80, 90, 90, 97]);
    expect(
      track('project/run/template', undefined, { progress: 80, detail: '自动重试中' }),
    ).toEqual({ progress: 97, detail: '自动重试中' });
  });
  it('isolates projects, Runs, templates and new operations without borrowing a previous percentage', () => {
    const track = createMixLocalUpdateProgressTracker();
    track('project/run/template', 'first', { progress: 95, detail: '' });
    for (const scope of ['other/run/template', 'project/other/template', 'project/run/other'])
      expect(track(scope, 'first', { progress: 5, detail: '' })?.progress).toBe(5);
    expect(track('project/run/template', 'first', { progress: 20, detail: '' })?.progress).toBe(95);
    expect(track('project/run/template', 'second', { progress: 0, detail: '' })?.progress).toBe(0);
    track('project/run/template', 'second', { progress: 80, detail: '' });
    expect(track('project/run/template', undefined, null)).toBeNull();
    expect(track('project/run/template', undefined, { progress: 0, detail: '' })?.progress).toBe(0);
  });
  it('restores only the current template and Run automatic packaging task', () => {
    const props = reactive({ workflowRunId: 'run' });
    const activeTemplateId = ref('template');
    const appendPackagingRun = ref({
      workflowRunId: 'run',
      templateId: 'template',
      operation: 'APPEND_PACKAGE',
      status: 'RUNNING',
    });
    const source = page.slice(
      page.indexOf('const activeAppendPackaging ='),
      page.indexOf('const packagingResults ='),
    );
    const state = new Function(
      'computed',
      'props',
      'activeTemplateId',
      'appendPackagingRun',
      `${transpileModule(source, {}).outputText}\nreturn activeAppendPackaging;`,
    )(computed, props, activeTemplateId, appendPackagingRun);
    expect(state.value).toBe(appendPackagingRun.value);
    props.workflowRunId = 'sibling';
    expect(state.value).toBeNull();
    props.workflowRunId = 'run';
    activeTemplateId.value = 'other';
    expect(state.value).toBeNull();
    activeTemplateId.value = 'template';
    expect(state.value).toBe(appendPackagingRun.value);
    for (const status of ['COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED']) {
      appendPackagingRun.value.status = status;
      expect(state.value).toBeNull();
    }
    appendPackagingRun.value.status = 'RUNNING';
    appendPackagingRun.value.operation = 'SINGLE_PACKAGE';
    expect(state.value).toBeNull();
  });
  it('reserves the last stage for automatic packaging instead of finishing at append', () => {
    const input = {
      source: null,
      hasAdditions: true,
      handoff: false,
      append: { progress: 100, detail: '保存新增成片' },
      packageNewVariants: true,
    };
    expect(mixLocalUpdateProgress(input)?.progress).toBe(80);
    expect(mixLocalUpdateProgress({ ...input, hasAdditions: false })?.progress).toBe(80);
    const packaging = {
      operation: 'APPEND_PACKAGE',
      status: 'RUNNING',
      items: [{ status: 'RUNNING', stage: 'VOICE', checkpoint: {} }],
      counts: { completed: 2, total: 6 },
      execution: { progressPercent: 50 },
    } as PackagingRun;
    const progress = mixLocalUpdateProgress({ ...input, append: null, packaging });
    expect(progress?.progress).toBe(90);
    expect(progress?.detail).toContain('正在包装新增成片');
    expect(progress?.detail).toContain('生成配音');
    expect(progress?.detail).toContain('已完成 2/6');
    packaging.execution!.progressPercent = 100;
    expect(mixLocalUpdateProgress({ ...input, append: null, packaging })?.progress).toBe(99);
    for (const status of ['COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED'] as const) {
      packaging.status = status;
      expect(mixLocalUpdateProgress({ ...input, append: null, packaging })).toBeNull();
    }
  });
  it('does not borrow progress from manual batch or single packaging', () => {
    for (const operation of ['BATCH_PACKAGE', 'SINGLE_PACKAGE'] as const)
      expect(
        mixLocalUpdateProgress({
          source: null,
          hasAdditions: false,
          handoff: false,
          append: null,
          packaging: { operation, status: 'RUNNING' } as PackagingRun,
        }),
      ).toBeNull();
  });
  it('does not finish or reset to zero at the append handoff', () => {
    const input = {
      source: { progress: 100, detail: '正在更新工程' },
      hasAdditions: true,
      handoff: true,
      append: null as { progress: number; detail: string } | null,
    };
    expect(mixLocalUpdateProgress(input)?.progress).toBe(50);
    expect(mixLocalUpdateProgress({ ...input, source: null })?.progress).toBe(50);
    expect(
      mixLocalUpdateProgress({ ...input, source: null, append: { progress: 0, detail: '排队' } })
        ?.progress,
    ).toBe(50);
    expect(
      mixLocalUpdateProgress({ ...input, source: null, append: { progress: 68, detail: '截取' } }),
    ).toEqual({ progress: 84, detail: '截取' });
    expect(
      mixLocalUpdateProgress({ ...input, source: null, append: { progress: 100, detail: '保存' } })
        ?.progress,
    ).toBe(99);
  });
  it('keeps standalone phases and clears a finished operation', () => {
    expect(
      mixLocalUpdateProgress({
        source: { progress: 68, detail: '更新' },
        hasAdditions: false,
        handoff: false,
        append: null,
      })?.progress,
    ).toBe(68);
    expect(
      mixLocalUpdateProgress({
        source: null,
        hasAdditions: false,
        handoff: false,
        append: { progress: 68, detail: '追加' },
      })?.progress,
    ).toBe(68);
    expect(
      mixLocalUpdateProgress({ source: null, hasAdditions: true, handoff: false, append: null }),
    ).toBeNull();
  });
});

describe('append uses existing partial-update progress separately from full fill', () => {
  it('does not describe an unclaimed queue item as a running model', () => {
    expect(mixAppendProgress(run('QUEUED'))).toEqual({
      progress: 0,
      summary: '局部更新',
      detail: '排队等待执行',
    });
  });
  it('uses real progress after claim and does not display a workflow link', () => {
    expect(mixAppendProgress(run('RUNNING'))).toEqual({
      progress: 68,
      summary: '局部更新',
      detail: '正在选择镜头截取区间',
    });
    const markup = page.split('v-if="localUpdateProgress"')[1]!.split('/>')[0]!;
    expect(markup).toContain('summary="局部更新"');
    expect(markup).toContain('tone="update"');
    expect(markup).toContain(':attempt-label="localUpdateProgress.detail"');
    expect(markup).toContain('action-label=""');
    expect(markup).not.toContain('<button');
    expect(markup).not.toContain('@click="cancelAppend"');
    expect(markup).not.toContain('show-details');
    expect(markup).not.toContain('铺入');
  });
  it.each([
    ['CLASSIFYING', '正在归槽新增素材'],
    ['MATCHING', '正在组合新增成片'],
    ['SAMPLING', '正在抽取候选画面'],
    ['TRIMMING', '正在选择镜头截取区间'],
    ['COMPLETED', '正在保存新增成片'],
  ] as const)('tracks actual %s checkpoints independently of the percentage', (stage, label) => {
    const current = {
      ...run('RUNNING'),
      stage,
      progress: 78,
      stageDetails: { [stage]: { completed: 2, total: 4 } },
    } as EffectTemplateMixAiRun;
    const count = {
      CLASSIFYING: '已归槽 2/4 条新增素材',
      SAMPLING: '已抽帧 2/4 条素材',
      TRIMMING: '已处理 2/4 个镜头',
    };
    const unit = count[stage as keyof typeof count];
    expect(mixAppendProgress(current)?.detail).toBe(label + (unit ? ` · ${unit}` : ''));
  });
  it('describes new-material classification separately from overall completion', () => {
    const current = {
      ...run('RUNNING'),
      stage: 'CLASSIFYING',
      progress: 10,
      stageDetails: { CLASSIFYING: { completed: 1, total: 2 } },
    } as EffectTemplateMixAiRun;
    expect(mixAppendProgress(current)).toEqual({
      progress: 10,
      summary: '局部更新',
      detail: '正在归槽新增素材 · 已归槽 1/2 条新增素材',
    });
    current.stageDetails!.CLASSIFYING!.completed = 0;
    expect(mixAppendProgress(current)?.detail).toContain('已归槽 0/2');
    current.stageDetails!.CLASSIFYING!.total = 0;
    expect(mixAppendProgress(current)?.detail).toBe('正在归槽新增素材');
  });
  it('identifies trim work as film shots rather than source-material count', () => {
    const current = {
      ...run('RUNNING'),
      stage: 'TRIMMING',
      progress: 58,
      stageDetails: { TRIMMING: { completed: 11, total: 144 } },
    } as EffectTemplateMixAiRun;
    expect(mixAppendProgress(current)?.detail).toBe('正在选择镜头截取区间 · 已处理 11/144 个镜头');
    expect(mixAppendProgress(current)?.progress).toBe(58);
  });
  it('has exactly one fixed-name update button and one local-update progress for combined changes', () => {
    expect(page.match(/class="button source-update-button"/g)).toHaveLength(1);
    expect(page).toContain('@click="updateCurrentTemplate"');
    expect(page).not.toContain('@click="appendNewMaterials"');
    expect(page).not.toContain('@click="updateSourceProjects"');
    expect(page.match(/summary="局部更新"/g)).toHaveLength(1);
    expect(page).not.toContain('局部更新（');
    expect(page).not.toContain('局部更新中…');
  });
  it.each(['COMPLETED', 'FAILED', 'CANCELLED'] as const)(
    'hides terminated append progress (%s)',
    (status) => {
      expect(mixAppendProgress(run(status))).toBeNull();
    },
  );
  it('does not take over normal smart-fill status', () => {
    expect(mixAppendProgress(run('RUNNING', 'FILL'))).toBeNull();
    expect(page).toContain("activeAiRun.value?.operation !== 'APPEND'");
    expect(page).toContain("displayedAiRun.value?.operation !== 'APPEND'");
    expect(page).toContain("{{ fillStartPending ? '正在提交…' : activeFillRun ? '智能填充中…'");
    expect(page).toContain('v-if="displayedFillRun || fillStartPending"');
    expect(page).toContain('fillStartPending.value = !appendNewMaterials;');
  });
});
