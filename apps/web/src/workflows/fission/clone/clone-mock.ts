import { clonePrototypeFixture as fixture } from './clone-prototype.fixture';

export type ElementType = 'product' | 'person' | 'scene' | 'subtitle' | 'bgm' | 'voiceover';
export type CloneMaterial = {
  id: string;
  name: string;
  type: string;
  category: string;
  size: string;
  resolution: string;
  tags: string[];
  status: string;
  source?: string | undefined;
};
export type CloneCandidate = {
  id: string;
  type: string;
  name: string;
  tags: string[];
  version: string;
  style: string;
  shots: string;
  score: number;
  source?: string | undefined;
};
export type CloneElement = {
  id: string;
  type: string;
  name: string;
  original: string;
  shots: number;
  confidence: number;
  required: boolean;
  strategy: string;
  targetId: string;
};
export type CloneResult = {
  id: string;
  name: string;
  status: 'running' | 'done' | 'failed';
  progress: number;
  startedAt: number;
  fail: boolean;
  snapshot: string;
  note: string;
  mapping: (CloneElement & { targetName: string })[];
  referenceName: string;
  createdAt: string;
};
export type CloneMockState = {
  schema: 1;
  scope: string;
  step: number;
  pid: string;
  reference: typeof fixture.referenceVideo | null;
  materials: CloneMaterial[];
  report: Record<string, string>[];
  shots: typeof fixture.shotTimeline;
  reportReady: boolean;
  confirmedInput: string;
  reportInput: string;
  confirmedReport: string;
  mappingReport: string;
  confirmedMapping: string;
  elements: CloneElement[];
  candidates: CloneCandidate[];
  archived: Record<string, { signature: string; version: number; tags: string; note: string }>;
  results: CloneResult[];
  job: { kind: 'analysis' | 'mapping'; startedAt: number; snapshot: string } | null;
};
export const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
export const cloneMockScope = (projectId: string): string =>
  `ai-marketing.mock.FISSION_CLONE.${encodeURIComponent(projectId || 'unbound-preview')}.run-01`;
// Compact deterministic UI fingerprints keep 100-item demo batches within browser storage.
export function contentSignature(value: unknown): string {
  const text = JSON.stringify(value);
  let a = 2166136261,
    b = 2246822519;
  for (let i = 0; i < text.length; i++) {
    a = Math.imul(a ^ text.charCodeAt(i), 16777619);
    b = Math.imul(b ^ text.charCodeAt(i), 3266489917);
  }
  return `mock-${(a >>> 0).toString(16)}-${(b >>> 0).toString(16)}`;
}
export function archiveCloneMock(
  state: CloneMockState,
  key: string,
  signature: string,
  tags: string,
  note: string,
): void {
  if (!signature) throw new Error('请先确认当前产物');
  const previous = state.archived[key];
  state.archived[key] = {
    signature,
    version: (previous?.version ?? 0) + (previous?.signature === signature ? 0 : 1),
    tags,
    note,
  };
}
export const inputSignature = (state: CloneMockState): string =>
  contentSignature([state.reference, state.materials]);
export const reportSignature = (state: CloneMockState): string =>
  contentSignature([state.reportInput, state.report, state.shots]);
export const mappingSignature = (state: CloneMockState): string =>
  contentSignature([state.confirmedReport, state.elements]);
export const resultSignature = (state: CloneMockState): string =>
  contentSignature([
    state.confirmedInput,
    state.reportInput,
    state.confirmedReport,
    state.confirmedMapping,
  ]);

export function createCloneMock(projectId: string, empty = false): CloneMockState {
  const state: CloneMockState = {
    schema: 1,
    scope: cloneMockScope(projectId),
    step: 0,
    pid: fixture.productPid,
    reference: empty ? null : copy(fixture.referenceVideo),
    materials: empty ? [] : copy(fixture.productMaterials),
    report: copy(fixture.dimensionReports) as Record<string, string>[],
    shots: copy(fixture.shotTimeline),
    reportReady: !empty,
    confirmedInput: '',
    reportInput: '',
    confirmedReport: '',
    mappingReport: '',
    confirmedMapping: '',
    elements: fixture.sourceElements.map((item) => ({
      ...item,
      targetId: empty
        ? ''
        : (fixture.mappingRelations.find((r) => r.sourceId === item.id)?.targetId ?? ''),
      strategy: empty && !item.required ? 'retain' : item.strategy,
    })),
    candidates: copy(fixture.targetAssets),
    archived: {},
    results: [],
    job: null,
  };
  state.confirmedInput = empty ? '' : inputSignature(state);
  state.reportInput = state.confirmedInput;
  state.confirmedReport = empty ? '' : reportSignature(state);
  state.mappingReport = state.confirmedReport;
  state.confirmedMapping = empty ? '' : mappingSignature(state);
  if (!empty) {
    state.results = Array.from({ length: 8 }, (_, i) => makeResult(state, i, 0));
    state.results.forEach((item, i) => {
      item.status = i === 3 ? 'failed' : 'done';
      item.progress = i === 3 ? 46 : 100;
    });
  }
  return state;
}

export function restoreCloneMock(
  storage: Pick<Storage, 'getItem'>,
  projectId: string,
): CloneMockState {
  const scope = cloneMockScope(projectId);
  const saved = storage.getItem(scope);
  if (!saved) return createCloneMock(projectId);
  const state = JSON.parse(saved) as CloneMockState;
  if (!Array.isArray(state.shots)) state.shots = copy(fixture.shotTimeline);
  state.archived ??= {};
  if (
    state.schema !== 1 ||
    state.scope !== scope ||
    !Array.isArray(state.elements) ||
    !Array.isArray(state.results) ||
    !Array.isArray(state.materials) ||
    !Array.isArray(state.report) ||
    !Array.isArray(state.candidates) ||
    !Number.isInteger(state.step) ||
    state.step < 0 ||
    state.step > 3
  ) {
    throw new Error('本地演示草稿无法读取，请重试或重置演示数据');
  }
  return state;
}
export function confirmInput(state: CloneMockState): void {
  if (!state.reference) throw new Error('请先上传一条参考视频');
  state.confirmedInput = inputSignature(state);
}
export function confirmReport(state: CloneMockState): void {
  if (
    !state.reportReady ||
    state.reportInput !== state.confirmedInput ||
    inputSignature(state) !== state.confirmedInput
  )
    throw new Error('参考素材已变化，请先确认素材并重新拆解');
  state.confirmedReport = reportSignature(state);
}
export function confirmMapping(state: CloneMockState): void {
  if (state.reportInput !== state.confirmedInput || inputSignature(state) !== state.confirmedInput)
    throw new Error('参考素材已变化，请先重新拆解');
  if (
    !state.confirmedReport ||
    state.mappingReport !== state.confirmedReport ||
    reportSignature(state) !== state.confirmedReport
  )
    throw new Error('拆解报告已变化，请先确认报告并重新匹配');
  if (!state.elements.some((e) => e.required && e.strategy === 'replace' && candidateFor(state, e)))
    throw new Error('请先完成必换产品的素材映射');
  if (state.elements.some((e) => e.strategy === 'replace' && !candidateFor(state, e)))
    throw new Error('请为替换元素选择素材，或改为保留原片');
  state.confirmedMapping = mappingSignature(state);
}
export function candidatesFor(state: CloneMockState, type: string): CloneCandidate[] {
  if (type !== 'product') return state.candidates.filter((item) => item.type === type);
  return [
    ...state.materials.map((m) => ({
      id: m.id,
      type: 'product',
      name: m.name,
      tags: m.tags,
      version: 'v1',
      style: m.category,
      shots: '产品登场、效果验证',
      score: 96,
      source: m.source,
    })),
    ...state.candidates.filter((item) => item.type === 'product'),
  ];
}
export const candidateFor = (
  state: CloneMockState,
  element: CloneElement,
): CloneCandidate | undefined =>
  candidatesFor(state, element.type).find((item) => item.id === element.targetId);
export function autoMap(state: CloneMockState): void {
  state.elements.forEach((e) => {
    if (e.strategy === 'replace') e.targetId = candidatesFor(state, e.type)[0]?.id ?? '';
  });
  state.mappingReport = state.confirmedReport;
}
export const snapshotMapping = (state: CloneMockState): CloneResult['mapping'] =>
  state.elements.map((e) => ({ ...copy(e), targetName: candidateFor(state, e)?.name ?? '' }));
function makeResult(state: CloneMockState, index: number, now: number, fail = false): CloneResult {
  return {
    id: `mock-${now}-${index}`,
    name: `广式腊肠_爆款复刻_${String(index + 1).padStart(2, '0')}`,
    status: 'running',
    progress: 0,
    startedAt: now,
    fail,
    snapshot: resultSignature(state),
    note: '',
    mapping: snapshotMapping(state),
    referenceName: state.reference?.name ?? '',
    createdAt: now
      ? new Date(now).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
      : '2026-10-20 09:00',
  };
}
export function startResults(
  state: CloneMockState,
  count: number,
  now: number,
  fail = false,
): void {
  if (!Number.isInteger(count) || count < 1 || count > 100)
    throw new Error('生成数量需为 1–100 的整数');
  if (state.results.some((item) => item.status === 'running'))
    throw new Error('请等待当前演示任务完成');
  if (state.confirmedMapping !== mappingSignature(state)) throw new Error('请先确认当前元素映射');
  confirmMapping(state);
  if (state.reportInput !== state.confirmedInput || inputSignature(state) !== state.confirmedInput)
    throw new Error('参考素材已变化，请先重新拆解');
  state.results.push(
    ...Array.from({ length: count }, (_, i) =>
      makeResult(state, state.results.length + i, now, fail && i === 0),
    ),
  );
}
export function tickCloneMock(state: CloneMockState, now: number): void {
  if (state.job && now - state.job.startedAt >= 2200) {
    const job = state.job;
    state.job = null;
    if (
      job.kind === 'analysis' &&
      job.snapshot === state.confirmedInput &&
      inputSignature(state) === job.snapshot
    ) {
      state.reportReady = true;
      state.reportInput = job.snapshot;
      state.confirmedReport = reportSignature(state);
    } else if (job.kind === 'mapping' && job.snapshot === state.confirmedReport) autoMap(state);
  }
  state.results.forEach((item) => {
    if (item.status !== 'running') return;
    item.progress = Math.min(100, Math.floor((now - item.startedAt) / 45));
    if (item.progress >= 100) {
      item.status = item.fail ? 'failed' : 'done';
      if (item.fail) item.progress = 46;
    }
  });
}
