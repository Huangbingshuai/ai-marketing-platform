import {
  EFFECT_TEMPLATE_MIX_MAX_CONTENT_SECONDS,
  EFFECT_TEMPLATE_MIX_TRANSITION_DEFAULT_DURATION,
  PACKAGING_AUDIO_GAIN_CEILING,
  effectTemplateMixContentDuration,
  packagingTimelineClips,
  packagingTimelineDuration,
  packagingVisualTimeline,
  packagingStoredTimelineStarts,
  packagingSlotBoundaryError,
} from '@ai-marketing/contracts';
import type {
  EffectTemplateMixMaterial,
  EffectTemplateMixVariant,
  PackagingCheckpoint,
  PackagingSnapshot,
  WorkingArtifact,
} from '@ai-marketing/contracts';
import { BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { workflowStateHash } from '../../../platform/workflow/workflow-state-hash';

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
export const visualHash = (variant: EffectTemplateMixVariant) =>
  workflowStateHash(packagingVisualSource(variant));

/**
 * Packaging is tied to which source frames and slot durations were used, not where the editor later
 * places those clips. Placement is read live at final render time, just like an NLE timeline.
 */
const packagingVisualSource = (variant: EffectTemplateMixVariant) => {
  const timeline = packagingVisualTimeline(variant);
  const { timelineStarts: _starts, videoLanes: _lanes, slots, ...source } = timeline;
  // Transitions, roles, labels, track and timeline positions affect the picture edit, not which
  // source material a narration was generated for. Keep slot identity and duration as dependencies.
  return { ...source, slots: slots.map(({ id, duration }) => ({ id, duration })) };
};

export const slotVisionKey = (clip: PackagingSnapshot['clips'][number]) =>
  createHash('sha256').update(JSON.stringify(['slot-frames-3-320-v1', clip.contentHash,
    clip.offset.toFixed(6), clip.duration.toFixed(6)])).digest('hex');

/** Read legacy frozen hashes without rewriting checkpoints or revisions. */
export function matchesVisualHash(variant: EffectTemplateMixVariant, hash: string | undefined,
  frozen?: EffectTemplateMixVariant): boolean {
  if (visualHash(variant) === hash) return true;
  if (!frozen || visualHash(variant) !== visualHash(frozen)) return false;
  return (
    workflowStateHash({
      ...packagingVisualTimeline(frozen),
      // Read checkpoints written before placement was removed from the package source hash.
      timelineStarts: packagingStoredTimelineStarts(frozen),
      videoLanes: frozen.videoLanes ?? {},
    }) === hash
  );
}

/**
 * The artifacts a packaging consumes, walked through their upstream dependencies so anything that is
 * no longer current is rejected. One is built per snapshot and shared by the clip builder below and by
 * the detached-audio check after it.
 */
export function artifactVisitor(artifacts: WorkingArtifact[]) {
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
  return { byId, used, visit };
}

/**
 * Builds the frozen clip rows for a variant's slots, rejecting any clip whose material, cut or
 * provenance has gone stale.
 *
 * The packaging snapshot calls it with the whole variant. The export calls it again with only the
 * overlay slots, folding in the picture layers the user stacked on after the package was confirmed:
 * those are not part of what was confirmed, but they still have to be renderable clips.
 */
export function packagingClips(
  variant: EffectTemplateMixVariant,
  materials: EffectTemplateMixMaterial[],
  { byId, used, visit }: ReturnType<typeof artifactVisitor>,
): PackagingSnapshot['clips'] {
  return packagingTimelineClips(variant).map(({ slot, start, lane }) => {
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
      materialCode: m.code,
      materialName: m.name,
      fileObjectId: m.fileObjectId,
      contentHash: m.contentHash,
      start,
      lane,
      offset,
      duration: slot.duration,
      prompt,
      // The Worker narrates every clip unless it is told this one is picture only.
      overlay: slot.overlay === true,
      transition: slot.transition,
      transitionDuration:
        slot.transitionDuration ??
        (slot.transition === '硬切' ? 0 : EFFECT_TEMPLATE_MIX_TRANSITION_DEFAULT_DURATION),
      originalAudioDetached: (variant.detachedAudios ?? []).some(
        (audio) => audio.sourceSlotId === slot.id,
      ),
    };
  });
}

export function packagingSnapshot(
  variant: EffectTemplateMixVariant,
  materials: EffectTemplateMixMaterial[],
  artifacts: WorkingArtifact[],
  musicSources: ReadonlyMap<string, { fileObjectId: string; sourceDuration: number }> = new Map(),
): PackagingSnapshot {
  const boundaryError = packagingSlotBoundaryError(variant);
  if (boundaryError) throw new BadRequestException(boundaryError);
  if (
    !variant.slots.length ||
    variant.slots.length > 30 ||
    effectTemplateMixContentDuration(variant) > EFFECT_TEMPLATE_MIX_MAX_CONTENT_SECONDS
  )
    throw new BadRequestException('包装时间轴超过容量上限');
  const visitor = artifactVisitor(artifacts);
  const { used, visit } = visitor;
  const clips = packagingClips(variant, materials, visitor);
  const timelineDuration = packagingTimelineDuration(variant);
  // A detached track is part of the film's content, so the film is at least as long as it is: the
  // only bound left is the capacity cap. (`timelineDuration` stays video-only — it is the frozen
  // snapshot's own length, which the editor is allowed to render past.)
  const detachedAudios = variant.detachedAudios ?? [];
  const videoDetachedAudios = detachedAudios.filter((audio) => audio.sourceSlotId);
  if (
    detachedAudios.length > 100 ||
    new Set(detachedAudios.map(({ id }) => id)).size !== detachedAudios.length ||
    new Set(videoDetachedAudios.map(({ sourceSlotId }) => sourceSlotId)).size !==
      videoDetachedAudios.length ||
    detachedAudios.some((audio) => {
      if (audio.sourceAssetId) {
        const source = musicSources.get(audio.sourceAssetId);
        return (
          Boolean(audio.sourceSlotId) ||
          !source ||
          source.fileObjectId !== audio.fileObjectId ||
          !Number.isFinite(audio.sourceDuration) ||
          Math.abs(source.sourceDuration - (audio.sourceDuration ?? 0)) > 0.05 ||
          !Number.isFinite(audio.start) ||
          audio.start < 0 ||
          !Number.isFinite(audio.duration) ||
          audio.duration <= 0 ||
          audio.start + audio.duration > EFFECT_TEMPLATE_MIX_MAX_CONTENT_SECONDS + 0.001 ||
          !Number.isFinite(audio.offset) ||
          audio.offset < 0 ||
          audio.offset + audio.duration > source.sourceDuration + 0.05 ||
          !Number.isFinite(audio.volume) ||
          audio.volume < 0 ||
          audio.volume > PACKAGING_AUDIO_GAIN_CEILING
        );
      }
      const material = materials.find((item) => item.fileObjectId === audio.fileObjectId);
      return (
        !audio.id ||
        !audio.sourceSlotId ||
        !variant.slots.some((slot) => slot.id === audio.sourceSlotId) ||
        !material?.available ||
        !Number.isFinite(audio.start) ||
        audio.start < 0 ||
        !Number.isFinite(audio.duration) ||
        audio.duration <= 0 ||
        audio.start + audio.duration > EFFECT_TEMPLATE_MIX_MAX_CONTENT_SECONDS + 0.001 ||
        !Number.isFinite(audio.offset) ||
        audio.offset < 0 ||
        audio.offset + audio.duration > material.duration + 0.05 ||
        !Number.isFinite(audio.volume) ||
        audio.volume < 0 ||
        audio.volume > PACKAGING_AUDIO_GAIN_CEILING
      );
    })
  )
    throw new BadRequestException('分离音频片段来源、时长或时间范围无效');
  for (const audio of detachedAudios) {
    if (audio.sourceAssetId) continue;
    const slot = variant.slots.find(({ id }) => id === audio.sourceSlotId)!;
    const material = materials.find(({ fileObjectId }) => fileObjectId === audio.fileObjectId)!;
    if (variant.bindings[slot.id] !== material.id)
      throw new BadRequestException('分离音频必须对应其原视频素材');
    visit(material.artifactId);
  }
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
    narrationLayoutVersion: 'SLOT_V1',
    sourceTimelineHash: visualHash(variant),
    duration: timelineDuration,
    variant,
    clips,
    ...(detachedAudios.length ? { detachedAudios } : {}),
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
  /** Slot-bound rows: they belong to a video clip, so the frozen visual timeline bounds them. */
  const interval = (start: number, end: number) =>
    Number.isFinite(start) &&
    Number.isFinite(end) &&
    start >= 0 &&
    end > start &&
    end <= snapshot.duration + 0.001;
  /**
   * Placed rows: audio and captions the editor is free to carry past the last video clip, which is
   * how a black tail with sound is made. The film is as long as its own content, so the content
   * duration cannot bound them — it grows with whatever is being validated — and the capacity cap
   * is the only limit left.
   */
  const contentInterval = (start: number, end: number) =>
    Number.isFinite(start) &&
    Number.isFinite(end) &&
    start >= 0 &&
    end > start &&
    end <= EFFECT_TEMPLATE_MIX_MAX_CONTENT_SECONDS + 0.001;
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
  const slotLayout = checkpoint.narrationLayoutVersion === 'SLOT_V1';
  const segmentedCaptions = checkpoint.captionLayoutVersion === 'SEGMENT_V1' ||
    checkpoint.captionLayoutVersion === 'SEGMENT_V2' || checkpoint.captionLayoutVersion === 'SEGMENT_V3';
  const captionsV2 = checkpoint.captionLayoutVersion === 'SEGMENT_V2' ||
    checkpoint.captionLayoutVersion === 'SEGMENT_V3';
  const captionsV3 = checkpoint.captionLayoutVersion === 'SEGMENT_V3';
  if (checkpoint.narrationLayoutVersion !== undefined && !slotLayout) fail();
  if (checkpoint.captionLayoutVersion !== undefined && (!segmentedCaptions || !slotLayout)) fail();
  if (snapshot.narrationLayoutVersion === 'SLOT_V1' && !slotLayout) fail();
  if (slotLayout) {
    const boundaryError = packagingSlotBoundaryError(snapshot.variant);
    if (boundaryError) throw new BadRequestException(boundaryError);
  }
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
          'captionVoices',
          'captionLayoutVersion',
          'musicTaskId',
          'musicSubmissionPending',
          'narrationLayoutVersion', 'slotVision', 'timings', 'voiceFitAttempts', 'voiceSlotRetries', 'automaticRetries', 'narrationMetrics',
        ].includes(k),
    )
  )
    fail();
  if (checkpoint.automaticRetries !== undefined &&
      (!Number.isInteger(checkpoint.automaticRetries) || checkpoint.automaticRetries < 0 || checkpoint.automaticRetries > 2)) fail();
  if (checkpoint.narrationMetrics) {
    for (const [slotId, row] of Object.entries(checkpoint.narrationMetrics)) {
      const clip = snapshot.clips.find((c) => c.slotId === slotId);
      if (!clip || !row || Object.keys(row).length !== 7 ||
        !['characters', 'minCharacters', 'targetCharacters', 'maxCharacters', 'slotSeconds', 'audioSeconds', 'utilization'].every(
          (key) => Number.isFinite(row[key as keyof typeof row]) && row[key as keyof typeof row] >= 0) ||
        row.minCharacters > row.targetCharacters || row.targetCharacters > row.maxCharacters ||
        Math.abs(row.slotSeconds - clip.duration) > .001 || row.audioSeconds > row.slotSeconds + .001 ||
        Math.abs(row.utilization - row.audioSeconds / row.slotSeconds) > .001) fail();
    }
  }
  if (checkpoint.slotVision) {
    for (const [slotId, row] of Object.entries(checkpoint.slotVision))
      if (!snapshot.clips.some((c) => c.slotId === slotId) || !row ||
          row.key !== slotVisionKey(snapshot.clips.find((c) => c.slotId === slotId)!) || typeof row.description !== 'string' ||
          !row.description.trim() || row.description.length > 2000) fail();
  }
  if (checkpoint.voiceFitAttempts && Object.entries(checkpoint.voiceFitAttempts).some(([id, count]) =>
    !snapshot.clips.some((c) => c.slotId === id) || count !== 1)) fail();
  if (checkpoint.voiceSlotRetries && Object.entries(checkpoint.voiceSlotRetries).some(([id, count]) =>
    !snapshot.clips.some((c) => c.slotId === id) || count !== 1)) fail();
  if (checkpoint.timings) {
    for (const [id, row] of Object.entries(checkpoint.timings)) {
      if (id !== '_item' && !snapshot.clips.some((c) => c.slotId === id)) fail();
      if (!row || typeof row !== 'object') fail();
      for (const [key, value] of Object.entries(row)) {
        if (key === 'cacheHit') { if (typeof value !== 'boolean') fail(); }
        else if (key === 'scriptRepairSlots') { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) fail(); }
        else if (!['preprocessingSeconds', 'visionSeconds', 'scriptSeconds', 'voiceSeconds', 'musicWaitSeconds', 'localQueueSeconds'].includes(key) ||
          typeof value !== 'number' || !Number.isFinite(value) || value < 0) fail();
      }
    }
  }
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
      (!checkpoint.script.length && (!slotLayout || ready)) ||
      checkpoint.script.length > 200
    )
      fail();
    const ids = new Set<string>();
    const slots = new Set<string>();
    let end = 0;
    for (const row of checkpoint.script) {
      if (slotLayout) {
        const clip = snapshot.clips.find((c) => c.slotId === row.slotId);
        if (!clip || !row.slotId || slots.has(row.slotId) ||
          row.start !== clip.start || Math.abs(row.end - clip.start - clip.duration) > 0.001) fail();
        slots.add(row.slotId!);
      }
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
    // An overlay is picture only, so the script covers the narrated clips and stops there.
    if (slotLayout && ready && slots.size !== snapshot.clips.filter((c) => !c.overlay).length)
      fail();
  }
  if (checkpoint.voices)
    for (const [id, audio] of Object.entries(checkpoint.voices)) {
      const index = checkpoint.script?.findIndex((s) => s.id === id) ?? -1;
      const line = checkpoint.script?.[index];
      const limit = slotLayout ? (line?.end ?? 0) : (checkpoint.script?.[index + 1]?.start ?? snapshot.duration);
      const offset = audio?.offset ?? 0;
      if (
        !line ||
        !audio ||
        !Number.isFinite(offset) ||
        offset < 0 ||
        !contentInterval(audio.start, audio.start + audio.duration) ||
        // The worker keeps a line inside its slot; the editor may carry it past the slot's end,
        // which is what extends the film.
        (slotLayout && !edited &&
          (audio.start < (line?.start ?? 0) || audio.start + audio.duration > limit + 0.001)) ||
        (!edited && (audio.start !== line.start || audio.start + audio.duration > limit + 0.001)) ||
        !Number.isFinite(audio.volume) ||
        audio.volume < 0 ||
        audio.volume > PACKAGING_AUDIO_GAIN_CEILING ||
        !fades(audio)
      )
        fail();
      if (audio.segmentFrames &&
        (!Array.isArray(audio.segmentFrames) || !audio.segmentFrames.length || audio.segmentFrames.length > 500 ||
          audio.segmentFrames.some((frames) => !Number.isSafeInteger(frames) || frames <= 0) ||
          Math.abs(audio.segmentFrames.reduce((sum, frames) => sum + frames, 0) / 24_000 - audio.duration) > .001)) fail();
    }
  // A generated caption narration is editor-owned, so — like a caption box — it is checked for
  // shape and bounds and for nothing else. It has no script line to line up with and no slot to
  // stay inside, its caption may be gone by the time it is read (deleting a subtitle must not
  // silently delete the narration the user paid for), and the editor may carry it anywhere. Coupling
  // it to the caption would also make a component redo fail, because that redo validates with the
  // strict pipeline rules after the editor has already moved things.
  if (checkpoint.captionVoices)
    for (const [id, audio] of Object.entries(checkpoint.captionVoices)) {
      const offset = audio?.offset ?? 0;
      if (
        !/^[a-zA-Z0-9_-]{1,50}$/.test(id) ||
        !audio ||
        !Number.isFinite(offset) ||
        offset < 0 ||
        !contentInterval(audio.start, audio.start + audio.duration) ||
        !Number.isFinite(audio.volume) ||
        audio.volume < 0 ||
        audio.volume > PACKAGING_AUDIO_GAIN_CEILING ||
        !fades(audio)
      )
        fail();
      if (audio.segmentFrames &&
        (!Array.isArray(audio.segmentFrames) || !audio.segmentFrames.length || audio.segmentFrames.length > 500 ||
          audio.segmentFrames.some((frames) => !Number.isSafeInteger(frames) || frames <= 0) ||
          Math.abs(audio.segmentFrames.reduce((sum, frames) => sum + frames, 0) / 24_000 - audio.duration) > .001)) fail();
    }
  if (checkpoint.music) {
    const offset = checkpoint.music.offset ?? 0;
    if (
      !Number.isFinite(offset) ||
      offset < 0 ||
      !contentInterval(checkpoint.music.start, checkpoint.music.start + checkpoint.music.duration) ||
      (!edited &&
        (checkpoint.music.start !== 0 ||
          Math.abs(checkpoint.music.duration - snapshot.duration) > 0.05)) ||
      !Number.isFinite(checkpoint.music.volume) ||
      checkpoint.music.volume < 0 ||
      checkpoint.music.volume > PACKAGING_AUDIO_GAIN_CEILING ||
      !fades(checkpoint.music)
    )
      fail();
  }
  if (checkpoint.captions) {
    if (!Array.isArray(checkpoint.captions)) fail();
    if (checkpoint.captions.length > 500) fail();
    if (new Set(checkpoint.captions.map((c) => c.id)).size !== checkpoint.captions.length) fail();
    // Explicit subtitle tracks are fixed rows and cannot overlap. Implicit/generated captions are
    // automatically interval-packed into display rows by both the editor and the renderer.
    const segmentsByLine = new Map<string, typeof checkpoint.captions>();
    for (const c of checkpoint.captions) {
      const manual = c.manual === true;
      const lineId = segmentedCaptions ? c.voiceLineId : c.id;
      const script = checkpoint.script?.find((s) => s.id === lineId),
        audio = lineId ? checkpoint.voices?.[lineId] : undefined;
      if (
        (c.manual !== undefined && typeof c.manual !== 'boolean') ||
        // A track of its own is editor geometry, so any card may carry one — a narration card the
        // editor pulled onto its own row just as much as a manual title. Only the shape is checked.
        (c.trackId !== undefined &&
          (typeof c.trackId !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(c.trackId))) ||
        (manual &&
          (!edited ||
            c.voiceLineId !== undefined ||
            c.segmentIndex !== undefined ||
            c.segmentCount !== undefined)) ||
        (manual && !/^[a-zA-Z0-9_-]{1,50}$/.test(c.id)) ||
        // The line is what a caption hangs off; its narration is an optional overlay, so the editor
        // may delete the voice and leave the line and its subtitle standing.
        (!manual && !script) ||
        (segmentedCaptions &&
          !manual &&
          (typeof c.voiceLineId !== 'string' ||
            !/^[a-zA-Z0-9_-]{1,50}$/.test(c.id) ||
            !Number.isSafeInteger(c.segmentIndex) ||
            !Number.isSafeInteger(c.segmentCount) ||
            c.segmentIndex! < 0 ||
            c.segmentCount! < 1 ||
            c.segmentCount! > 500)) ||
        typeof c.text !== 'string' ||
        (!manual && !c.text.trim()) ||
        c.text.length > 500 ||
        (!manual &&
          segmentedCaptions &&
          (captionsV2 ? /[，,。.!！？?；;：:…]/u : /\p{P}/u).test(c.text)) ||
        // The editor may reword a subtitle without rewriting the narration it is voiced from.
        (!manual && !segmentedCaptions && !edited && c.text !== script!.text) ||
        // A deleted voice has nothing to align to, so the alignment rules only hold when one exists.
        (!manual && !segmentedCaptions && !edited && audio &&
          (c.start !== audio.start || Math.abs(c.end - c.start - audio.duration) > 0.002)) ||
        (!manual &&
          segmentedCaptions &&
          !edited &&
          audio &&
          (c.start < audio.start - 0.001 || c.end > audio.start + audio.duration + 0.001)) ||
        !contentInterval(c.start, c.end)
        || (!manual && slotLayout && !edited &&
          (c.start < (script?.start ?? 0) || c.end > (script?.end ?? 0) + 0.001))
      )
        fail();
      // A user-chosen row is a hard constraint. The implicit narration row is only a grouping:
      // overlapping captions are placed on additional display lanes, matching the timeline UI.
      if (c.trackId) {
        if (checkpoint.captions.some((other) =>
          other.id !== c.id && other.trackId === c.trackId &&
          c.start < other.end - 0.001 && other.start < c.end - 0.001)) fail();
      }
      if (segmentedCaptions && !manual && checkpoint.captions.some((other) =>
        other.id !== c.id && !other.manual &&
        (other.voiceLineId ?? other.id) === lineId &&
        c.start < other.end - 0.001 && other.start < c.end - 0.001)) fail();
      if (segmentedCaptions && !manual) {
        const parts = segmentsByLine.get(lineId!) ?? [];
        parts.push(c);
        segmentsByLine.set(lineId!, parts);
      }
    }
    if (segmentedCaptions && checkpoint.script?.some((line) => {
      const parts = segmentsByLine.get(line.id);
      const audio = checkpoint.voices?.[line.id];
      return (ready && !parts?.length) || (parts?.length && (
        parts.some((part, index) => part.segmentIndex !== index || part.segmentCount !== parts.length) ||
        // The pipeline lays a line's cards edge to edge; the editor may pull one away, which opens
        // a gap rather than breaking anything, so the rule only holds the worker write path.
        (!edited && captionsV2 && parts.some((part, index) => index > 0 &&
          Math.abs(part.start - parts[index - 1]!.end) > 0.001)) ||
        (!edited && parts.map((part) => part.text).join('').replace(/\s/gu, '') !==
          line.text.replace(captionsV2 ? /[，,。.!！？?；;：:…\s]/gu : /[\p{P}\s]/gu, '')) ||
        // Frame alignment is only meaningful for a line that still has its narration.
        (captionsV3 && audio && (!audio.segmentFrames || parts.length !== audio.segmentFrames.length ||
          (!edited && parts.some((part, index) => {
            const startFrames = audio.segmentFrames!.slice(0, index).reduce((sum, n) => sum + n, 0);
            const endFrames = startFrames + audio.segmentFrames![index]!;
            return Math.abs(part.start - (audio.start + startFrames / 24_000)) > .001 ||
              Math.abs(part.end - (audio.start + endFrames / 24_000)) > .001;
          }))))));
    })) fail();
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
  const narrationCaptions = checkpoint.captions?.filter((caption) => !caption.manual) ?? [];
  if (
    ready &&
    (!checkpoint.vision?.length ||
      !checkpoint.script?.length ||
      // A narration is not part of being renderable either: the editor may delete one and keep the
      // line and its subtitle, and the renderer mixes whatever voices are left. A redo synthesizes
      // every line again, so the deletion lasts exactly until the next run.
      (segmentedCaptions
        ? !narrationCaptions.length
        : narrationCaptions.length !== checkpoint.script.length))
  )
    fail();
  // Frame-split captions need the frames of the voice they were split from; a line whose voice the
  // editor deleted simply has no frames to match.
  if (ready && captionsV3 && checkpoint.script?.some((line) => {
    const audio = checkpoint.voices?.[line.id];
    return audio && !audio.segmentFrames;
  })) fail();
}

export function requireSlotPackaging(snapshot: PackagingSnapshot, checkpoint: PackagingCheckpoint): void {
  if (checkpoint.narrationLayoutVersion !== 'SLOT_V1')
    throw new BadRequestException('旧版整片口播仅可播放，请按槽位重新包装后进入成片输出');
  validatePackagingCheckpoint(snapshot, checkpoint, true, true);
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
          const lineId = checkpoint.captionLayoutVersion ? caption.voiceLineId : caption.id;
          const audio = lineId ? voices?.[lineId] : undefined;
          if (!audio) return caption;
          if (!checkpoint.captionLayoutVersion)
            return { ...caption, start: audio.start, end: audio.start + audio.duration };
          const previous = checkpoint.voices?.[lineId!];
          const shift = audio.start - (previous?.start ?? audio.start);
          return { ...caption, start: caption.start + shift, end: caption.end + shift };
        })
    : checkpoint.captions;
  const canonical: PackagingCheckpoint = { ...checkpoint };
  if (voices) canonical.voices = voices;
  if (music) canonical.music = music;
  if (captions) canonical.captions = captions;
  return canonical;
}
