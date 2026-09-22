import {
  EFFECT_TEMPLATE_MIX_TRANSITION_DEFAULT_DURATION,
  packagingTimelineClips,
  packagingTimelineDuration,
  packagingVisualTimeline,
} from '@ai-marketing/contracts';
import type {
  EffectTemplateMixMaterial,
  EffectTemplateMixVariant,
  PackagingCheckpoint,
  PackagingSnapshot,
  WorkingArtifact,
} from '@ai-marketing/contracts';
import { BadRequestException } from '@nestjs/common';
import { workflowStateHash } from '../../../platform/workflow/workflow-state-hash';

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
export const visualHash = (variant: EffectTemplateMixVariant) =>
  workflowStateHash(packagingVisualTimeline(variant));

/** Read legacy frozen hashes without rewriting checkpoints or revisions. */
export function matchesVisualHash(variant: EffectTemplateMixVariant, hash: string | undefined,
  frozen?: EffectTemplateMixVariant): boolean {
  if (visualHash(variant) === hash) return true;
  if (!frozen || visualHash(variant) !== visualHash(frozen)) return false;
  return workflowStateHash({ ...packagingVisualTimeline(frozen), videoLanes: frozen.videoLanes ?? {} }) === hash;
}

export function packagingSnapshot(
  variant: EffectTemplateMixVariant,
  materials: EffectTemplateMixMaterial[],
  artifacts: WorkingArtifact[],
): PackagingSnapshot {
  if (
    !variant.slots.length ||
    variant.slots.length > 30 ||
    packagingTimelineDuration(variant) > 3600
  )
    throw new BadRequestException('包装时间轴超过容量上限');
  const byId = new Map(artifacts.map((a) => [a.id, a]));
  const used = new Map<string, WorkingArtifact>();
  const visit = (id: string) => {
    if (used.has(id)) return;
    const a = byId.get(id);
    if (!a || a.freshness !== 'CURRENT' || a.availability !== 'AVAILABLE')
      throw new BadRequestException('包装来源工作副本已失效，请先确认上游');
    used.set(id, a);
    for (const d of a.dependencies)
      if (d.sourceType === 'WORKING_ARTIFACT' && d.sourceArtifactId) {
        const source = byId.get(d.sourceArtifactId);
        if (!source || source.revision !== d.sourceRevision)
          throw new BadRequestException('包装来源 revision 已改变');
        visit(source.id);
      }
  };
  const clips = packagingTimelineClips(variant).map(({ slot, start, lane }) => {
    const m = materials.find((m) => m.id === variant.bindings[slot.id]);
    const offset = variant.offsets[slot.id] ?? 0;
    if (
      !m?.available ||
      m.artifactRevision !== variant.bindingRevisions[slot.id] ||
      !Number.isFinite(offset) ||
      offset < 0 ||
      !Number.isFinite(start) ||
      start < 0 ||
      !Number.isInteger(lane) ||
      lane < 0 ||
      lane > 20 ||
      !Number.isFinite(slot.duration) ||
      slot.duration <= 0 ||
      offset + slot.duration > m.duration + 0.05
    )
      throw new BadRequestException('成片存在空槽、失效素材或越界截取');
    visit(m.artifactId);
    const promptId = record(byId.get(m.artifactId)?.payload).promptId;
    let prompt = '';
    for (const a of used.values())
      if (a.artifactKey.startsWith('prompt-batch:')) {
        const items = record(a.payload).items;
        if (Array.isArray(items))
          for (const item of items)
            if (record(item).id === promptId) prompt = String(record(item).content ?? '');
      }
    if (!prompt) throw new BadRequestException('缺少素材对应的已确认原始 Prompt');
    return {
      slotId: slot.id,
      materialId: m.id,
      fileObjectId: m.fileObjectId,
      contentHash: m.contentHash,
      start,
      lane,
      offset,
      duration: slot.duration,
      prompt,
      transition: slot.transition,
      transitionDuration:
        slot.transitionDuration ??
        (slot.transition === '硬切' ? 0 : EFFECT_TEMPLATE_MIX_TRANSITION_DEFAULT_DURATION),
    };
  });
  const facts = [...used.values()]
    .filter((a) => a.artifactKey.startsWith('marketing-insight:'))
    .flatMap((a) => {
      const payload = record(a.payload);
      const values = [
        'productName',
        'productCategory',
        'coreSpecification',
        'priceRange',
        'visualFeatures',
      ].map((k) => payload[k]);
      if (Array.isArray(payload.sellingPoints)) values.push(...payload.sellingPoints);
      return values.flatMap((text, index) =>
        typeof text === 'string' && text.trim()
          ? [{ id: `${a.id}:${index}`, text, artifactId: a.id, revision: a.revision }]
          : [],
      );
    });
  if (!facts.length)
    throw new BadRequestException('缺少素材所消费的已确认商品信息，不能生成商品口播');
  return {
    sourceTimelineHash: visualHash(variant),
    duration: packagingTimelineDuration(variant),
    variant,
    clips,
    facts,
    dependencies: [...used.values()].map((a) => ({
      artifactId: a.id,
      artifactKey: a.artifactKey,
      revision: a.revision,
      contentHash: a.contentHash ?? '',
      nodeId: a.nodeId,
    })),
  };
}

/** Validate structure/provenance only. Meaning and factual support are reviewed by AI. */
export function validatePackagingCheckpoint(
  snapshot: PackagingSnapshot,
  checkpoint: PackagingCheckpoint,
  ready = false,
  /**
   * Editor edits may move audio freely and decouple captions from their voice.
   * Worker writes stay canonical (`edited = false`) so pipeline output cannot drift.
   */
  edited = false,
): void {
  const fail = () => {
    throw new BadRequestException('包装结果结构、来源或时间边界无效');
  };
  const interval = (start: number, end: number) =>
    Number.isFinite(start) &&
    Number.isFinite(end) &&
    start >= 0 &&
    end > start &&
    end <= snapshot.duration + 0.001;
  /**
   * Fades are editor-only and optional, so an absent field is legal — the pipeline default applies.
   * When one is present it has to be a real duration that fits inside the clip, or the render would
   * be asked to fade in and out of the same sample.
   */
  const fades = (audio: { duration: number; fadeIn?: number; fadeOut?: number }) => {
    const fadeIn = audio.fadeIn ?? 0;
    const fadeOut = audio.fadeOut ?? 0;
    return (
      Number.isFinite(fadeIn) &&
      Number.isFinite(fadeOut) &&
      fadeIn >= 0 &&
      fadeOut >= 0 &&
      fadeIn + fadeOut <= audio.duration + 0.05
    );
  };
  const facts = new Set(snapshot.facts.map((f) => f.id));
  if (
    Object.keys(checkpoint).some(
      (k) =>
        ![
          'vision',
          'script',
          'musicBrief',
          'voices',
          'music',
          'captions',
          'captionBoxes',
          'musicTaskId',
          'musicSubmissionPending',
        ].includes(k),
    )
  )
    fail();
  if (
    checkpoint.musicTaskId !== undefined &&
    (typeof checkpoint.musicTaskId !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,200}$/.test(checkpoint.musicTaskId))
  )
    fail();
  if (
    checkpoint.musicSubmissionPending !== undefined &&
    typeof checkpoint.musicSubmissionPending !== 'boolean'
  )
    fail();
  if (
    checkpoint.musicBrief !== undefined &&
    (typeof checkpoint.musicBrief !== 'string' ||
      !checkpoint.musicBrief.trim() ||
      checkpoint.musicBrief.length > 2000)
  )
    fail();
  if (
    checkpoint.vision &&
    (!Array.isArray(checkpoint.vision) ||
      checkpoint.vision.length > 500 ||
      checkpoint.vision.some(
        (row) =>
          !row ||
          !interval(row.start, row.end) ||
          typeof row.description !== 'string' ||
          row.description.length > 2000,
      ))
  )
    fail();
  if (checkpoint.script) {
    if (
      !Array.isArray(checkpoint.script) ||
      !checkpoint.script.length ||
      checkpoint.script.length > 200
    )
      fail();
    const ids = new Set<string>();
    let end = 0;
    for (const row of checkpoint.script) {
      if (
        !row ||
        typeof row.id !== 'string' ||
        !/^[a-zA-Z0-9_-]{1,50}$/.test(row.id) ||
        ids.has(row.id) ||
        typeof row.text !== 'string' ||
        !row.text.trim() ||
        row.text.length > 500 ||
        !interval(row.start, row.end) ||
        row.start < end ||
        !Array.isArray(row.factIds) ||
        !row.factIds.length ||
        row.factIds.some((id) => !facts.has(id))
      )
        fail();
      ids.add(row.id);
      end = row.end;
    }
  }
  if (checkpoint.voices)
    for (const [id, audio] of Object.entries(checkpoint.voices)) {
      const index = checkpoint.script?.findIndex((s) => s.id === id) ?? -1;
      const line = checkpoint.script?.[index];
      const limit = checkpoint.script?.[index + 1]?.start ?? snapshot.duration;
      const offset = audio?.offset ?? 0;
      if (
        !line ||
        !audio ||
        !Number.isFinite(offset) ||
        offset < 0 ||
        !interval(audio.start, audio.start + audio.duration) ||
        (!edited && (audio.start !== line.start || audio.start + audio.duration > limit + 0.001)) ||
        !Number.isFinite(audio.volume) ||
        audio.volume < 0 ||
        audio.volume > 1 ||
        !fades(audio)
      )
        fail();
    }
  if (checkpoint.music) {
    const offset = checkpoint.music.offset ?? 0;
    if (
      !Number.isFinite(offset) ||
      offset < 0 ||
      !interval(checkpoint.music.start, checkpoint.music.start + checkpoint.music.duration) ||
      (!edited &&
        (checkpoint.music.start !== 0 ||
          Math.abs(checkpoint.music.duration - snapshot.duration) > 0.05)) ||
      !Number.isFinite(checkpoint.music.volume) ||
      checkpoint.music.volume < 0 ||
      checkpoint.music.volume > 0.3 ||
      !fades(checkpoint.music)
    )
      fail();
  }
  if (checkpoint.captions) {
    if (!Array.isArray(checkpoint.captions)) fail();
    if (new Set(checkpoint.captions.map((c) => c.id)).size !== checkpoint.captions.length) fail();
    let previousEnd = 0;
    for (const c of checkpoint.captions) {
      const script = checkpoint.script?.find((s) => s.id === c.id),
        audio = checkpoint.voices?.[c.id];
      if (
        !script ||
        !audio ||
        typeof c.text !== 'string' ||
        !c.text.trim() ||
        c.text.length > 500 ||
        // The editor may reword a subtitle without rewriting the narration it is voiced from.
        (!edited && c.text !== script.text) ||
        (!edited &&
          (c.start !== audio.start || Math.abs(c.end - c.start - audio.duration) > 0.002)) ||
        !interval(c.start, c.end)
      )
        fail();
      // Edited captions move independently, so they must stay sorted and non-overlapping.
      if (edited && c.start < previousEnd - 0.001) fail();
      previousEnd = Math.max(previousEnd, c.end);
    }
  }
  if (checkpoint.captionBoxes) {
    const boxes = Object.entries(checkpoint.captionBoxes);
    // A component redo drops the caption list while these stay, so an id is checked for
    // shape only; a box that matches no caption is ignored at render time.
    if (boxes.length > 500) fail();
    for (const [id, box] of boxes) {
      if (
        !/^[a-zA-Z0-9_-]{1,50}$/.test(id) ||
        !box ||
        typeof box !== 'object' ||
        Object.keys(box).some((k) => !['x', 'y', 'width', 'scale'].includes(k)) ||
        !Number.isFinite(box.x) ||
        !Number.isFinite(box.y) ||
        !Number.isFinite(box.width) ||
        !Number.isFinite(box.scale) ||
        box.x < 0 ||
        box.x > 1 ||
        box.y < 0 ||
        box.y > 1 ||
        box.width < 0.1 ||
        box.width > 1 ||
        box.scale < 0.25 ||
        box.scale > 4
      )
        fail();
    }
  }
  if (
    ready &&
    (!checkpoint.vision?.length ||
      !checkpoint.script?.length ||
      !checkpoint.music ||
      checkpoint.script.some((s) => !checkpoint.voices?.[s.id]) ||
      checkpoint.captions?.length !== checkpoint.script.length)
  )
    fail();
}

/**
 * Restore pipeline-canonical audio geometry before a partial redo reuses an edited
 * checkpoint; the worker write path validates with the strict (unedited) rules.
 */
export function canonicalizeCheckpoint(
  snapshot: PackagingSnapshot,
  checkpoint: PackagingCheckpoint,
): PackagingCheckpoint {
  const voices = checkpoint.voices
    ? Object.fromEntries(
        Object.entries(checkpoint.voices).map(([id, audio]) => {
          const line = checkpoint.script?.find((s) => s.id === id);
          return [id, { ...audio, start: line?.start ?? audio.start, offset: 0 }];
        }),
      )
    : checkpoint.voices;
  const music = checkpoint.music
    ? { ...checkpoint.music, start: 0, duration: snapshot.duration, offset: 0 }
    : checkpoint.music;
  const captions = checkpoint.captions
    ? [...checkpoint.captions]
        .sort((left, right) => left.start - right.start)
        .map((caption) => {
          const audio = voices?.[caption.id];
          return audio
            ? { ...caption, start: audio.start, end: audio.start + audio.duration }
            : caption;
        })
    : checkpoint.captions;
  const canonical: PackagingCheckpoint = { ...checkpoint };
  if (voices) canonical.voices = voices;
  if (music) canonical.music = music;
  if (captions) canonical.captions = captions;
  return canonical;
}
