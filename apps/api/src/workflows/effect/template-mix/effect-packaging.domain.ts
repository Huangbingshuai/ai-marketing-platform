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
      if (
        !line ||
        !audio ||
        audio.start !== line.start ||
        !interval(audio.start, audio.start + audio.duration) ||
        audio.start + audio.duration > limit + 0.001 ||
        !Number.isFinite(audio.volume) ||
        audio.volume < 0 ||
        audio.volume > 1
      )
        fail();
    }
  if (
    checkpoint.music &&
    (!interval(checkpoint.music.start, checkpoint.music.start + checkpoint.music.duration) ||
      checkpoint.music.start !== 0 ||
      Math.abs(checkpoint.music.duration - snapshot.duration) > 0.05 ||
      !Number.isFinite(checkpoint.music.volume) ||
      checkpoint.music.volume < 0 ||
      checkpoint.music.volume > 0.3)
  )
    fail();
  if (checkpoint.captions) {
    if (!Array.isArray(checkpoint.captions)) fail();
    if (new Set(checkpoint.captions.map((c) => c.id)).size !== checkpoint.captions.length) fail();
    for (const c of checkpoint.captions) {
      const script = checkpoint.script?.find((s) => s.id === c.id),
        audio = checkpoint.voices?.[c.id];
      if (
        !script ||
        !audio ||
        c.text !== script.text ||
        c.start !== audio.start ||
        Math.abs(c.end - c.start - audio.duration) > 0.002 ||
        !interval(c.start, c.end)
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
