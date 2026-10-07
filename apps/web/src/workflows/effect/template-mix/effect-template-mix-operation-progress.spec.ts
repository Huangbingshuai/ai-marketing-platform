import { describe, expect, it } from 'vitest';
import type { EffectTemplateMixAiRun } from '@ai-marketing/contracts';
import page from './EffectTemplateMixNodePage.vue?raw';
import { mixAppendProgress } from './effect-template-mix-operation-progress';

const run = (
  status: EffectTemplateMixAiRun['status'],
  operation: EffectTemplateMixAiRun['operation'] = 'APPEND',
) => ({ status, operation, stage: 'TRIMMING', progress: 68 }) as EffectTemplateMixAiRun;

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
    expect(page).toContain("{{ activeFillRun ? '智能填充中…'");
    expect(page).toContain('v-if="displayedFillRun"');
    expect(page).toContain('fillStartPending.value = !appendNewMaterials;');
  });
});
