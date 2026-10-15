import { PACKAGING_STAGE_LABELS } from '@ai-marketing/contracts';
import type { EffectTemplateMixAiRun, PackagingRun } from '@ai-marketing/contracts';
import { packagingProgress } from './effect-packaging-progress';

type UpdateProgress = { progress: number; detail: string };

/** Retain only percentages actually reported by this operation, never timer estimates. */
export const createMixLocalUpdateProgressTracker = () => {
  const observed = new Map<string, { operationId: string | undefined; progress: number }>();
  return (scope: string, operationId: string | undefined, value: UpdateProgress | null) => {
    if (!value) {
      observed.delete(scope);
      return null;
    }
    const previous = observed.get(scope);
    const sameOperation = !operationId || previous?.operationId === operationId;
    const progress = Math.min(
      99,
      Math.max(0, value.progress, sameOperation ? (previous?.progress ?? 0) : 0),
    );
    observed.set(scope, { operationId: operationId ?? previous?.operationId, progress });
    return { ...value, progress };
  };
};

export const hasPendingMixContinuation = (run: EffectTemplateMixAiRun): boolean =>
  run.operation === 'APPEND' &&
  run.status === 'COMPLETED' &&
  [
    'APPEND_CONTINUATION_PENDING',
    'APPEND_CONTINUATION_RETRY_1',
    'APPEND_CONTINUATION_RETRY_2',
  ].includes(run.errorCode ?? '');

/** All durable phases share one operation; reaching a handoff is not completion. */
export const mixLocalUpdateProgress = (input: {
  source: UpdateProgress | null;
  hasAdditions: boolean;
  handoff: boolean;
  appendCompleted?: boolean;
  append: UpdateProgress | null;
  packageNewVariants?: boolean;
  packaging?: PackagingRun | null;
}): UpdateProgress | null => {
  if (
    input.packaging?.operation === 'APPEND_PACKAGE' &&
    ['QUEUED', 'RUNNING'].includes(input.packaging.status)
  ) {
    const run = input.packaging;
    const item = run.items.find((item) => item.status === 'RUNNING');
    const stage = item
      ? PACKAGING_STAGE_LABELS[item.stage]
      : run.status === 'QUEUED' || run.items.some((item) => item.status === 'QUEUED')
        ? '排队等待执行'
        : '正在同步结果';
    const waiting = run.items.some((item) =>
      [
        item.checkpoint.recovery?.waitingUntil,
        ...Object.values(item.checkpoint.voiceRecovery ?? {}).map((state) => state.waitingUntil),
      ].some((until) => until && Date.parse(until) > Date.now()),
    );
    return {
      progress: Math.min(99, 80 + (run.execution?.progressPercent ?? packagingProgress(run)) * 0.2),
      detail: `正在包装新增成片 · ${stage} · 已完成 ${run.counts.completed}/${run.counts.total}${waiting ? ' · 自动重试中' : ''}`,
    };
  }
  if (input.appendCompleted && input.handoff)
    return {
      progress: input.packageNewVariants ? 80 : 99,
      detail: '正在衔接新增成片并同步更新结果',
    };
  if (input.source)
    return {
      ...input.source,
      progress: Math.min(99, input.source.progress * (input.hasAdditions ? 0.5 : 1)),
    };
  if (input.append)
    return {
      ...input.append,
      progress: Math.min(
        99,
        (input.hasAdditions ? 50 : 0) +
          input.append.progress *
            (input.packageNewVariants
              ? input.hasAdditions
                ? 0.3
                : 0.8
              : input.hasAdditions
                ? 0.5
                : 1),
      ),
    };
  return input.handoff
    ? { progress: input.hasAdditions ? 50 : 99, detail: '正在衔接新增成片并同步更新结果' }
    : null;
};

export const mixAppendProgress = (run: EffectTemplateMixAiRun | null) => {
  if (!run || run.operation !== 'APPEND' || !['QUEUED', 'RUNNING'].includes(run.status))
    return null;
  const labels = {
    CLASSIFYING: '正在归槽新增素材',
    MATCHING: '正在组合新增成片',
    SAMPLING: '正在抽取候选画面',
    TRIMMING: '正在选择镜头截取区间',
    COMPLETED: '正在保存新增成片',
  };
  const detail = run.stageDetails?.[run.stage];
  const countLabels = {
    CLASSIFYING: { action: '已归槽', unit: '条新增素材' },
    SAMPLING: { action: '已抽帧', unit: '条素材' },
    TRIMMING: { action: '已处理', unit: '个镜头' },
  };
  const countLabel = countLabels[run.stage as keyof typeof countLabels];
  return {
    progress: run.status === 'QUEUED' ? 0 : run.progress,
    summary: '局部更新',
    detail:
      run.status === 'QUEUED'
        ? '排队等待执行'
        : `${labels[run.stage]}${
            countLabel && detail && detail.total > 0
              ? ` · ${countLabel.action} ${detail.completed}/${detail.total} ${countLabel.unit}`
              : ''
          }`,
  };
};
