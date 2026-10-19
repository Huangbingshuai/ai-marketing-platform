import type { CustomizedImportMaterial } from './customized-import';
import type { ExtractionGraphNode, ExtractionStepExecution } from './extraction-execution';

export const CUSTOMIZED_BRIEF_ARTIFACT_KEY = 'customized-brief';
export const CUSTOMIZED_EXTRACTION_NODES = [
  {
    id: 'LOAD_AND_SNAPSHOT',
    label: '资料快照',
    group: 'SNAPSHOT',
    description: '冻结已确认简报及品牌素材引用',
  },
  { id: 'DOCUMENT_PARSE', label: '文档解析', group: 'PARSE', description: '读取简报正文与表格' },
  {
    id: 'DOCUMENT_EXTRACT',
    label: '文档信息提取',
    group: 'EXTRACT',
    description: '提取品牌信息与产品信息',
  },
  { id: 'FUSION', label: '多文档信息融合', group: 'FUSION', description: '整理文档信息及资料差异' },
  {
    id: 'SEMANTIC_REFINEMENT',
    label: '语义精炼',
    group: 'SEMANTIC',
    description: '核对事实依据、信息归属及品牌约束',
  },
  {
    id: 'NORMALIZATION',
    label: '标准化与结果保存',
    group: 'NORMALIZATION',
    description: '保存可编辑的视频创作信息卡',
  },
] as const satisfies readonly ExtractionGraphNode[];
export type CustomizedExtractionNodeId = (typeof CUSTOMIZED_EXTRACTION_NODES)[number]['id'];
export const CUSTOMIZED_BRIEF_LABELS = {
  brandName: '品牌名称',
  projectName: '项目名称',
  projectBackground: '项目背景',
  brandTone: '品牌调性',
  visualConsistencyRules: '视觉统一规则',
  avoidedElements: '画面禁用元素',
  productName: '产品名称',
  productDescription: '产品介绍',
  productSpecifications: '产品规格',
  productAppearance: '产品外观',
  sellingPoints: '核心卖点',
  targetAudience: '目标受众',
} as const;
export type CustomizedBriefField = keyof typeof CUSTOMIZED_BRIEF_LABELS;
export type CustomizedBrief = Record<Exclude<CustomizedBriefField, 'sellingPoints'>, string> & {
  sellingPoints: string[];
};
export const emptyCustomizedBrief = (): CustomizedBrief => ({
  brandName: '',
  projectName: '',
  projectBackground: '',
  brandTone: '',
  visualConsistencyRules: '',
  avoidedElements: '',
  productName: '',
  productDescription: '',
  productSpecifications: '',
  productAppearance: '',
  sellingPoints: [],
  targetAudience: '',
});
export type CustomizedBriefSource = {
  assetId: string;
  assetVersion: number;
  location: string;
  itemIndex?: number | null;
};
export type CustomizedBriefIssue = {
  id: string;
  field: Exclude<CustomizedBriefField, 'sellingPoints'>;
  message: string;
  sourceIds: string[];
  alternatives: string[];
  blocking: boolean;
  /** Optional on historical results. Apply only the unique exact fragment, never the whole field. */
  resolution?: CustomizedBriefIssueResolution | null;
};
export type CustomizedBriefIssueResolution = {
  schemaVersion: 1;
  /** Frozen generated field value, before manual overrides or earlier issue choices. */
  baseValue: string;
  before: string;
  /** Index-aligned with the existing complete-field alternatives. */
  replacements: string[];
};

export function isCustomizedBriefIssueResolution(
  value: unknown,
): value is CustomizedBriefIssueResolution {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    Object.keys(v).length === 4 &&
    v.schemaVersion === 1 &&
    typeof v.baseValue === 'string' &&
    v.baseValue.length <= 50000 &&
    typeof v.before === 'string' &&
    v.before.length <= 50000 &&
    Array.isArray(v.replacements) &&
    v.replacements.length >= 2 &&
    v.replacements.every((s) => typeof s === 'string' && !!s.trim() && s.length <= 50000) &&
    new Set(v.replacements).size === v.replacements.length
  );
}

/** Exact patch application keeps unrelated manual edits and earlier disjoint choices intact. */
export function applyCustomizedBriefIssueAlternative(
  currentValue: string,
  issue: CustomizedBriefIssue,
  index: number,
): { ok: true; value: string } | { ok: false; reason: 'LEGACY' | 'INVALID' | 'STALE' } {
  const r = issue.resolution;
  if (r == null) return { ok: false, reason: 'LEGACY' };
  if (
    !isCustomizedBriefIssueResolution(r) ||
    !Number.isInteger(index) ||
    index < 0 ||
    r.replacements.length !== issue.alternatives.length ||
    index >= r.replacements.length
  )
    return { ok: false, reason: 'INVALID' };
  const start = r.baseValue.indexOf(r.before);
  if (start < 0 || start !== r.baseValue.lastIndexOf(r.before) || (!r.before && r.baseValue !== ''))
    return { ok: false, reason: 'INVALID' };
  if (
    r.replacements.some(
      (replacement, i) =>
        r.baseValue.slice(0, start) + replacement + r.baseValue.slice(start + r.before.length) !==
        issue.alternatives[i],
    )
  )
    return { ok: false, reason: 'INVALID' };
  const currentStart = currentValue.indexOf(r.before);
  if (
    currentStart < 0 ||
    currentStart !== currentValue.lastIndexOf(r.before) ||
    (!r.before && currentValue !== '')
  )
    return { ok: false, reason: 'STALE' };
  const value =
    currentValue.slice(0, currentStart) +
    r.replacements[index]! +
    currentValue.slice(currentStart + r.before.length);
  return value.length <= 50000 ? { ok: true, value } : { ok: false, reason: 'INVALID' };
}
export type CustomizedBriefCandidate = {
  fields: CustomizedBrief;
  fieldSources: Partial<Record<CustomizedBriefField, CustomizedBriefSource[]>>;
  issues: CustomizedBriefIssue[];
};
/** Internal persisted review evidence; public detail uses the shared display projection. */
export type CustomizedExtractionAuditFinding = {
  field: CustomizedBriefField;
  kind: 'MISSING' | 'INCORRECT' | 'MISATTRIBUTED' | 'CONFLICT';
  description: string;
  proposedValue: string;
  /** Existing global selling-point index, or null for a missing fact/scalar field. */
  itemIndex: number | null;
  evidence: { assetId: string; assetVersion: number; location: string; quote: string };
};
export type CustomizedExtractionAuditReport = {
  checkedFields: CustomizedBriefField[];
  findings: CustomizedExtractionAuditFinding[];
};
export type CustomizedExtractionAuditSummary = {
  schemaVersion: 1;
  documentCount: number;
  chunkCount: number;
  findingCount: number;
  correctedFields: CustomizedBriefField[];
};
/** Observable worker checkpoints, not model reasoning or a second execution graph. */
export const CUSTOMIZED_SEMANTIC_ACTIVITY_LABELS = {
  RAW_AUDIT: '原文逐项审校',
  EVIDENCE_RECHECK: '复核原文依据',
  TARGETED_REPAIR: '修正提炼信息',
  FINAL_REVIEW: '最终语义核对',
  CONFLICT_EVIDENCE: '补充差异依据',
  CONFLICT_COMPLETION: '完善差异候选',
} as const;
export type CustomizedSemanticActivity = {
  schemaVersion: 1;
  steps: {
    id: keyof typeof CUSTOMIZED_SEMANTIC_ACTIVITY_LABELS;
    status: 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'SKIPPED' | 'FAILED';
    completed?: number;
    total?: number;
    unit?: 'DOCUMENT' | 'CHUNK' | 'ISSUE';
  }[];
};
export type CustomizedAuditProgress = { completed: number; total: number };
export type CustomizedExtractionTaskStatus =
  'QUEUED' | 'RUNNING' | 'COMPLETED' | 'PARTIAL' | 'FAILED' | 'CANCELLED';
export type CustomizedExtractionTask = {
  id: string;
  projectId: string;
  workflowRunId: string;
  status: CustomizedExtractionTaskStatus;
  progress: number;
  currentNode: string | null;
  errorMessage: string | null;
  nodes: ExtractionStepExecution[];
  createdAt: string;
  updatedAt: string;
};
export type CustomizedExtractionResult = CustomizedBriefCandidate & {
  id: string;
  revision: number;
  sourceFingerprint: string;
};
export type CustomizedExtractionWorkspace = {
  projectId: string;
  workflowRunId: string;
  source: { artifactId: string; revision: number; fingerprint: string } | null;
  task: CustomizedExtractionTask | null;
  result: CustomizedExtractionResult | null;
  brandReferences: CustomizedImportMaterial[];
  sourceWarnings: string[];
  committed: boolean;
  stale: boolean;
  editing: boolean;
  temporary: boolean;
};
export type StartCustomizedExtractionRequest = {
  workflowRunId: string;
  sourceArtifactId: string;
  sourceRevision: number;
  idempotencyKey: string;
};
export type SaveCustomizedExtractionRequest = {
  expectedRevision: number;
  fields: CustomizedBrief;
  resolvedIssueIds: string[];
};
/** Strict wire validation shared by API and contract tests. No placeholder facts are generated. */
export function isCustomizedBrief(value: unknown): value is CustomizedBrief {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    Object.keys(v).length === Object.keys(CUSTOMIZED_BRIEF_LABELS).length &&
    Object.keys(CUSTOMIZED_BRIEF_LABELS).every((key) =>
      key === 'sellingPoints'
        ? Array.isArray(v[key]) &&
          v[key].every((item) => typeof item === 'string' && item.length <= 10000)
        : typeof v[key] === 'string' && v[key].length <= 50000,
    )
  );
}
export function normalizeCustomizedBrief(value: CustomizedBrief): CustomizedBrief {
  return Object.fromEntries(
    Object.keys(CUSTOMIZED_BRIEF_LABELS).map((key) => [
      key,
      key === 'sellingPoints'
        ? value.sellingPoints.map((s) => s.trim()).filter(Boolean)
        : value[key as Exclude<CustomizedBriefField, 'sellingPoints'>].trim(),
    ]),
  ) as CustomizedBrief;
}
