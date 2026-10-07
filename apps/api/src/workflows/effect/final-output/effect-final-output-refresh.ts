import { ConflictException } from '@nestjs/common';
import type { EffectTemplateMixVariant, FinalOutputSnapshot, PackagingCheckpoint } from '@ai-marketing/contracts';
import { effectTemplateMixContentDuration } from '@ai-marketing/contracts';
import { workflowStateHash } from '../../../platform/workflow/workflow-state-hash';
import { validatePackagingCheckpoint } from '../template-mix/effect-packaging.domain';

/** Keep user-authored captions and everything outside the exact changed slot lineage. */
export function withoutChangedSlots(
  cp: PackagingCheckpoint,
  slotIds: readonly string[],
): PackagingCheckpoint {
  const result = structuredClone(cp);
  const slots = new Set(slotIds);
  const lines = new Set(
    (cp.script ?? []).filter((line) => slots.has(line.slotId ?? '')).map((line) => line.id),
  );
  const captionIds = new Set(
    (cp.captions ?? [])
      .filter((caption) => !caption.manual && lines.has(caption.voiceLineId ?? caption.id))
      .map((caption) => caption.id),
  );
  const manualIds = new Set(
    (cp.captions ?? []).filter((caption) => caption.manual).map((caption) => caption.id),
  );
  result.script = (result.script ?? []).filter((line) => !slots.has(line.slotId ?? ''));
  result.voices = Object.fromEntries(
    Object.entries(result.voices ?? {}).filter(([id]) => !lines.has(id)),
  );
  result.captions = (result.captions ?? []).filter((caption) => !captionIds.has(caption.id));
  result.captionBoxes = Object.fromEntries(
    Object.entries(result.captionBoxes ?? {}).filter(
      ([id]) => manualIds.has(id) || (!lines.has(id) && !captionIds.has(id)),
    ),
  );
  result.captionVoices = Object.fromEntries(
    Object.entries(result.captionVoices ?? {}).filter(
      ([id]) => manualIds.has(id) || (!lines.has(id) && !captionIds.has(id)),
    ),
  );
  result.vision = (result.vision ?? []).filter((row) => !slots.has(row.slotId ?? ''));
  for (const field of [
    'slotVision',
    'narrationMetrics',
    'voiceFitAttempts',
    'voiceSlotRetries',
    'timings',
  ] as const) {
    if (result[field])
      result[field] = Object.fromEntries(
        Object.entries(result[field]!).filter(([id]) => !slots.has(id)),
      ) as never;
  }
  delete result.musicTaskId;
  delete result.musicSubmissionPending;
  // A newly frozen source refresh owns its own recovery budget. Older packaging
  // retries must not exhaust it; persisted retries in the current snapshot survive.
  delete result.automaticRetries;
  return result;
}

/** A worker cannot rewrite unrelated audio/captions or replace a frozen music bed. */
export function withoutRemovedSlots(cp: PackagingCheckpoint, slotIds: readonly string[]): PackagingCheckpoint {
  const lines = new Set((cp.script ?? []).filter((line) => slotIds.includes(line.slotId ?? '')).map((line) => line.id));
  const captions = new Set((cp.captions ?? []).filter((caption) =>
    slotIds.includes(caption.sourceSlotId ?? '') ||
    lines.has(caption.voiceLineId ?? caption.id)).map((caption) => caption.id));
  const result = withoutChangedSlots(cp, slotIds);
  result.captions = (result.captions ?? []).filter((caption) => !captions.has(caption.id));
  for (const field of ['captionBoxes', 'captionVoices'] as const)
    result[field] = Object.fromEntries(Object.entries(result[field] ?? {})
      .filter(([id]) => !lines.has(id) && !captions.has(id))) as never;
  return result;
}

/** Retain explicit holes, absolute positions and the old end even if all media is removed. */
export function clearRemovedSourceSlots(variant: EffectTemplateMixVariant, cp: PackagingCheckpoint,
  slotIds: readonly string[]): EffectTemplateMixVariant {
  const result = structuredClone(variant);
  result.preservedTimelineEnd = effectTemplateMixContentDuration(variant, cp);
  result.intentionallyEmptySlotIds = [...new Set([...(result.intentionallyEmptySlotIds ?? []), ...slotIds])];
  const lines = (cp.script ?? []).filter((line) => slotIds.includes(line.slotId ?? ''));
  const detached = (result.detachedAudios ?? []).filter((audio) => {
    if (audio.sourceSlotId) return slotIds.includes(audio.sourceSlotId);
    if (audio.audioKind !== 'VOICE') return false;
    // Historical split voices can be linked only by an exact, unique saved voice identity.
    const owners = (cp.script ?? []).filter((line) => cp.voices?.[line.id]?.fileObjectId === audio.fileObjectId);
    return owners.length === 1 && lines.some((line) => line.id === owners[0]!.id);
  });
  for (const slotId of slotIds) {
    delete result.bindings[slotId];
    delete result.bindingRevisions[slotId];
    delete result.bindingSources?.[slotId];
    delete result.offsets[slotId];
    delete result.bindingMetadata?.[slotId];
  }
  for (const id of [...detached.map((audio) => `detached:${audio.id}`), ...lines.map((line) => `voice:${line.id}`)])
    delete result.audioLanes?.[id];
  result.manualSlotIds = result.manualSlotIds.filter((id) => !slotIds.includes(id));
  result.conflictSlotIds = result.conflictSlotIds.filter((id) => !slotIds.includes(id));
  result.detachedAudios = (result.detachedAudios ?? []).filter((audio) => !detached.some((removed) => removed.id === audio.id));
  const removedCaptionIds = new Set((cp.captions ?? []).filter((caption) =>
    slotIds.includes(caption.sourceSlotId ?? '') ||
    lines.some((line) => line.id === (caption.voiceLineId ?? caption.id))).map((caption) => caption.id));
  result.captions = result.captions.filter((caption) => !removedCaptionIds.has(caption.id) &&
    !slotIds.includes(caption.sourceSlotId ?? ''));
  for (const id of removedCaptionIds) delete result.audioLanes?.[`capvoice:${id}`];
  return result;
}

export function assertRefreshPreservesContent(
  snapshot: FinalOutputSnapshot,
  cp: PackagingCheckpoint,
): void {
  const refresh = snapshot.sourceRefresh;
  if (!refresh) throw new ConflictException('当前任务不是素材局部更新');
  const slotIds = refresh.slots.map((row) => row.slotId);
  const removed = refresh.removedSlotIds ?? [];
  const before = withoutChangedSlots(withoutRemovedSlots(refresh.baselinePackaging, removed), slotIds);
  const after = withoutChangedSlots(cp, slotIds);
  const removedLines = new Set((refresh.baselinePackaging.script ?? [])
    .filter((line) => removed.includes(line.slotId ?? '')).map((line) => line.id));
  if ((cp.script ?? []).some((line) => removed.includes(line.slotId ?? '')) ||
    Object.keys(cp.voices ?? {}).some((id) => removedLines.has(id)) ||
    (cp.captions ?? []).some((caption) => removed.includes(caption.sourceSlotId ?? '') ||
      removedLines.has(caption.voiceLineId ?? caption.id)))
    throw new ConflictException('已删除素材的口播和字幕不能重新写回');
  const ordered = (value: unknown) =>
    Array.isArray(value)
      ? [...value].sort((a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id))
      : (value ?? null);
  for (const field of [
    'script',
    'voices',
    'captions',
    'captionFontSize',
    'captionBoxes',
    'captionVoices',
    'music',
  ] as const)
    if (workflowStateHash(ordered(before[field])) !== workflowStateHash(ordered(after[field])))
      throw new ConflictException('局部更新不能修改未受影响的口播、字幕或音乐');
  const uploaded = new Map(
    Object.values(refresh.uploadedAudios ?? {}).map((row) => [row.fileObjectId, row]),
  );
  for (const line of cp.script ?? []) {
    if (!slotIds.includes(line.slotId ?? '')) continue;
    const voice = cp.voices?.[line.id];
    if (!voice) continue;
    const actual = uploaded.get(voice.fileObjectId);
    if (
      !actual ||
      Math.abs(actual.duration - voice.duration) > 0.001 ||
      workflowStateHash(actual.segmentFrames ?? []) !== workflowStateHash(voice.segmentFrames ?? []) ||
      workflowStateHash(actual.speechRanges ?? []) !== workflowStateHash(voice.speechRanges ?? [])
    )
      throw new ConflictException('局部更新音频不属于本任务或真实时长不一致');
  }
}

/** Validate newly generated slots strictly without reinstating unrelated user-deleted captions/audio. */
export function validateRefreshCheckpoint(
  snapshot: FinalOutputSnapshot,
  cp: PackagingCheckpoint,
  ready: boolean,
) {
  assertRefreshPreservesContent(snapshot, cp);
  const changed = new Set(snapshot.sourceRefresh!.slots.map((row) => row.slotId));
  const partial = withoutChangedSlots(
    cp,
    snapshot.timeline.clips.filter((clip) => !changed.has(clip.slotId)).map((clip) => clip.slotId),
  );
  delete partial.music;
  // Manual captions are preserved verbatim above; they are editor content, not new worker output.
  if (partial.captions) partial.captions = partial.captions.filter((caption) => !caption.manual);
  validatePackagingCheckpoint(
    {
      ...snapshot.timeline,
      clips: snapshot.timeline.clips.filter((clip) => changed.has(clip.slotId)),
    },
    partial,
    ready,
    false,
  );
}
