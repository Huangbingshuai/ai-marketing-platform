import type { ProductionAsset, ProductionShot } from './customized-production';

export const CUSTOMIZED_VIDEO_STRATEGY = '2026-10-19-capacity-clips.7' as const;
export const CUSTOMIZED_VIDEO_LIMITS = {
  maxSourceCharacters: 40000,
  maxModelInputCharacters: 120000,
  maxBatches: 60,
  maxClips: 120,
  maxShots: 500,
  maxBatchSeconds: 30,
} as const;
export type VideoRequestLimits = { [K in keyof typeof CUSTOMIZED_VIDEO_LIMITS]: number };
export type VideoDurationPolicy = { mode: 'REFERENCE' | 'FIXED'; seconds: number };
export type VideoSourceUnit = {
  id: string;
  text: string;
  start: number;
  end: number;
  kind: 'TEXT' | 'VOICE' | 'ON_SCREEN_TEXT';
  speaker: string;
};
export type VideoSourceRef = { unitId: string; start: number; end: number };
export type VideoEvent = { id: string; description: string; sourceRefs: VideoSourceRef[] };
export type VideoScene = {
  id: string;
  name: string;
  sceneAssetId: string;
  setting: string;
  spatialBaseline: string;
};
export type VideoClip = {
  id: string;
  title: string;
  sceneId: string;
  shotIds: string[];
  transition: string;
  startState: string;
  endState: string;
};
export type VideoShot = Omit<ProductionShot, 'dialogue'> & {
  information: string;
  framing: string;
  angle: string;
  startState: string;
  endState: string;
  sourceEventIds: string[];
};
export type VideoCue = {
  id: string;
  kind: 'DIALOGUE' | 'VO' | 'OS' | 'ANNOUNCEMENT' | 'ON_SCREEN_TEXT';
  speaker: string;
  sourceRef: VideoSourceRef;
  parts: { shotId: string; startMs: number; endMs: number; textStart: number; textEnd: number }[];
};
export type VideoCapability = {
  key: string;
  status: 'CONFIGURED' | 'PENDING_MODEL_CHECK';
  minClipMs: number;
  maxClipMs: number;
  version: string;
};
export type VideoPlan = {
  durationPolicy: VideoDurationPolicy;
  timing: { explanation: string; estimatedSpeechSeconds: number; uncertainty: string };
  capability: VideoCapability;
  sourceUnits: VideoSourceUnit[];
  sources: { id: string; revision: number; hash: string }[];
  events: VideoEvent[];
  scenes: VideoScene[];
  clips: VideoClip[];
  shots: VideoShot[];
  cues: VideoCue[];
};
export type ProductionVideoDocument = {
  schemaVersion: 2;
  assets: ProductionAsset[];
  videoPlan: VideoPlan;
};
export type ProductionClipPrompt = {
  target: { kind: 'CLIP'; id: string };
  content: string;
  assetIds: string[];
};

export type VideoEvidence = {
  entity: 'SHOT' | 'CLIP' | 'SCENE' | 'CUE' | 'EVENT' | 'SOURCE' | 'TIMING' | 'PROMPT';
  id: string;
  field: string;
};
export type VideoFinding = {
  id: string;
  severity: 'ERROR' | 'WARNING';
  category:
    | 'FACT'
    | 'COVERAGE'
    | 'CAPACITY'
    | 'STATE'
    | 'SPACE'
    | 'SHOT_STRUCTURE'
    | 'BINDING'
    | 'CAPABILITY';
  title: string;
  impact: string;
  evidence: VideoEvidence[];
  affectedShotIds: string[];
  affectedClipIds: string[];
  suggestedFix: string;
  repairKind: 'FIELDS' | 'STRUCTURE' | 'INPUT';
};
export type VideoAudit = {
  summary: string;
  checks: { dimension: string; conclusion: string }[];
  findings: VideoFinding[];
  resolutions: {
    issueId: string;
    status: 'RESOLVED' | 'PARTIAL' | 'UNRESOLVED';
    evidence: VideoEvidence[];
    explanation: string;
  }[];
  severityChanges?: VideoSeverityChange[];
  promptEvidence?: { issueId: string; excerpt: string }[];
};
export type VideoSeverityChange = {
  issueId: string;
  fromSeverity: 'ERROR' | 'WARNING';
  toSeverity: 'ERROR' | 'WARNING';
  reason: 'NEW_EVIDENCE' | 'INITIAL_REVIEW_CORRECTION';
  explanation: string;
  evidence: VideoEvidence[];
};
export type VideoScopedAudit = VideoAudit & { severityChanges: VideoSeverityChange[] };
export function validatePromptAuditEvidence(
  audit: VideoAudit,
  prompt: ProductionClipPrompt,
): string | null {
  if (!Array.isArray(audit.promptEvidence) || audit.promptEvidence.length > 100)
    return '缺少当前提示词问题的原句依据';
  const seen = new Set<string>();
  for (const quote of audit.promptEvidence) {
    if (
      !quote ||
      typeof quote.issueId !== 'string' ||
      seen.has(quote.issueId) ||
      !audit.findings.some((f) => f.id === quote.issueId) ||
      typeof quote.excerpt !== 'string' ||
      !quote.excerpt.trim() ||
      Array.from(quote.excerpt).length > 2000 ||
      !prompt.content.includes(quote.excerpt)
    )
      return '审校问题的原句必须来自当前提示词，不能引用上游描述或虚构引文';
    seen.add(quote.issueId);
  }
  return audit.findings.some((f) => f.repairKind !== 'INPUT' && !seen.has(f.id))
    ? '提示词问题缺少当前正文的具体原句'
    : null;
}
export const VIDEO_REVIEW_DIMENSIONS = [
  '原稿兑现',
  '时间容量',
  '镜头表达',
  '产品事实',
  '动作与空间',
  '素材绑定',
  '模型能力',
] as const;
export type VideoCandidate = {
  document: ProductionVideoDocument;
  candidateHash: string;
  adopted: boolean;
  validForDraft: boolean;
  originalDocument?: ProductionVideoDocument;
  issues: VideoFinding[];
};

export function isVideoAudit(value: unknown): value is VideoAudit {
  if (
    !record(value) ||
    !text(value.summary) ||
    !list(value.checks, 20) ||
    !list(value.findings, 100) ||
    !list(value.resolutions, 100)
  )
    return false;
  const evidence = (v: unknown) =>
    list(v, 30) &&
    v.length > 0 &&
    v.every(
      (e) =>
        record(e) &&
        ['SHOT', 'CLIP', 'SCENE', 'CUE', 'EVENT', 'SOURCE', 'TIMING', 'PROMPT'].includes(
          String(e.entity),
        ) &&
        id(e.id) &&
        id(e.field),
    );
  if (
    value.checks.length !== VIDEO_REVIEW_DIMENSIONS.length ||
    new Set(value.checks.map((c) => (record(c) ? c.dimension : null))).size !==
      VIDEO_REVIEW_DIMENSIONS.length ||
    !value.checks.every(
      (c) => record(c) && (VIDEO_REVIEW_DIMENSIONS as readonly unknown[]).includes(c.dimension),
    )
  )
    return false;
  return (
    (value.promptEvidence === undefined ||
      (list(value.promptEvidence, 100) &&
        value.promptEvidence.every(
          (q) => record(q) && id(q.issueId) && text(q.excerpt, 2000) && !!q.excerpt.trim(),
        ))) &&
    (value.severityChanges === undefined ||
      (list(value.severityChanges, 100) &&
        value.severityChanges.every(
          (c) =>
            record(c) &&
            id(c.issueId) &&
            ['ERROR', 'WARNING'].includes(String(c.fromSeverity)) &&
            ['ERROR', 'WARNING'].includes(String(c.toSeverity)) &&
            ['NEW_EVIDENCE', 'INITIAL_REVIEW_CORRECTION'].includes(String(c.reason)) &&
            typeof c.explanation === 'string' &&
            !!c.explanation.trim() &&
            c.explanation.length <= 1000 &&
            evidence(c.evidence),
        ))) &&
    value.checks.every((c) => record(c) && text(c.dimension, 200) && text(c.conclusion)) &&
    value.findings.every(
      (f) =>
        record(f) &&
        id(f.id) &&
        ['ERROR', 'WARNING'].includes(String(f.severity)) &&
        [
          'FACT',
          'COVERAGE',
          'CAPACITY',
          'STATE',
          'SPACE',
          'SHOT_STRUCTURE',
          'BINDING',
          'CAPABILITY',
        ].includes(String(f.category)) &&
        id(f.title) &&
        text(f.impact) &&
        evidence(f.evidence) &&
        ids(f.affectedShotIds) &&
        ids(f.affectedClipIds, 500) &&
        text(f.suggestedFix) &&
        ['FIELDS', 'STRUCTURE', 'INPUT'].includes(String(f.repairKind)),
    ) &&
    value.resolutions.every(
      (r) =>
        record(r) &&
        id(r.issueId) &&
        ['RESOLVED', 'PARTIAL', 'UNRESOLVED'].includes(String(r.status)) &&
        evidence(r.evidence) &&
        text(r.explanation),
    )
  );
}

const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown, max = 20000): v is string => typeof v === 'string' && v.length <= max;
const id = (v: unknown): v is string => text(v, 200) && !!v.trim();
const list = (v: unknown, max: number): v is unknown[] => Array.isArray(v) && v.length <= max;
const integer = (v: unknown, min = 0, max = 3_600_000): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
const ids = (v: unknown, max = 1000): v is string[] =>
  list(v, max) && v.every(id) && new Set(v).size === v.length;
const unique = (v: { id: string }[]) => new Set(v.map((x) => x.id)).size === v.length;
export const videoMilliseconds = (seconds: number) => Math.round(seconds * 1000);
export const videoTotalMs = (plan: Pick<VideoPlan, 'shots'>) =>
  plan.shots.reduce((n, s) => n + videoMilliseconds(s.durationSeconds), 0);
/** Frozen AI-generation rule only; historical/manual plans keep their existing precision. */
export function validateVideoShotDurationStep(
  plan: Pick<VideoPlan, 'shots'>,
  stepMs: unknown,
): string | null {
  if (stepMs === undefined) return null;
  if (stepMs !== 1000) return '不支持的分镜时长步长';
  return plan.shots.some((s) => !Number.isInteger(s.durationSeconds))
    ? '本次生成的完整分镜时长必须为整数秒，声音与文字落点可保留毫秒'
    : null;
}
export const videoClipShots = (plan: VideoPlan, clip: VideoClip) =>
  clip.shotIds.map((id) => plan.shots.find((s) => s.id === id)!).filter(Boolean);
export const videoClipMs = (plan: VideoPlan, clip: VideoClip) =>
  videoClipShots(plan, clip).reduce((n, s) => n + videoMilliseconds(s.durationSeconds), 0);
export const videoClipAssetIds = (plan: VideoPlan, clip: VideoClip) => [
  ...new Set(videoClipShots(plan, clip).flatMap((s) => s.bindings.map((b) => b.assetId))),
];
export const videoCueText = (plan: VideoPlan, cue: VideoCue) => {
  const unit = plan.sourceUnits.find((u) => u.id === cue.sourceRef.unitId);
  return unit ? Array.from(unit.text).slice(cue.sourceRef.start, cue.sourceRef.end).join('') : '';
};

/** Exact paragraph offsets use Unicode code points on both JS and Python sides. Labels are syntax, not inferred semantics. */
export function buildVideoSourceUnits(content: string): VideoSourceUnit[] {
  const units: VideoSourceUnit[] = [];
  const characters = Array.from(content);
  let offset = 0;
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed) {
      const prefix = /^(口播|旁白|对白|台词|OS|VO|播报|画面文字|字幕)[：:]\s*/i.exec(trimmed);
      let body = prefix ? trimmed.slice(prefix[0].length) : trimmed;
      let leading = line.indexOf(trimmed) + (prefix?.[0].length ?? 0);
      if (/^[“「"]/.test(body) && /[”」"]$/.test(body)) {
        body = body.slice(1, -1);
        leading++;
      }
      const start = offset + Array.from(line.slice(0, leading)).length;
      units.push({
        id: `U${String(units.length + 1).padStart(4, '0')}`,
        text: body,
        start,
        end: start + Array.from(body).length,
        kind: prefix ? (/画面文字|字幕/.test(prefix[1]!) ? 'ON_SCREEN_TEXT' : 'VOICE') : 'TEXT',
        speaker: prefix && !/画面文字|字幕/.test(prefix[1]!) ? prefix[1]! : '',
      });
    }
    offset += Array.from(line).length + 1;
  }
  // Guard the index itself; source offsets must always point to exact immutable input.
  if (units.some((u) => characters.slice(u.start, u.end).join('') !== u.text))
    throw new Error('Invalid video source offsets');
  return units;
}

function sourceRef(v: unknown): v is VideoSourceRef {
  return (
    record(v) &&
    id(v.unitId) &&
    integer(v.start, 0, 100000) &&
    integer(v.end, 1, 100000) &&
    v.end > v.start
  );
}
export function isVideoDurationPolicy(v: unknown): v is VideoDurationPolicy {
  return (
    record(v) &&
    ['REFERENCE', 'FIXED'].includes(String(v.mode)) &&
    typeof v.seconds === 'number' &&
    Number.isFinite(v.seconds) &&
    v.seconds >= 1 &&
    v.seconds <= 3600
  );
}
export function isVideoPlan(v: unknown): v is VideoPlan {
  if (
    !record(v) ||
    !isVideoDurationPolicy(v.durationPolicy) ||
    !record(v.timing) ||
    !text(v.timing.explanation) ||
    !text(v.timing.uncertainty) ||
    typeof v.timing.estimatedSpeechSeconds !== 'number' ||
    !Number.isFinite(v.timing.estimatedSpeechSeconds) ||
    v.timing.estimatedSpeechSeconds < 0 ||
    !record(v.capability) ||
    !id(v.capability.key) ||
    !id(v.capability.version) ||
    !['CONFIGURED', 'PENDING_MODEL_CHECK'].includes(String(v.capability.status)) ||
    !integer(v.capability.minClipMs, 1) ||
    !integer(v.capability.maxClipMs, 1) ||
    v.capability.maxClipMs < v.capability.minClipMs
  )
    return false;
  if (
    !list(v.sources, 20) ||
    !v.sources.every((s) => record(s) && id(s.id) && integer(s.revision, 1) && id(s.hash))
  )
    return false;
  if (
    !list(v.sourceUnits, 5000) ||
    !v.sourceUnits.every(
      (u) =>
        record(u) &&
        id(u.id) &&
        text(u.text) &&
        integer(u.start, 0, 1000000) &&
        integer(u.end, 1, 1000000) &&
        u.end > u.start &&
        ['TEXT', 'VOICE', 'ON_SCREEN_TEXT'].includes(String(u.kind)) &&
        text(u.speaker),
    )
  )
    return false;
  if (
    !list(v.events, 1000) ||
    !v.events.every(
      (e) =>
        record(e) &&
        id(e.id) &&
        text(e.description) &&
        list(e.sourceRefs, 100) &&
        e.sourceRefs.length > 0 &&
        e.sourceRefs.every(sourceRef),
    )
  )
    return false;
  if (
    !list(v.scenes, 200) ||
    !v.scenes.length ||
    !v.scenes.every(
      (s) =>
        record(s) &&
        ['id', 'name', 'sceneAssetId'].every((k) => id(s[k])) &&
        ['setting', 'spatialBaseline'].every((k) => text(s[k])),
    )
  )
    return false;
  if (
    !list(v.clips, 500) ||
    !v.clips.length ||
    !v.clips.every(
      (c) =>
        record(c) &&
        id(c.id) &&
        id(c.sceneId) &&
        ids(c.shotIds, 500) &&
        c.shotIds.length > 0 &&
        ['title', 'transition', 'startState', 'endState'].every((k) => text(c[k])),
    )
  )
    return false;
  if (
    !list(v.shots, 1000) ||
    !v.shots.length ||
    !v.shots.every(
      (s) =>
        record(s) &&
        id(s.id) &&
        !Object.hasOwn(s, 'dialogue') &&
        [
          'title',
          'shotType',
          'cameraMovement',
          'visual',
          'audio',
          'atmosphere',
          'information',
          'framing',
          'angle',
          'startState',
          'endState',
        ].every((k) => text(s[k])) &&
        typeof s.durationSeconds === 'number' &&
        Number.isFinite(s.durationSeconds) &&
        s.durationSeconds >= 0.001 &&
        s.durationSeconds <= 3600 &&
        Math.abs(s.durationSeconds * 1000 - Math.round(s.durationSeconds * 1000)) < 1e-6 &&
        ids(s.sourceEventIds) &&
        list(s.bindings, 100) &&
        s.bindings.every((b) => record(b) && id(b.assetId) && text(b.description)),
    )
  )
    return false;
  if (
    !list(v.cues, 2000) ||
    !v.cues.every(
      (c) =>
        record(c) &&
        id(c.id) &&
        ['DIALOGUE', 'VO', 'OS', 'ANNOUNCEMENT', 'ON_SCREEN_TEXT'].includes(String(c.kind)) &&
        text(c.speaker) &&
        sourceRef(c.sourceRef) &&
        list(c.parts, 1000) &&
        c.parts.length > 0 &&
        c.parts.every(
          (p) =>
            record(p) &&
            id(p.shotId) &&
            integer(p.startMs) &&
            integer(p.endMs, 1) &&
            p.endMs > p.startMs &&
            integer(p.textStart, 0, 100000) &&
            integer(p.textEnd, 1, 100000) &&
            p.textEnd > p.textStart,
        ),
    )
  )
    return false;
  return [v.sourceUnits, v.events, v.scenes, v.clips, v.shots, v.cues].every((a) =>
    unique(a as { id: string }[]),
  );
}

/** Mechanical consistency only. Semantic capacity, continuity and creative quality remain independent AI checks. */
export function validateVideoPlan(
  plan: VideoPlan,
  assets: ProductionAsset[],
  allowIncomplete = false,
): string | null {
  if (!isVideoPlan(plan)) return '制作计划结构不完整';
  const objectIds = new Set(assets.map((a) => a.id));
  const sceneIds = new Set(plan.scenes.map((s) => s.id));
  const shotIds = new Set(plan.shots.map((s) => s.id));
  const eventIds = new Set(plan.events.map((s) => s.id));
  const refValid = (r: VideoSourceRef) => {
    const u = plan.sourceUnits.find((u) => u.id === r.unitId);
    return !!u && r.end <= Array.from(u.text).length;
  };
  if (plan.events.some((e) => e.sourceRefs.some((r) => !refValid(r))))
    return '事件引用的原文范围不正确';
  if (plan.scenes.some((s) => !assets.some((a) => a.id === s.sceneAssetId && a.kind === 'SCENE')))
    return '场次必须引用当前目录的真实场景';
  const ordered = plan.clips.flatMap((c) => c.shotIds);
  if (
    ordered.length !== plan.shots.length ||
    new Set(ordered).size !== ordered.length ||
    ordered.some((s) => !shotIds.has(s)) ||
    plan.clips.some((c) => !sceneIds.has(c.sceneId))
  )
    return '片段与镜头归属不完整或重复';
  if (
    plan.shots.some(
      (s) =>
        !s.visual.trim() ||
        !s.information.trim() ||
        !s.startState.trim() ||
        !s.endState.trim() ||
        new Set(s.bindings.map((b) => b.assetId)).size !== s.bindings.length ||
        s.bindings.some((b) => !objectIds.has(b.assetId)) ||
        s.sourceEventIds.some((id) => !eventIds.has(id)),
    )
  )
    return '镜头画面、状态、事件或对象引用不完整';
  if (
    !allowIncomplete &&
    plan.events.some((e) => !plan.shots.some((s) => s.sourceEventIds.includes(e.id)))
  )
    return '有原稿事件尚未安排到镜头';
  if (
    plan.clips.some(
      (c) =>
        videoClipMs(plan, c) < plan.capability.minClipMs ||
        videoClipMs(plan, c) > plan.capability.maxClipMs,
    )
  )
    return '片段时长超出本次制作能力范围';
  if (
    plan.durationPolicy.mode === 'FIXED' &&
    Math.abs(videoTotalMs(plan) - videoMilliseconds(plan.durationPolicy.seconds)) > 1000
  )
    return '制作总时长不符合固定时长要求';
  for (const cue of plan.cues) {
    if (!refValid(cue.sourceRef)) return '声音或画面文字的原文范围不正确';
    const length = cue.sourceRef.end - cue.sourceRef.start;
    const spans: [number, number][] = [];
    let previousOrder = -1,
      previousEndMs = 0;
    for (const p of cue.parts) {
      const shot = plan.shots.find((s) => s.id === p.shotId);
      if (!shot || p.endMs > videoMilliseconds(shot.durationSeconds) || p.textEnd > length)
        return '声音或文字超出当前镜头/原文范围';
      const currentOrder = ordered.indexOf(p.shotId);
      if (
        currentOrder < previousOrder ||
        (cue.kind !== 'ON_SCREEN_TEXT' &&
          currentOrder === previousOrder &&
          p.startMs < previousEndMs)
      )
        return '同一句声音的时间顺序重叠或倒置';
      previousOrder = currentOrder;
      previousEndMs = p.endMs;
      spans.push([p.textStart, p.textEnd]);
    }
    // On-screen text may intentionally remain across cuts; speech must be partitioned, not repeated.
    if (cue.kind !== 'ON_SCREEN_TEXT') {
      let end = 0;
      for (const [a, b] of spans) {
        if (a !== end) return '同一句声音存在遗漏或重复';
        end = b;
      }
      if (end !== length) return '声音原句没有完整安排';
    } else if (spans.some(([a, b]) => a !== 0 || b !== length)) return '画面文字必须完整保留';
  }
  if (!allowIncomplete)
    for (const u of plan.sourceUnits.filter((u) => u.kind !== 'TEXT')) {
      const ranges = plan.cues
        .filter((c) => c.sourceRef.unitId === u.id)
        .map((c) => c.sourceRef)
        .sort((a, b) => a.start - b.start);
      let end = 0;
      for (const r of ranges) {
        if (r.start !== end) return '明确的原稿声音或画面文字存在遗漏或重复';
        end = r.end;
      }
      if (end !== Array.from(u.text).length) return '明确的原稿声音或画面文字未完整兑现';
    }
  return null;
}

export function isProductionClipPrompt(v: unknown, plan: VideoPlan): v is ProductionClipPrompt {
  if (
    !record(v) ||
    !record(v.target) ||
    v.target.kind !== 'CLIP' ||
    !id(v.target.id) ||
    !text(v.content, 20000) ||
    !v.content.trim() ||
    !ids(v.assetIds, 100)
  )
    return false;
  const targetId = v.target.id;
  const clip = plan.clips.find((c) => c.id === targetId);
  if (!clip) return false;
  const expected = videoClipAssetIds(plan, clip);
  // Historical prompts may list every bound object; new prompts use only actual mentions.
  return v.assetIds.every((id) => expected.includes(id));
}

/** Readable @names resolve only within this clip's bound candidates, longest name first. */
export function videoPromptReferences(
  content: string,
  assets: Pick<ProductionAsset, 'id' | 'name'>[],
) {
  const candidates = [...assets]
    .filter((a) => a.name)
    .sort((a, b) => b.name.length - a.name.length);
  const assetIds: string[] = [],
    unknown: string[] = [];
  for (const match of content.matchAll(/@/g)) {
    const rest = content.slice(match.index! + 1);
    const asset = candidates.find((a) => rest.startsWith(a.name));
    if (asset) {
      if (!assetIds.includes(asset.id)) assetIds.push(asset.id);
    } else unknown.push(rest.split(/[\s@，。；：、！？,;:!?“”"（）()]/, 1)[0] || '@');
  }
  return { assetIds, unknown };
}

export function validateClipPromptReferences(
  prompt: ProductionClipPrompt,
  document: ProductionVideoDocument,
): string | null {
  const clip = document.videoPlan.clips.find((c) => c.id === prompt.target.id);
  if (!clip) return '分镜不存在';
  const allowed = videoClipAssetIds(document.videoPlan, clip);
  const references = videoPromptReferences(
    prompt.content,
    document.assets.filter((a) => allowed.includes(a.id)),
  );
  if (references.unknown.length)
    return '提示词包含无法对应当前分镜素材的 @引用，请使用完整素材名称';
  if (
    references.assetIds.length !== prompt.assetIds.length ||
    references.assetIds.some((id) => !prompt.assetIds.includes(id))
  )
    return '提示词素材必须与正文的 @引用一致';
  return null;
}

/** Read-only legacy-shaped projection for existing asset usage and video placeholder components. */
export function videoShotProjection(plan: VideoPlan, shot: VideoShot): ProductionShot {
  return {
    ...shot,
    dialogue: plan.cues
      .filter((c) => c.kind !== 'ON_SCREEN_TEXT')
      .flatMap((c) =>
        c.parts
          .filter((p) => p.shotId === shot.id)
          .map(
            (p) =>
              `${c.speaker || '声音'}：${Array.from(videoCueText(plan, c)).slice(p.textStart, p.textEnd).join('')}`,
          ),
      )
      .join('\n'),
  };
}
export function videoClipProjection(plan: VideoPlan, clip: VideoClip): ProductionShot {
  const shots = videoClipShots(plan, clip);
  return {
    id: clip.id,
    title: clip.title,
    shotType: shots.map((s) => s.shotType).join(' / '),
    cameraMovement: [...new Set(shots.map((s) => s.cameraMovement).filter(Boolean))].join('；'),
    durationSeconds: videoClipMs(plan, clip) / 1000,
    visual: shots
      .map((s) => s.visual)
      .filter(Boolean)
      .join('\n\n'),
    dialogue: shots
      .map((s) => videoShotProjection(plan, s).dialogue)
      .filter(Boolean)
      .join('\n'),
    audio: shots
      .map((s) => s.audio)
      .filter(Boolean)
      .join('；'),
    atmosphere: shots
      .map((s) => s.atmosphere)
      .filter(Boolean)
      .join('；'),
    bindings: videoClipAssetIds(plan, clip).map((assetId) => ({
      assetId,
      description: shots
        .flatMap((s) => s.bindings.filter((b) => b.assetId === assetId).map((b) => b.description))
        .join('；'),
    })),
  };
}

/** Read-only labels for known technical references; never changes saved review or evidence. */
export function videoReadableText(
  plan: VideoPlan,
  assets: ProductionAsset[],
  value: string,
): string {
  const labels = new Map<string, string>();
  const add = (id: string, label: string, allowShort = false) => {
    labels.set(id, label);
    if (allowShort) {
      const suffix = id.match(/-(b\d+-s\d+|r\d+-s\d+|r\d+-c\d+|q\d+|c\d+|sc\d+|e\d+)$/)?.[1];
      if (suffix) labels.set(suffix, label);
    }
  };
  assets.forEach((asset) => add(asset.id, asset.name));
  plan.shots.forEach((shot) => add(shot.id, `镜头「${shot.title}」`, true));
  plan.clips.forEach((clip) => add(clip.id, `片段「${clip.title}」`, true));
  plan.scenes.forEach((scene) => add(scene.id, `场次「${scene.name}」`, true));
  plan.events.forEach((event, index) => add(event.id, `第${index + 1}项原稿事件`, true));
  plan.cues.forEach((cue, index) =>
    add(
      cue.id,
      cue.kind === 'ON_SCREEN_TEXT' ? `第${index + 1}项画面文字` : `第${index + 1}项原稿声音`,
      true,
    ),
  );
  plan.sourceUnits.forEach((unit, index) => add(unit.id, `第${index + 1}段原文`));
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const keys = [...labels.keys()].filter(Boolean).sort((a, b) => b.length - a.length);
  if (!keys.length) return value;
  return value
    .replace(
      new RegExp(`(?<![A-Za-z0-9_-])(?:${keys.map(escape).join('|')})(?![A-Za-z0-9_-])`, 'g'),
      (match) => labels.get(match) ?? match,
    )
    .replace(/\btextStart\b/g, '原句起点')
    .replace(/\btextEnd\b/g, '原句终点')
    .replace(/\bTEXT_PLAN\b/g, '文字制作计划')
    .replace(/\bPENDING_MODEL_CHECK\b/g, '待实际模型能力核对');
}
