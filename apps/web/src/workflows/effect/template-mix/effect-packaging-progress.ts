import { PACKAGING_STAGES } from '@ai-marketing/contracts';
import type { PackagingItem, PackagingRun } from '@ai-marketing/contracts';

export type PackagingStage = (typeof PACKAGING_STAGES)[number];

const MAX_STAGE_SAMPLES = 4;
const sampleText = (value: string, maxLength = 140) => {
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
};

/** Build concise, user-facing examples only from persisted packaging inputs/checkpoints. */
export function packagingStageSamples(items: PackagingItem[], stage: PackagingStage) {
  const inputSamples: string[] = [];
  const outputSamples: string[] = [];
  const append = (target: string[], item: PackagingItem, text: string) => {
    if (!text || target.length >= MAX_STAGE_SAMPLES) return;
    target.push(`${item.name} · ${sampleText(text)}`);
  };

  for (const item of items) {
    if (item.stale) continue;
    const checkpoint = item.checkpoint;
    const slotLabel = (slotId?: string) =>
      item.sourceVisualTimeline.slots.find((slot) => slot.id === slotId)?.label ?? '镜头';
    const vision = checkpoint.vision ?? [];
    const script = checkpoint.script ?? [];
    const captions = checkpoint.captions ?? [];

    switch (stage) {
      case 'SNAPSHOT': {
        const boundSlots = item.sourceVisualTimeline.slots.filter(
          (slot) => item.sourceVisualTimeline.bindings[slot.id],
        );
        append(inputSamples, item, `画面时间轴包含 ${boundSlots.length} 个已绑定镜头`);
        append(outputSamples, item, `已冻结 ${item.sourceVisualTimeline.slots.length} 个镜头的时间轴`);
        break;
      }
      case 'VISION': {
        const clips = item.sourceVisualTimeline.slots.filter(
          (slot) => item.sourceVisualTimeline.bindings[slot.id],
        );
        for (const slot of clips) append(inputSamples, item, `${slot.label} · ${slot.duration} 秒画面`);
        for (const result of vision) append(outputSamples, item, `${slotLabel(result.slotId)}：${result.description}`);
        break;
      }
      case 'SCRIPT': {
        for (const result of vision) append(inputSamples, item, `${slotLabel(result.slotId)}：${result.description}`);
        for (const line of script) append(outputSamples, item, `${slotLabel(line.slotId)}：${line.text}`);
        break;
      }
      case 'VOICE': {
        for (const line of script) append(inputSamples, item, `${slotLabel(line.slotId)}：${line.text}`);
        for (const line of script) {
          const audio = checkpoint.voices?.[line.id];
          if (audio) append(outputSamples, item, `${slotLabel(line.slotId)} · 配音 ${audio.duration.toFixed(1)} 秒`);
        }
        break;
      }
      case 'MUSIC': {
        if (checkpoint.musicBrief) append(inputSamples, item, checkpoint.musicBrief);
        else if (item.sourceVisualTimeline.slots.length) {
          append(inputSamples, item, `按成片画面与总时长 ${item.sourceVisualTimeline.slots.reduce((sum, slot) => sum + slot.duration, 0).toFixed(1)} 秒生成配乐`);
        }
        if (checkpoint.music) append(outputSamples, item, `纯音乐已生成 · ${checkpoint.music.duration.toFixed(1)} 秒`);
        break;
      }
      case 'CAPTIONS': {
        for (const line of script) {
          const audio = checkpoint.voices?.[line.id];
          if (audio) append(inputSamples, item, `${line.text} · 配音 ${audio.duration.toFixed(1)} 秒`);
        }
        for (const caption of captions) append(outputSamples, item, `${caption.text} · ${caption.start.toFixed(1)}–${caption.end.toFixed(1)} 秒`);
        break;
      }
      case 'READY': {
        if (script.length) append(inputSamples, item, `${script.length} 条口播${checkpoint.music ? ' · 纯音乐已就绪' : ''} · ${captions.length} 条字幕`);
        if (item.status === 'COMPLETED') append(outputSamples, item, '包装草稿已就绪，可试听和检查');
        break;
      }
    }

    if (inputSamples.length >= MAX_STAGE_SAMPLES && outputSamples.length >= MAX_STAGE_SAMPLES) break;
  }

  return { inputSamples, outputSamples };
}

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
