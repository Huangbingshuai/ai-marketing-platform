import { COMMERCE_CREATION_VERSIONS, isPresenterStrategy, validatePresenterDevelopment, validateCommerceDevelopment } from './customized-commerce-creation';
import { validateBrandDevelopment } from './customized-brand-creation';
import { DRAMA_CREATION_VERSIONS, isDramaStrategy, validateDramaDevelopment, validateDramaSelection } from './customized-drama-creation';
import {
  SCRIPT_PLAN_FIELDS,
  SCRIPT_QUALITY_CRITERIA,
  typedScriptStages,
  scriptStageRole,
  isSharedScriptStage,
  validateScriptStructureMapping,
  type TypedScriptStage,
  type ScriptStructureMapping,
  type ScriptQualityCheck,
} from './customized-script-routes';
import type { CustomizedBrief } from './customized-extraction';
import type {
  CustomizedStoryboardDraft,
  CustomizedStoryboardScript,
} from './customized-storyboard';
import { isCustomizedStoryboardScript } from './customized-storyboard';
import { CUSTOMIZED_VIDEO_TYPES } from './customized-storyboard';

export const CUSTOMIZED_STORYBOARD_STAGES = [
  { id: 'SNAPSHOT', label: '信息卡快照', description: '确认本次产品事实与创作约束', weight: 5 },
  { id: 'CONCEPT', label: '多方案构思', description: '探索核心创意与差异化表达', weight: 10 },
  { id: 'STORY', label: '完整脚本创作', description: '按视频类型与结构展开正文', weight: 20 },
  { id: 'ASSETS', label: '资产需求整理', description: '定义人物、产品和场景', weight: 10 },
  { id: 'SHOTS', label: '逐镜脚本创作', description: '把故事细化为连续镜头', weight: 25 },
  { id: 'REVIEW', label: '脚本审校', description: '核对事实、叙事与镜头衔接', weight: 15 },
  { id: 'REPAIR', label: '定向修订', description: '处理具体问题并再次核对', weight: 10 },
  { id: 'SAVE', label: '保存脚本分支', description: '保存独立脚本及制作路径', weight: 5 },
] as const;
export type StoryboardStage =
  (typeof CUSTOMIZED_STORYBOARD_STAGES)[number]['id'] | TypedScriptStage;
export function storyboardStages(
  input: Pick<StoryboardInput, 'graphVersion' | 'routeId' | 'outputMode' | 'strategyVersions'>,
) {
  return input.graphVersion === 'TYPED_CREATION_V1' && input.routeId
    ? typedScriptStages(input.routeId, input.strategyVersions?.concept)
    : CUSTOMIZED_STORYBOARD_STAGES.filter(
        (s) => input.outputMode !== 'STORY_ONLY' || !['ASSETS', 'SHOTS'].includes(s.id),
      );
}
export type StoryboardSettings = CustomizedStoryboardDraft['settings'];
export type StoryboardStatus =
  'QUEUED' | 'RUNNING' | 'COMPLETED' | 'PARTIAL' | 'FAILED' | 'CANCELLED';
export type StoryboardStepStatus = 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'SKIPPED';
export type StoryboardSource = { artifactId: string; revision: number; fingerprint: string };
/** Internal worker completion: only transient model failures request recovery. */
export type StoryboardFinish = { retryable?: boolean; retryScriptIds?: string[] };
export type StoryboardFinding = {
  severity: 'ERROR' | 'WARNING';
  category: 'FACT' | 'STORY' | 'STRUCTURE';
  shotIds: string[];
  beatIds?: string[];
  message: string;
  evidence: string;
  suggestion: string;
};
export type StoryboardReview = {
  summary: string;
  findings: StoryboardFinding[];
  routeId?: NonNullable<StoryboardInput['routeId']>;
  strategyVersions?: NonNullable<StoryboardInput['strategyVersions']>;
  qualityChecks?: ScriptQualityCheck[];
};
export type StoryboardConcept = {
  scriptId: string;
  name: string;
  synopsis: string;
  productFocus: string;
  structure: string;
  difference: string;
  coreIdea?: string;
  openingHook?: string;
  productRole?: string;
  memoryPoint?: string;
};
export type StoryboardStory = {
  title: string;
  structureMapping?: ScriptStructureMapping[];
  content: string;
  opening: string;
  development: string;
  ending: string;
  dialoguePlan: string;
  beats: { id: string; content: string; durationSeconds: number }[];
};
/** Model output: the complete scene text is assembled once into story.content. */
export type StoryboardScreenplayDraft = Omit<StoryboardStory, 'content'>;
export type StoryboardInput = {
  schemaVersion: 1;
  outputMode?: 'STORY_ONLY';
  /** Frozen per task. Absent on historical story/checkpoint executions. */
  storyFormat?: 'SCREENPLAY_V1' | 'VIDEO_SCRIPT_V2' | 'VIDEO_SCRIPT_V3';
  graphVersion?: 'TYPED_CREATION_V1';
  routeId?: NonNullable<StoryboardSettings['videoType']>;
  strategyVersions?: Record<'concept' | 'story' | 'review' | 'repair', string>;
  source: StoryboardSource;
  brief: CustomizedBrief;
  settings: StoryboardSettings;
  scriptIds: string[];
  existingConcepts: { scriptId?: string; name: string; synopsis: string }[];
  models: { creative: string; detail: string };
  brandReferences: unknown[];
};
/** Permanent database deletion; unreferenced objects are cleaned by the durable storage queue. */
export type DeleteStoryboardScriptResult = {
  scriptId: string;
  removedScriptIds: string[];
  removedRunIds: string[];
  fallbackRunId: string;
  activeRunChanged: boolean;
};
export type StoryboardStep = {
  nodeId: StoryboardStage;
  scriptId: string;
  status: StoryboardStepStatus;
  output: unknown;
  errorMessage: string | null;
  updatedAt: string;
};
export type StoryboardTask = {
  graphVersion?: NonNullable<StoryboardInput['graphVersion']>;
  routeId?: NonNullable<StoryboardInput['routeId']>;
  strategyVersions?: NonNullable<StoryboardInput['strategyVersions']>;
  outputMode?: 'STORY_ONLY';
  id: string;
  workflowRunId: string;
  status: StoryboardStatus;
  progress: number;
  steps: Omit<StoryboardStep, 'output'>[];
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
};
export type StoryboardScriptRecord = {
  id: string;
  workflowRunId: string | null;
  source: StoryboardSource;
  status: StoryboardStatus | 'DRAFT';
  origin: 'AI' | 'MANUAL' | 'IMPORT';
  revision: number;
  editing: boolean;
  stale: boolean;
  script: CustomizedStoryboardScript;
  confirmedRevision: number | null;
  taskId: string | null;
};
export type StoryboardWorkspace = {
  sourceRunId: string;
  source: StoryboardSource | null;
  brief: CustomizedBrief | null;
  sourceReady: boolean;
  settings: StoryboardSettings;
  settingsRevision: number;
  scripts: StoryboardScriptRecord[];
  selectedScriptId: string | null;
  task: StoryboardTask | null;
  legacyDraft: CustomizedStoryboardDraft | null;
};
export type StoryboardDetail = {
  nodeId: StoryboardStage;
  status: string;
  summary: string;
  updatedAt: string | null;
  sections: {
    kind: 'INPUT' | 'EXECUTION' | 'OUTPUT';
    title: string;
    items: { title: string; content: string }[];
  }[];
  page: number;
  hasMore: boolean;
};
export function validateStoryboardSettings(value: StoryboardSettings): string | null {
  if (
    !Number.isInteger(value.targetDurationSeconds) ||
    value.targetDurationSeconds < 15 ||
    value.targetDurationSeconds > 180
  )
    return 'AI 创作时长需为 15–180 秒的整数';
  if (!Number.isInteger(value.variantCount) || value.variantCount < 1 || value.variantCount > 5)
    return '每次创作 1–5 份脚本';
  if (value.videoType !== undefined && !CUSTOMIZED_VIDEO_TYPES.includes(value.videoType))
    return '请选择有效的视频类型';
  if (
    value.structureSections !== undefined &&
    (!Array.isArray(value.structureSections) ||
      value.structureSections.length > 20 ||
      value.structureSections.some((s) => typeof s !== 'string' || !s.trim() || s.length > 200))
  )
    return '脚本结构最多 20 段，每段请填写 1–200 字的标题';
  if (
    !['AI', 'REFERENCE', 'CUSTOM'].includes(value.structureMode) ||
    typeof value.structure !== 'string' ||
    typeof value.instructions !== 'string' ||
    value.structure.length > 20000 ||
    value.instructions.length > 20000
  )
    return '创作设置格式不正确';
  if (value.structureMode !== 'AI' && !value.structure.trim() && !value.structureSections?.length)
    return '请填写脚本结构';
  return null;
}
export function validateStoryboardPublication(value: unknown, target?: number): string | null {
  if (!isCustomizedStoryboardScript(value)) return '脚本结构或资产引用不完整';
  if (value.story) {
    if (!value.name.trim() || !value.synopsis.trim() || !value.story.content.trim())
      return '请填写脚本名称、故事概述和完整故事';
    if (
      !value.story.beats.length ||
      new Set(value.story.beats.map((b) => b.id)).size !== value.story.beats.length
    )
      return '故事段落不完整';
    if (
      target !== undefined &&
      Math.abs(value.story.beats.reduce((n, b) => n + b.durationSeconds, 0) - target) > 1.00001
    )
      return '故事总时长与目标偏差超过 1 秒';
    return null;
  }
  if (
    !value.name.trim() ||
    !value.synopsis.trim() ||
    !value.shots.length ||
    value.shots.some((s) => !s.visual.trim() || !s.shotType.trim() || !s.cameraMovement.trim())
  )
    return '请补齐脚本名称、故事概述和镜头内容';
  if (
    value.shots.some(
      (s) =>
        !s.assetRequirements ||
        Object.values(s.assetRequirements).some((g) => g.state === 'UNDEFINED'),
    )
  )
    return '请明确每镜人物、产品和场景需求，无需使用时选择本镜不需要';
  if (!value.shots.some((s) => s.assetRequirements?.products.items.length))
    return '脚本至少需要一个关联产品的镜头';
  if (
    target !== undefined &&
    Math.abs(value.shots.reduce((n, s) => n + s.durationSeconds, 0) - target) > 1.00001
  )
    return '脚本总时长与目标偏差超过 1 秒';
  return null;
}

/** Mechanical screenplay checks only; narrative quality belongs to independent AI review. */
export function validateStoryboardScreenplay(
  story: Pick<StoryboardStory, 'content' | 'beats'>,
): string | null {
  if (
    !story.beats.length ||
    story.content !== story.beats.map((b) => b.content.trim()).join('\n\n')
  )
    return '剧本正文必须完整保留各场次内容';
  for (const [index, beat] of story.beats.entries()) {
    const number = String(index + 1).padStart(2, '0');
    if (
      !new RegExp(
        `^S${number}[｜|](?:内景|外景|内外景) · [^\\n｜|]+[｜|][^\\n]+\\n\\n[\\s\\S]*\\S$`,
      ).test(beat.content.trim())
    )
      return '请提供连续场次标题、场景时间和完整动作正文';
    if (beat.durationSeconds > 60) return '剧本叙事段落不能超过 60 秒';
  }
  return null;
}
/** V2 reference duration is advisory; section identities and complete text are mandatory. */
export function validateStoryboardVideoScript(
  story: Pick<StoryboardStory, 'content' | 'beats'>,
  sections: string[] = [],
): string | null {
  if (
    !story.beats.length ||
    story.content !== story.beats.map((b) => b.content.trim()).join('\n\n')
  )
    return '剧本正文必须完整保留各篇章内容';
  if (sections.length && story.beats.length !== sections.length)
    return '脚本正文须逐段落实指定结构';
  if (story.beats.reduce((n, b) => n + b.durationSeconds, 0) > 3600)
    return '脚本预计时长超过处理上限';
  for (const [i, beat] of story.beats.entries()) {
    const id = `P${String(i + 1).padStart(2, '0')}`;
    const heading = beat.content.trim().split('\n')[0]!;
    if (
      beat.id !== id ||
      !new RegExp(`^${id}[｜|][^\\n]+\\n\\n[\\s\\S]*\\S$`).test(beat.content.trim()) ||
      !(beat.durationSeconds > 0 && beat.durationSeconds <= 3600)
    )
      return '请提供连续篇章编号、标题、正文和有效预计时长';
    if (sections.length && heading.slice(4).trim() !== sections[i]!.trim())
      return '正文篇章顺序与指定脚本结构不一致';
  }
  return null;
}
export function storyboardProgress(
  steps: Pick<StoryboardStep, 'nodeId' | 'scriptId' | 'status'>[],
  scriptIds: string[],
  complete: boolean,
  storyOnly = false,
  graph?: Pick<StoryboardInput, 'graphVersion' | 'routeId' | 'strategyVersions'>,
): number {
  if (complete) return 100;
  const done = (nodeId: string, scriptId: string) =>
    steps.some(
      (s) =>
        s.nodeId === nodeId &&
        s.scriptId === scriptId &&
        ['SUCCEEDED', 'SKIPPED'].includes(s.status),
    );
  return Math.min(
    99,
    Math.floor(
      storyboardStages({
        ...graph,
        ...(storyOnly ? { outputMode: 'STORY_ONLY' as const } : {}),
      }).reduce(
        (total, stage) =>
          total +
          stage.weight *
            (storyOnly && !graph?.graphVersion ? 100 / 65 : 1) *
            (isSharedScriptStage(stage.id)
              ? Number(done(stage.id, ''))
              : scriptIds.filter((id) => done(stage.id, id)).length /
                Math.max(1, scriptIds.length)),
        0,
      ),
    ),
  );
}

const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string' && v.length <= 20000;
const texts = (v: Record<string, unknown>, keys: string[]) => keys.every((k) => text(v[k]));
export function isStoryboardReview(v: unknown): v is StoryboardReview {
  return (
    object(v) &&
    text(v.summary) &&
    Array.isArray(v.findings) &&
    v.findings.length <= 1000 &&
    v.findings.every(
      (f) =>
        object(f) &&
        ['ERROR', 'WARNING'].includes(String(f.severity)) &&
        ['FACT', 'STORY', 'STRUCTURE'].includes(String(f.category)) &&
        texts(f, ['message', 'evidence', 'suggestion']) &&
        Array.isArray(f.shotIds) &&
        f.shotIds.every(text) &&
        (f.beatIds === undefined || (Array.isArray(f.beatIds) && f.beatIds.every(text))),
    )
  );
}
export function isTypedQualityReview(
  review: StoryboardReview,
  route: NonNullable<StoryboardInput['routeId']>,
): boolean {
  const value = review as Record<string, unknown>;
  if (value.routeId !== route || !Array.isArray(value.qualityChecks)) return false;
  const criteria = SCRIPT_QUALITY_CRITERIA[route];
  if (value.qualityChecks.length !== criteria.length) return false;
  return value.qualityChecks.every((raw, index) => {
    if (!object(raw) || raw.criterion !== criteria[index]) return false;
    if (!['PASS', 'FAIL', 'NOT_APPLICABLE'].includes(String(raw.verdict))) return false;
    if (
      raw.verdict === 'NOT_APPLICABLE' &&
      !(route === 'DRAMA' && raw.criterion === 'NATURAL_DIALOGUE')
    )
      return false;
    if (
      !Array.isArray(raw.beatIds) ||
      !raw.beatIds.every(text) ||
      !texts(raw, ['evidence', 'reason', 'suggestion'])
    )
      return false;
    if (raw.verdict === 'NOT_APPLICABLE') return true;
    if (!raw.beatIds.length || String(raw.evidence).trim().length < 8 || !String(raw.reason).trim())
      return false;
    return raw.verdict !== 'FAIL' || !!String(raw.suggestion).trim();
  });
}
/** Mechanical checkpoint validation; semantic decisions remain with independent AI review. */
export function validateStoryboardCheckpoint(
  node: StoryboardStage,
  value: unknown,
  input: StoryboardInput,
  scriptId: string,
): boolean {
  if (!object(value)) return false;
  if (input.graphVersion === 'TYPED_CREATION_V1') {
    const { graphVersion: _version, ...legacyInput } = input;
    if (!storyboardStages(input).some((s) => s.id === node)) return false;
    if (node === 'SNAPSHOT')
      return (
        object(value.source) &&
        value.source.artifactId === input.source.artifactId &&
        value.source.revision === input.source.revision &&
        value.source.fingerprint === input.source.fingerprint
      );
    if (node === 'PREPARE')
      return (
        JSON.stringify(value.requirements) ===
          JSON.stringify(
            (input.settings.structureSections ?? []).map((title, i) => ({
              id: `R${String(i + 1).padStart(2, '0')}`,
              title,
            })),
          ) &&
        object(value.source) &&
        value.source.artifactId === input.source.artifactId &&
        value.source.revision === input.source.revision &&
        value.source.fingerprint === input.source.fingerprint
      );
    if (node === 'ROUTE')
      return value.routeId === input.routeId && value.graphVersion === input.graphVersion;
    if (node === 'ECOMMERCE_MOTIVATION') return isPresenterStrategy(input.strategyVersions?.concept) ? validatePresenterDevelopment(value, input.brief) : validateCommerceDevelopment(value, input.brief);
    if (node === 'BRAND_AD_PROPOSITION' || node === 'BRAND_AD_IDEAS')
      return validateBrandDevelopment(value, input.brief, Math.min(8, Math.max(6, input.scriptIds.length + 3)));
    const role = scriptStageRole(node);
    if (node === 'DRAMA_CONCEPT' && isDramaStrategy(input.strategyVersions?.concept))
      return validateDramaDevelopment(value.development, input.brief, input.scriptIds.length) && validateDramaSelection(value, value.development, input.scriptIds);
    if (role === 'CONCEPT') {
      if (
        !object(value.readiness) ||
        !['READY', 'NEEDS_INFORMATION'].includes(String(value.readiness.status)) ||
        !text(value.readiness.reason) ||
        !Array.isArray(value.readiness.missing) ||
        !value.readiness.missing.every(text)
      )
        return false;
      if (value.readiness.status === 'NEEDS_INFORMATION')
        return (
          Array.isArray(value.concepts) &&
          value.concepts.length === 0 &&
          value.readiness.missing.length > 0
        );
      if (
        value.readiness.missing.length !== 0 ||
        !Array.isArray(value.concepts) ||
        !value.concepts.every(
          (c) =>
            object(c) &&
            object(c.plan) &&
            c.plan.videoType === input.routeId &&
            Object.keys(SCRIPT_PLAN_FIELDS[input.routeId!]).every(
              (k) =>
                text((c.plan as Record<string, unknown>)[k]) &&
                String((c.plan as Record<string, unknown>)[k]).trim(),
            ),
        )
      )
        return false;
    }
    if (role === 'STORY')
      return (
        validateStoryboardCheckpoint(
          'STORY',
          value,
          {
            ...legacyInput,
            storyFormat: 'VIDEO_SCRIPT_V2',
            settings: { ...input.settings, structureSections: [] },
          },
          scriptId,
        ) &&
        !validateScriptStructureMapping(
          value as unknown as StoryboardStory,
          input.settings.structureSections ?? [],
        )
      );
    if (role === 'REVIEW' || node === 'RECHECK')
      return (
        isStoryboardReview(value) &&
        value.findings.every((f) => !f.shotIds.length && Array.isArray(f.beatIds)) &&
        (![...DRAMA_CREATION_VERSIONS, ...COMMERCE_CREATION_VERSIONS, '2026-10-13.4', '2026-10-13.5', '2026-10-13.6', '2026-10-13.7', '2026-10-13.8', '2026-10-13.9', '2026-10-13.10', '2026-10-13.11', '2026-10-14.1', '2026-10-14.2', '2026-10-14.3', '2026-10-14.4', '2026-10-14.5', '2026-10-14.6', '2026-10-14.7'].includes(
          input.strategyVersions?.review ?? '',
        ) ||
          isTypedQualityReview(value, input.routeId!))
      );
    if (node === 'REPAIR')
      return (
        object(value.script) &&
        value.script.id === scriptId &&
        !validateStoryboardPublication(value.script) &&
        object(value.script.story) &&
        !validateStoryboardVideoScript(value.script.story as unknown as StoryboardStory) &&
        !validateScriptStructureMapping(
          value.script.story as unknown as StoryboardStory,
          input.settings.structureSections ?? [],
        ) &&
        text(value.reason) &&
        Array.isArray(value.changes) &&
        value.changes.every((c) => object(c) && texts(c, ['before', 'after', 'reason']))
      );
    return validateStoryboardCheckpoint(
      role as StoryboardStage,
      value,
      { ...legacyInput, storyFormat: 'VIDEO_SCRIPT_V2' },
      scriptId,
    );
  }
  if (node === 'SNAPSHOT')
    return (
      object(value.source) &&
      value.source.artifactId === input.source.artifactId &&
      value.source.revision === input.source.revision
    );
  if (node === 'CONCEPT')
    return (
      Array.isArray(value.concepts) &&
      value.concepts.length === input.scriptIds.length &&
      new Set(value.concepts.map((c) => (object(c) ? c.scriptId : null))).size ===
        input.scriptIds.length &&
      value.concepts.every(
        (c) =>
          object(c) &&
          input.scriptIds.includes(String(c.scriptId)) &&
          texts(c, ['name', 'synopsis', 'productFocus', 'structure', 'difference']) &&
          (input.storyFormat !== 'VIDEO_SCRIPT_V2' ||
            ['coreIdea', 'openingHook', 'productRole', 'memoryPoint'].every(
              (k) => text(c[k]) && (c[k] as string).trim().length > 0,
            )),
      )
    );
  if (node === 'STORY')
    return (
      texts(value, ['title', 'content', 'opening', 'development', 'ending', 'dialoguePlan']) &&
      Array.isArray(value.beats) &&
      value.beats.length > 0 &&
      value.beats.length <= 60 &&
      new Set(value.beats.map((b) => (object(b) ? b.id : null))).size === value.beats.length &&
      value.beats.every(
        (b) =>
          object(b) &&
          text(b.id) &&
          text(b.content) &&
          typeof b.durationSeconds === 'number' &&
          b.durationSeconds > 0 &&
          b.durationSeconds <=
            (input.storyFormat === 'VIDEO_SCRIPT_V2'
              ? 3600
              : input.storyFormat === 'SCREENPLAY_V1'
                ? 60
                : 30),
      ) &&
      (input.storyFormat === 'VIDEO_SCRIPT_V2' ||
        Math.abs(
          value.beats.reduce((n, b) => n + Number(b.durationSeconds), 0) -
            input.settings.targetDurationSeconds,
        ) <= 1) &&
      (input.storyFormat !== 'VIDEO_SCRIPT_V2' ||
        !validateStoryboardVideoScript(
          value as unknown as StoryboardStory,
          input.settings.structureSections,
        )) &&
      (input.storyFormat !== 'SCREENPLAY_V1' ||
        !validateStoryboardScreenplay(value as unknown as StoryboardStory))
    );
  if (node === 'ASSETS')
    return (
      Array.isArray(value.assets) &&
      value.assets.length <= 1000 &&
      value.assets.some((a) => object(a) && a.kind === 'products') &&
      new Set(value.assets.map((a) => (object(a) ? a.id : null))).size === value.assets.length &&
      value.assets.every(
        (a) =>
          object(a) &&
          texts(a, ['id', 'name', 'description']) &&
          ['characters', 'products', 'scenes'].includes(String(a.kind)),
      )
    );
  if (node === 'SHOTS')
    return (
      value.id === scriptId &&
      !validateStoryboardPublication(value, input.settings.targetDurationSeconds)
    );
  if (node === 'REVIEW') return isStoryboardReview(value);
  if (node === 'REPAIR')
    return (
      object(value.script) &&
      value.script.id === scriptId &&
      !validateStoryboardPublication(
        value.script,
        input.storyFormat === 'VIDEO_SCRIPT_V2' ? undefined : input.settings.targetDurationSeconds,
      ) &&
      (input.storyFormat !== 'VIDEO_SCRIPT_V2' ||
        (object(value.script.story) &&
          !validateStoryboardVideoScript(
            value.script.story as unknown as StoryboardStory,
            input.settings.structureSections,
          ))) &&
      (input.storyFormat !== 'SCREENPLAY_V1' ||
        (object(value.script.story) &&
          !validateStoryboardScreenplay(value.script.story as unknown as StoryboardStory))) &&
      isStoryboardReview(value.review) &&
      text(value.reason) &&
      Array.isArray(value.changes) &&
      value.changes.every((c) => object(c) && texts(c, ['before', 'after', 'reason']))
    );
  return false;
}
