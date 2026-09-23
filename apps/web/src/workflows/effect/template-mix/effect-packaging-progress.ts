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
    input: '从各槽位原素材截取的低清代表帧；相同截取复用缓存',
    output: '各槽位独立的画面描述，不推断新的商品事实',
  },
  SCRIPT: {
    description: '根据确认事实策划口播，仅做结构与时间校验',
    input: '画面描述、已确认商品事实与原始创意上下文',
    output: '每槽位恰好一条完整口播，绑定事实引用和自身时间边界',
  },
  VOICE: {
    description: '受控并发生成槽位配音，超时仅同槽位缩句一次',
    input: '校验通过的口播文案与可用时间范围',
    output: '不跨素材的槽位配音、实际时长及时间轴起点',
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

/** API returns newest first. The graph and its summary must follow the same current run. */
export function currentPackagingRun(runs: PackagingRun[]) {
  return runs.find((run) => ['QUEUED', 'RUNNING'].includes(run.status)) ?? runs[0];
}

export function packagingItemStageState(item: PackagingItem, stage: PackagingStage) {
  const index = PACKAGING_STAGES.indexOf(stage);
  const itemIndex = PACKAGING_STAGES.indexOf(item.stage);
  if (item.status === 'COMPLETED' || itemIndex > index) return 'completed';
  if (itemIndex < index) {
    return ['FAILED', 'PARTIAL', 'CANCELLED'].includes(item.status) ? 'blocked' : 'waiting';
  }
  // `PARTIAL` is a run-level rollup the API never writes onto an item, but `PackagingStatus`
  // carries it, so it has to land somewhere: an item that did not reach COMPLETED reads as a
  // problem at its own stage rather than as still-waiting.
  return (
    { RUNNING: 'running', FAILED: 'failed', PARTIAL: 'failed', CANCELLED: 'cancelled', QUEUED: 'waiting' } as const
  )[item.status];
}

export const packagingItemStageLabels = {
  completed: '本阶段已完成', running: '本阶段执行中', failed: '本阶段失败',
  cancelled: '本阶段已取消', blocked: '前序未完成', waiting: '等待本阶段',
};

export function packagingStageState(items: PackagingItem[], stage: PackagingStage) {
  const counts = { completed: 0, failed: 0, running: 0, cancelled: 0, blocked: 0, waiting: 0 };
  for (const item of items) counts[packagingItemStageState(item, stage)]++;
  const { completed, failed, running, cancelled, blocked, waiting } = counts;
  const stale = items.filter((item) => item.stale).length;
  const tone = running ? 'running' : failed || stale ? 'danger'
    : items.length && completed === items.length ? 'success' : 'waiting';
  const label = running ? (failed ? `执行中 · ${failed} 条失败` : '执行中')
    : failed ? `${failed} 条失败` : stale ? '来源待更新'
      : tone === 'success' ? '已完成' : cancelled ? '已取消'
        : blocked && !waiting ? '前序受阻' : completed ? '部分完成' : '等待中';
  const summary = [
    running && `执行中 ${running}`, failed && `失败 ${failed}`,
    waiting && `等待 ${waiting}`, blocked && `前序受阻 ${blocked}`,
    cancelled && `取消 ${cancelled}`, stale && `来源待更新 ${stale}`,
  ].filter(Boolean).join(' · ');
  return { ...counts, stale, tone, label, summary };
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
