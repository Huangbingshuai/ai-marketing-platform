import type { EffectTemplateMixAiRun } from '@ai-marketing/contracts';

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
