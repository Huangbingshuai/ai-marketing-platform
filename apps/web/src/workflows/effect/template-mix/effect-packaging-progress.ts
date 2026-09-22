import { PACKAGING_STAGES } from '@ai-marketing/contracts';
import type { PackagingItem, PackagingRun } from '@ai-marketing/contracts';

export type PackagingStage = (typeof PACKAGING_STAGES)[number];
export const packagingStageDetails: Record<
  PackagingStage,
  { description: string; input: string; output: string }
> = {
  SNAPSHOT: {
    description: '冻结本次成片画面与已确认商品信息',
    input: '完整成片的镜头顺序、截取范围与已确认商品信息',
    output: '独立成片快照，固定本次使用的来源版本',
  },
  VISION: {
    description: '理解镜头内容、动作与画面节奏',
    input: '按时间轴生成的低清预览与关键帧',
    output: '对应时间段的画面描述，不推断新的商品事实',
  },
  SCRIPT: {
    description: '根据确认事实策划口播，仅做结构与时间校验',
    input: '画面描述、已确认商品事实与原始创意上下文',
    output: '带事实引用及时间安排的分句口播文案',
  },
  VOICE: {
    description: '逐句生成配音并校验实际时长',
    input: '校验通过的口播文案与可用时间范围',
    output: '逐句配音音频、实际时长及时间轴起点',
  },
  MUSIC: {
    description: '生成专属纯音乐并适配成片时长',
    input: '音乐风格描述与成片实际时长',
    output: '转存后的纯音乐，完成裁切或循环与音量设置',
  },
  CAPTIONS: {
    description: '按实际配音时长对齐字幕',
    input: '口播原文、真实配音起点与时长',
    output: '不越界、与配音同步的字幕草稿',
  },
  READY: {
    description: '保存可试听、可确认的包装草稿',
    input: '口播、配音、音乐与同步字幕',
    output: '全部成片就绪后，在节点底部统一提交并进入成片输出',
  },
};

export function packagingStageState(items: PackagingItem[], stage: PackagingStage) {
  const index = PACKAGING_STAGES.indexOf(stage);
  const completed = items.filter(
    (i) => i.status === 'COMPLETED' || PACKAGING_STAGES.indexOf(i.stage) > index,
  ).length;
  const failed = items.filter((i) => i.stage === stage && i.status === 'FAILED').length;
  const running = items.filter((i) => i.stage === stage && i.status === 'RUNNING').length;
  const cancelled = items.filter((i) => i.stage === stage && i.status === 'CANCELLED').length;
  const tone = failed
    ? 'danger'
    : running
      ? 'running'
      : items.length && completed === items.length
        ? 'success'
        : 'waiting';
  const label = failed
    ? '有失败'
    : running
      ? '执行中'
      : tone === 'success'
        ? '已完成'
        : cancelled
          ? '已取消'
          : completed
            ? '部分完成'
            : '等待中';
  return { completed, failed, running, cancelled, tone, label };
}

/** Mechanical phase completion only; never estimate model time or advance on a timer. */
export function packagingProgress(run?: PackagingRun) {
  if (!run?.items.length) return 0;
  const completed = run.items.reduce(
    (n, item) =>
      n +
      (item.status === 'COMPLETED'
        ? PACKAGING_STAGES.length
        : PACKAGING_STAGES.indexOf(item.stage)),
    0,
  );
  return Math.floor((completed / (run.items.length * PACKAGING_STAGES.length)) * 100);
}
