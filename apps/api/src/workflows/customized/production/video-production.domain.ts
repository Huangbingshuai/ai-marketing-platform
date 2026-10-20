import { createHash } from 'node:crypto';
import {
  buildVideoSourceUnits,
  isProductionDocument,
  isVideoDocument,
  isVideoDurationPolicy,
  isVideoAudit,
  isVideoPlan,
  isProductionAsset,
  productionShots,
  videoClipShots,
  videoCueText,
  type ProductionDocument,
  type ProductionInput,
  type ProductionVideoDocument,
  type VideoAudit,
  type VideoEvidence,
  type VideoPlan,
  type VideoDurationPolicy,
  isProductionClipPrompt,
  validateClipPromptReferences,
  validatePromptAuditEvidence,
  validateVideoShotDurationStep,
  type ProductionClipPrompt,
} from '@ai-marketing/contracts';

const canonical = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(canonical)
    : v && typeof v === 'object'
      ? Object.fromEntries(
          Object.entries(v)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([k, v]) => [k, canonical(v)]),
        )
      : v;
export const videoHash = (v: unknown) =>
  createHash('sha256')
    .update(JSON.stringify(canonical(v)))
    .digest('hex');
export function validateVideoSnapshot(document: unknown, input: ProductionInput): string | null {
  if (!isProductionDocument(document) || !isVideoDocument(document))
    return '新版制作结果结构不完整';
  const p = document.videoPlan;
  if (input.operation === 'SHOTS') {
    const durationIssue = validateVideoShotDurationStep(p, input.shotDurationStepMs);
    if (durationIssue) return durationIssue;
  }
  if (videoHash(document.assets) !== videoHash(input.document.assets))
    return '分镜不能修改已确认的资产目录';
  if (
    videoHash(p.sourceUnits) !== videoHash(input.sourceUnits) ||
    videoHash(p.sources) !== videoHash(input.sources) ||
    videoHash(p.durationPolicy) !== videoHash(input.durationPolicy) ||
    videoHash(p.capability) !== videoHash(input.renderCapability)
  )
    return '制作结果不匹配冻结的来源、时长政策或能力';
  const original = input.script.story?.content ?? input.script.synopsis;
  if (videoHash(p.sourceUnits) !== videoHash(buildVideoSourceUnits(original)))
    return '制作原文索引不匹配已确认脚本';
  return null;
}
export function mergeVideoSection(
  current: ProductionDocument,
  incoming: ProductionDocument,
  section: 'ASSETS' | 'SHOTS',
): ProductionDocument {
  if (section === 'SHOTS') return { ...incoming, assets: current.assets };
  if (isVideoDocument(current)) return { ...current, assets: incoming.assets };
  return {
    assets: incoming.assets,
    shots: current.shots.map((s) => ({
      ...s,
      bindings: (
        productionShots(incoming).find((v) => v.id === s.id)?.bindings ?? s.bindings
      ).filter((b) => incoming.assets.some((a) => a.id === b.assetId)),
    })),
  };
}
export function videoEvidenceValue(
  plan: VideoPlan,
  e: VideoEvidence,
  prompt?: ProductionClipPrompt,
): string | null {
  if (e.entity === 'PROMPT')
    return prompt && e.id === prompt.target.id && e.field === 'content'
      ? prompt.content
      : prompt && e.id === prompt.target.id && e.field === 'assetIds'
        ? prompt.assetIds.join('、')
        : null;
  const collections = {
    SHOT: plan.shots,
    CLIP: plan.clips,
    SCENE: plan.scenes,
    CUE: plan.cues,
    EVENT: plan.events,
    SOURCE: plan.sourceUnits,
  };
  const item =
    e.entity === 'TIMING' ? plan.timing : collections[e.entity]?.find((x) => x.id === e.id);
  if (!item || !Object.hasOwn(item, e.field)) return null;
  const value = (item as unknown as Record<string, unknown>)[e.field];
  if (e.entity === 'CUE' && e.field === 'sourceRef') {
    const cue = plan.cues.find((x) => x.id === e.id);
    return cue ? videoCueText(plan, cue) : null;
  }
  if (Array.isArray(value))
    return value.map((v) => (typeof v === 'string' ? v : JSON.stringify(v))).join('；');
  return typeof value === 'string'
    ? value
    : typeof value === 'number'
      ? String(value)
      : JSON.stringify(value);
}
export function validateVideoAudit(
  audit: VideoAudit,
  plan: VideoPlan,
  previous?: VideoAudit,
  prompt?: ProductionClipPrompt,
): string | null {
  if (!isVideoAudit(audit)) return '审校结果结构不完整';
  if (new Set(audit.findings.map((f) => f.id)).size !== audit.findings.length)
    return '审校问题身份重复';
  for (const f of audit.findings) {
    if (
      !['ERROR', 'WARNING'].includes(f.severity) ||
      !f.evidence?.length ||
      !f.title?.trim() ||
      !f.impact?.trim() ||
      f.evidence.some((e) => videoEvidenceValue(plan, e, prompt) === null) ||
      f.affectedShotIds.some((id) => !plan.shots.some((s) => s.id === id)) ||
      f.affectedClipIds.some((id) => !plan.clips.some((c) => c.id === id))
    )
      return '审校必须引用当前实际内容';
  }
  const errors = previous?.findings.filter((f) => f.severity === 'ERROR') ?? [];
  if (!previous && audit.resolutions.length) return '首次审校不能虚构旧问题处理记录';
  if (
    previous &&
    (audit.resolutions.length !== errors.length ||
      new Set(audit.resolutions.map((r) => r.issueId)).size !== errors.length ||
      audit.resolutions.some(
        (r) =>
          !errors.some((f) => f.id === r.issueId) ||
          !['RESOLVED', 'PARTIAL', 'UNRESOLVED'].includes(r.status) ||
          !r.evidence?.length ||
          r.evidence.some((e) => videoEvidenceValue(plan, e, prompt) === null),
      ))
  )
    return '复核必须逐条核对原问题和当前证据';
  if (previous && audit.severityChanges !== undefined) {
    const old = new Map(previous.findings.map((f) => [f.id, f]));
    const changed = audit.findings.filter(
      (f) => old.has(f.id) && old.get(f.id)!.severity !== f.severity,
    );
    if (
      new Set(audit.severityChanges.map((c) => c.issueId)).size !== changed.length ||
      audit.severityChanges.length !== changed.length
    )
      return '定级变化必须逐项关联原问题';
    for (const change of audit.severityChanges) {
      const source = old.get(change.issueId),
        current = changed.find((f) => f.id === change.issueId);
      if (
        !source ||
        !current ||
        source.severity !== change.fromSeverity ||
        current.severity !== change.toSeverity ||
        !change.explanation.trim() ||
        change.evidence.some((e) => videoEvidenceValue(plan, e, prompt) === null)
      )
        return '定级变化必须说明原级别、新级别和当前证据';
    }
  }
  return null;
}
export function validateFinalClipPrompt(
  output: unknown,
  input: ProductionInput,
  saved: Record<string, unknown>,
): string | null {
  if (
    !isVideoDocument(input.document) ||
    !isProductionClipPrompt(output, input.document.videoPlan) ||
    output.target.id !== input.target?.id
  )
    return '片段提示词目标或引用不匹配';
  if (input.promptWorkflowVersion === 2 || input.promptWorkflowVersion === 3) {
    const referenceIssue = validateClipPromptReferences(output, input.document);
    if (referenceIssue) return referenceIssue;
  }
  if ((saved.recheck ? saved.recheckHash : saved.auditHash) !== videoHash(output))
    return '提示词审校结果不属于当前候选';
  const audit = (saved.recheck ?? saved.audit) as VideoAudit;
  if (input.promptWorkflowVersion === 3) {
    const quoteIssue = validatePromptAuditEvidence(audit, output);
    if (quoteIssue) return quoteIssue;
  }
  const issue = validateVideoAudit(
    audit,
    input.document.videoPlan,
    saved.recheck ? (saved.audit as VideoAudit) : undefined,
    output,
  );
  if (issue) return issue;
  if (
    audit.findings.some((f) => f.severity === 'ERROR') ||
    audit.resolutions.some((r) => r.status !== 'RESOLVED')
  )
    return '提示词仍有未解决的问题';
  return null;
}
export function validateFinalVideo(
  output: unknown,
  input: ProductionInput,
  saved: Record<string, unknown>,
): string | null {
  const issue = validateVideoSnapshot(output, input);
  if (issue) return issue;
  const doc = output as ProductionVideoDocument;
  if (
    input.strategyVersion === '2026-10-19-capacity-clips.7' &&
    input.operation === 'SHOTS' &&
    doc.videoPlan.clips.some((clip) => clip.shotIds.length !== 1)
  )
    return '每条视频任务必须对应一条完整分镜，不能包含独立子镜头';
  const audit = (saved.recheck ?? saved.audit) as VideoAudit;
  const reviewHash = saved.recheck ? saved.recheckHash : saved.auditHash;
  if (reviewHash !== videoHash(doc.videoPlan)) return '审校结果不属于当前采用稿';
  const reviewIssue = validateVideoAudit(
    audit,
    doc.videoPlan,
    saved.recheck ? (saved.audit as VideoAudit) : undefined,
  );
  if (reviewIssue) return reviewIssue;
  if (
    saved.recheck &&
    [
      '2026-10-19-capacity-clips.4',
      '2026-10-19-capacity-clips.5',
      '2026-10-19-capacity-clips.6',
      '2026-10-19-capacity-clips.7',
    ].includes(input.strategyVersion ?? '')
  ) {
    if (!Array.isArray(audit.severityChanges)) return '缺少本次复核的定级变化记录';
    const original = candidateDocument({ value: saved.value });
    if (!original) return '缺少首次审校的实际候选';
    for (const change of audit.severityChanges) {
      if (
        change.reason === 'NEW_EVIDENCE' &&
        change.evidence.every(
          (e) => videoEvidenceValue(original.videoPlan, e) === videoEvidenceValue(doc.videoPlan, e),
        )
      )
        return '未变化的证据不能作为新证据改变定级';
    }
  }
  if (
    audit.findings.some((f) => f.severity === 'ERROR') ||
    audit.resolutions.some((r) => r.status !== 'RESOLVED')
  )
    return '仍有必须处理的审校问题';
  return null;
}
export function normalizeVideoPolicy(value: unknown, reference: number): VideoDurationPolicy {
  if (value !== undefined && !isVideoDurationPolicy(value))
    throw new Error('请选择有效的参考或固定时长');
  return (
    (value as VideoDurationPolicy) ?? {
      mode: 'REFERENCE',
      seconds: Math.max(1, Math.min(3600, reference || 30)),
    }
  );
}
/** Local clip input fingerprint excludes global numbering and unrelated clips. */
export function clipPayload(document: ProductionVideoDocument, clipId: string) {
  const plan = document.videoPlan,
    clip = plan.clips.find((c) => c.id === clipId);
  if (!clip) throw new Error('视频片段不存在');
  return {
    schemaVersion: 2,
    clip,
    scene: plan.scenes.find((s) => s.id === clip.sceneId),
    shots: videoClipShots(plan, clip),
    cues: plan.cues
      .filter((c) => c.parts.some((p) => clip.shotIds.includes(p.shotId)))
      .map((c) => ({
        ...c,
        text: videoCueText(plan, c),
        parts: c.parts.filter((p) => clip.shotIds.includes(p.shotId)),
      })),
    capability: plan.capability,
  };
}
export function candidateDocument(
  saved: Record<string, unknown> | null,
): ProductionVideoDocument | null {
  for (const v of [saved?.revised, saved?.value, saved?.final])
    if (isProductionDocument(v) && isVideoDocument(v)) return v;
  return null;
}
export function candidateForPreview(
  saved: Record<string, unknown> | null,
): ProductionVideoDocument | null {
  for (const value of [saved?.revised, saved?.value, saved?.final]) {
    const v = value as Partial<ProductionVideoDocument> | undefined;
    if (
      v?.schemaVersion === 2 &&
      Array.isArray(v.assets) &&
      v.assets.every(isProductionAsset) &&
      isVideoPlan(v.videoPlan)
    )
      return v as ProductionVideoDocument;
  }
  return null;
}
