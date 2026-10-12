import type { CustomizedBrief } from './customized-extraction';
import type {
  CustomizedStoryboardDraft,
  CustomizedStoryboardScript,
} from './customized-storyboard';
import { isCustomizedStoryboardScript } from './customized-storyboard';

export const CUSTOMIZED_STORYBOARD_STAGES = [
  { id: 'SNAPSHOT', label: '信息卡快照', description: '确认本次产品事实与创作约束', weight: 5 },
  { id: 'CONCEPT', label: '多方案构思', description: '探索有区别的故事切入', weight: 10 },
  { id: 'STORY', label: '完整故事创作', description: '展开完整故事及对白安排', weight: 20 },
  { id: 'ASSETS', label: '资产需求整理', description: '定义人物、产品和场景', weight: 10 },
  { id: 'SHOTS', label: '逐镜脚本创作', description: '把故事细化为连续镜头', weight: 25 },
  { id: 'REVIEW', label: '脚本审校', description: '核对事实、叙事与镜头衔接', weight: 15 },
  { id: 'REPAIR', label: '定向修订', description: '处理具体问题并再次核对', weight: 10 },
  { id: 'SAVE', label: '保存脚本分支', description: '保存独立脚本及制作路径', weight: 5 },
] as const;
export type StoryboardStage = (typeof CUSTOMIZED_STORYBOARD_STAGES)[number]['id'];
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
  message: string;
  evidence: string;
  suggestion: string;
};
export type StoryboardReview = { summary: string; findings: StoryboardFinding[] };
export type StoryboardConcept = {
  scriptId: string;
  name: string;
  synopsis: string;
  productFocus: string;
  structure: string;
  difference: string;
};
export type StoryboardStory = {
  title: string;
  content: string;
  opening: string;
  development: string;
  ending: string;
  dialoguePlan: string;
  beats: { id: string; content: string; durationSeconds: number }[];
};
export type StoryboardInput = {
  schemaVersion: 1;
  source: StoryboardSource;
  brief: CustomizedBrief;
  settings: StoryboardSettings;
  scriptIds: string[];
  existingConcepts: { name: string; synopsis: string }[];
  models: { creative: string; detail: string };
  brandReferences: unknown[];
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
  if (
    !['AI', 'REFERENCE', 'CUSTOM'].includes(value.structureMode) ||
    typeof value.structure !== 'string' ||
    typeof value.instructions !== 'string' ||
    value.structure.length > 20000 ||
    value.instructions.length > 20000
  )
    return '创作设置格式不正确';
  if (value.structureMode !== 'AI' && !value.structure.trim()) return '请填写叙事结构';
  return null;
}
export function validateStoryboardPublication(value: unknown, target?: number): string | null {
  if (!isCustomizedStoryboardScript(value)) return '脚本结构或资产引用不完整';
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
export function storyboardProgress(
  steps: Pick<StoryboardStep, 'nodeId' | 'scriptId' | 'status'>[],
  scriptIds: string[],
  complete: boolean,
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
      CUSTOMIZED_STORYBOARD_STAGES.reduce(
        (total, stage) =>
          total +
          stage.weight *
            (['SNAPSHOT', 'CONCEPT'].includes(stage.id)
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
        f.shotIds.every(text),
    )
  );
}
/** Mechanical checkpoint validation; semantic decisions remain with independent AI review. */
export function validateStoryboardCheckpoint(
  node: StoryboardStage,
  value: unknown,
  input: StoryboardInput,
  scriptId: string,
): boolean {
  if (!object(value)) return false;
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
          texts(c, ['name', 'synopsis', 'productFocus', 'structure', 'difference']),
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
          b.durationSeconds <= 30,
      ) &&
      Math.abs(
        value.beats.reduce((n, b) => n + Number(b.durationSeconds), 0) -
          input.settings.targetDurationSeconds,
      ) <= 1
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
      !validateStoryboardPublication(value.script, input.settings.targetDurationSeconds) &&
      isStoryboardReview(value.review) &&
      text(value.reason) &&
      Array.isArray(value.changes) &&
      value.changes.every((c) => object(c) && texts(c, ['before', 'after', 'reason']))
    );
  return false;
}
