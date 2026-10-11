import { PACKAGING_STAGES, packagingVisualTimeline } from '@ai-marketing/contracts';
import type { EffectTemplateMixVariant, PackagingItem, PackagingRun } from '@ai-marketing/contracts';

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
  const audioPreviews: Array<{ label: string; fileObjectId: string }> = [];
  const append = (target: string[], item: PackagingItem, text: string) => {
    if (!text || target.length >= MAX_STAGE_SAMPLES) return;
    target.push(`${item.name} · ${sampleText(text)}`);
  };

  for (const item of items) {
    const checkpoint = item.checkpoint;
    const slotLabel = (slotId?: string) =>
      item.sourceVisualTimeline.slots.find((slot) => slot.id === slotId)?.label ?? '镜头';
    const vision = checkpoint.vision ?? [];
    const script = checkpoint.script ?? [];
    const captions = checkpoint.captions ?? [];
    const sourceFacts = item.sourceFacts ?? [];
    const factsById = new Map(sourceFacts.map((fact) => [fact.id, fact.text]));
    const sourceClips = item.sourceClips ?? item.sourceVisualTimeline.slots.map((slot) => ({
      slotLabel: slot.label,
      materialName: '来源视频素材',
      sourceOffset: item.sourceVisualTimeline.offsets?.[slot.id] ?? 0,
      timelineStart: item.sourceVisualTimeline.timelineStarts?.[slot.id] ?? 0,
      duration: slot.duration,
      transition: slot.transition,
      transitionDuration: slot.transitionDuration ?? 0,
      originalAudioDetached: item.sourceVisualTimeline.detachedAudios?.some(
        (audio) => audio.sourceSlotId === slot.id,
      ) ?? false,
    }));
    const clipContext = (clip: (typeof sourceClips)[number]) =>
      `${clip.slotLabel} · ${clip.materialName} · 原片 ${clip.sourceOffset.toFixed(1)}–${(clip.sourceOffset + clip.duration).toFixed(1)} 秒 · 成片 ${clip.timelineStart.toFixed(1)}–${(clip.timelineStart + clip.duration).toFixed(1)} 秒`;
    const lineFacts = (line: (typeof script)[number]) => line.factIds
      .map((id) => factsById.get(id))
      .filter((text): text is string => Boolean(text));
    switch (stage) {
      case 'SNAPSHOT': {
        for (const clip of sourceClips) append(inputSamples, item, clipContext(clip));
        for (const clip of sourceClips) {
          const fade = clip.transitionDuration > 0 ? `，${clip.transition} ${clip.transitionDuration.toFixed(1)} 秒` : `，${clip.transition}`;
          append(outputSamples, item, `已固定${clip.slotLabel}「${clip.materialName}」在成片 ${clip.timelineStart.toFixed(1)} 秒开始${fade}${clip.originalAudioDetached ? '，原声已分离' : ''}`);
        }
        break;
      }
      case 'VISION': {
        for (const clip of sourceClips) append(inputSamples, item, `分析${clipContext(clip)}中的实际画面动作`);
        for (const result of vision) append(outputSamples, item, `${slotLabel(result.slotId)}：${result.description}`);
        break;
      }
      case 'SCRIPT': {
        for (const line of script) {
          const visual = vision.find((result) => result.slotId === line.slotId)?.description;
          const facts = lineFacts(line);
          append(inputSamples, item, `${slotLabel(line.slotId)}画面：${visual || '等待视觉理解结果'}${facts.length ? `；已确认商品依据：${facts.join('；')}` : ''}`);
        }
        for (const line of script) {
          const facts = lineFacts(line);
          append(outputSamples, item, `${slotLabel(line.slotId)}口播：「${line.text}」${facts.length ? `；依据：${facts.join('；')}` : ''}`);
        }
        break;
      }
      case 'VOICE': {
        for (const line of script) append(inputSamples, item, `${slotLabel(line.slotId)}待配音文案：「${line.text}」`);
        for (const line of script) {
          const audio = checkpoint.voices?.[line.id];
          if (audio) {
            append(outputSamples, item, `${slotLabel(line.slotId)}「${line.text}」${audio.voiceProfile?.name ? ` · ${audio.voiceProfile.name}` : ''} · 配音已生成，${audio.duration.toFixed(1)} 秒`);
            if (audioPreviews.length < MAX_STAGE_SAMPLES && audio.fileObjectId)
              audioPreviews.push({ label: `${item.name} · ${slotLabel(line.slotId)}配音试听`, fileObjectId: audio.fileObjectId });
          }
        }
        break;
      }
      case 'MUSIC': {
        if (checkpoint.musicBrief) append(inputSamples, item, checkpoint.musicBrief);
        else if (sourceClips.length) {
          append(inputSamples, item, `根据${sourceClips.slice(0, 3).map((clip) => `${clip.slotLabel}「${clip.materialName}」`).join('、')}的画面节奏制作配乐`);
        }
        if (checkpoint.music) {
          append(outputSamples, item, `纯音乐已生成${checkpoint.musicBrief ? ` · 配乐方向：「${checkpoint.musicBrief}」` : ''} · 覆盖成片 ${checkpoint.music.duration.toFixed(1)} 秒`);
          if (audioPreviews.length < MAX_STAGE_SAMPLES && checkpoint.music.fileObjectId)
            audioPreviews.push({ label: `${item.name} · 纯音乐试听`, fileObjectId: checkpoint.music.fileObjectId });
        }
        break;
      }
      case 'CAPTIONS': {
        for (const line of script) {
          const audio = checkpoint.voices?.[line.id];
          if (audio) append(inputSamples, item, `口播「${line.text}」· 实际配音 ${audio.start.toFixed(1)}–${(audio.start + audio.duration).toFixed(1)} 秒`);
        }
        for (const caption of captions) append(outputSamples, item, `${caption.text} · ${caption.start.toFixed(1)}–${caption.end.toFixed(1)} 秒`);
        break;
      }
      case 'READY': {
        for (const line of script) {
          const audio = checkpoint.voices?.[line.id];
          const caption = captions.find((entry) => entry.voiceLineId === line.id || entry.id === line.id);
          append(inputSamples, item, `口播「${line.text}」${audio ? ` · 配音 ${audio.duration.toFixed(1)} 秒` : ''}${caption ? ` · 字幕「${caption.text}」` : ''}`);
          if (audio && audioPreviews.length < MAX_STAGE_SAMPLES && audio.fileObjectId)
            audioPreviews.push({ label: `${item.name} · ${slotLabel(line.slotId)}配音试听`, fileObjectId: audio.fileObjectId });
        }
        if (checkpoint.music) {
          append(inputSamples, item, `纯音乐已就绪${checkpoint.musicBrief ? ` · ${checkpoint.musicBrief}` : ''}`);
          if (audioPreviews.length < MAX_STAGE_SAMPLES && checkpoint.music.fileObjectId)
            audioPreviews.push({ label: `${item.name} · 纯音乐试听`, fileObjectId: checkpoint.music.fileObjectId });
        }
        if (item.status === 'COMPLETED') {
          const line = script[0];
          const caption = captions[0];
          append(outputSamples, item, `「${item.name}」包装草稿已就绪${line ? ` · 口播：「${line.text}」` : ''}${caption ? ` · 字幕：「${caption.text}」` : ''}${checkpoint.music ? ' · 含纯音乐' : ''}，可试听和检查`);
        }
        break;
      }
    }

    if (inputSamples.length >= MAX_STAGE_SAMPLES && outputSamples.length >= MAX_STAGE_SAMPLES) break;
  }

  return { inputSamples, outputSamples, audioPreviews };
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
    input: '口播原文、配音起点与时长',
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

/** A terminal rollup is an outcome, not an indefinitely stalled execution percentage. */
export function packagingTerminalResult(run?: PackagingRun) {
  if (!run || run.status === 'QUEUED' || run.status === 'RUNNING') return null;
  const labels = { COMPLETED: '全部完成', PARTIAL: '部分失败', FAILED: '失败', CANCELLED: '已取消' };
  return {
    summary: `智能成片包装 · 已结束（${labels[run.status]}）`,
    detail: `成功 ${run.counts.completed} / ${run.counts.total} 条 · 失败 ${run.counts.failed} 条 · ${run.status === 'COMPLETED' ? '包装已就绪，最终视频需在成片输出主动导出' : '未完成成片已保留包装前原样，可单独包装或自行编辑'}`,
  };
}

/** Compare frozen pictures, not names or positions; key insertion order is not content. */
function canonicalPicture(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalPicture).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value).filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalPicture(entry)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

/** A child result can be previewed before publication, but never applied to a different edit. */
export function livePackagingItem(run: PackagingRun | null, variant?: EffectTemplateMixVariant) {
  if (!run || !variant) return null;
  const item = run.items.find((entry) => entry.variantId === variant.id && entry.status === 'COMPLETED');
  const picture = packagingVisualTimeline(variant);
  const frozen = item?.sourceVisualTimeline;
  const comparable = (value: typeof picture | undefined) => item?.operation && value
    ? { ...value, detachedAudios: [], preservedTimelineEnd: undefined } : value;
  return item && canonicalPicture(comparable(frozen)) === canonicalPicture(comparable(picture))
    ? item : null;
}

/**
 * A run that is no longer queued or running has already produced (or attempted) a package, so the
 * action is a rerun — including a partial or failed one, where running it again is the only way
 * forward. Keying this on `ready` alone left the button reading "智能成片包装" after a finished run,
 * so a user whose run had ended (and partly failed) could not tell packaging had run at all.
 */
export function packagingActionText(ready: boolean, status: PackagingRun['status'] | null) {
  const attempted = status !== null && !['QUEUED', 'RUNNING'].includes(status);
  return ready || attempted ? '重新成片包装' : '智能成片包装';
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
  const tone = running ? 'running' : failed ? 'danger'
    : items.length && completed === items.length ? 'success' : 'waiting';
  const label = running ? (failed ? `执行中 · ${failed} 条失败` : '执行中')
    : failed ? `${failed} 条失败`
      : tone === 'success' ? '已完成' : cancelled ? '已取消'
        : blocked && !waiting ? '前序受阻' : completed ? '部分完成' : '等待中';
  const summary = [
    running && `执行中 ${running}`, failed && `失败 ${failed}`,
    waiting && `等待 ${waiting}`, blocked && `前序受阻 ${blocked}`,
    cancelled && `取消 ${cancelled}`,
  ].filter(Boolean).join(' · ');
  return { ...counts, tone, label, summary };
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
