// Browser-only fixtures. These are never sent to the project, asset or task APIs.
export const STEPS = ['选择成片', '选择时长范围', '范围解析与替换', '生成提示词', '渲染输出'];
export type Dimension = 'person' | 'product' | 'scene';
export type MockStatus = 'idle' | 'running' | 'done' | 'failed' | 'warning' | 'stale';
export const DIMENSIONS = [
  { id: 'person' as const, name: '人物', color: '#7955c9', original: '家庭生活博主' },
  {
    id: 'product' as const,
    name: '产品',
    color: '#2766ed',
    original: '腊肠熟食展示、广式腊肠包装、腊肠切片特写',
  },
  {
    id: 'scene' as const,
    name: '场景',
    color: '#1696a8',
    original: '家庭餐桌、暖光后厨、食品微距台',
  },
];
export interface MockAsset {
  id: string;
  type: Dimension;
  name: string;
  version: string;
  label: string;
  variant: string;
  fit: number;
  tags: string[];
  local?: boolean;
}
export const ASSETS: MockAsset[] = [
  {
    id: 'person-chef',
    type: 'person',
    name: '中年粤菜大厨',
    version: 'v3',
    label: '粤菜大厨',
    variant: 'chef',
    fit: 96,
    tags: ['粤菜', '带货'],
  },
  {
    id: 'person-host',
    type: 'person',
    name: '年轻带货女主播',
    version: 'v4',
    label: '带货主播',
    variant: 'host',
    fit: 92,
    tags: ['直播', '带货'],
  },
  {
    id: 'product-sausage',
    type: 'product',
    name: '广式腊肠礼盒装',
    version: 'v5',
    label: '腊味礼盒',
    variant: 'sausage',
    fit: 98,
    tags: ['腊味', '礼盒'],
  },
  {
    id: 'product-pack',
    type: 'product',
    name: '独立锁鲜腊肠包装',
    version: 'v2',
    label: '锁鲜包装',
    variant: 'gift',
    fit: 94,
    tags: ['腊味', '包装'],
  },
  {
    id: 'scene-kitchen',
    type: 'scene',
    name: '岭南暖光厨房',
    version: 'v2',
    label: '岭南厨房',
    variant: 'kitchen',
    fit: 97,
    tags: ['厨房', '暖光'],
  },
  {
    id: 'scene-table',
    type: 'scene',
    name: '家庭原木餐桌',
    version: 'v3',
    label: '家庭餐桌',
    variant: 'table',
    fit: 95,
    tags: ['餐桌', '暖光'],
  },
];
export interface MockVideo {
  id: string;
  name: string;
  project: string;
  version: string;
  duration: number;
  ratio: string;
  workflow: string;
  kind: string;
  resolution?: string;
}
export const videoResolution = (video: MockVideo | null | undefined): string =>
  video?.resolution ||
  (video?.ratio === '16:9'
    ? '1920 × 1080'
    : video?.ratio === '1:1'
      ? '1080 × 1080'
      : '1080 × 1920');
export function videoRatio(width: number, height: number): string {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0)
    return '9:16';
  const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
  const unit = gcd(width, height);
  return `${width / unit}:${height / unit}`;
}
export const rangeTimelineWidth = (duration: number, zoom: number): number =>
  Math.max(920, Math.round(duration * 30 * zoom));
export const rangeTimelineTicks = (duration: number): number[] => {
  const step = duration <= 12 ? 2 : duration <= 40 ? 4 : duration <= 90 ? 10 : 20;
  const ticks: number[] = [];
  for (let n = 0; n < duration; n += step) ticks.push(n);
  if (!ticks.includes(duration)) ticks.push(duration);
  return ticks;
};
export const VIDEOS: MockVideo[] = [
  {
    id: 'mock-food-v4',
    name: '广式腊肠效果投放成片_v4.mp4',
    project: '广味食品 · 广式腊味夏季投放',
    version: 'v4',
    duration: 32,
    ratio: '9:16',
    workflow: '效果类',
    kind: '项目成片',
  },
  {
    id: 'mock-food-v2',
    name: '腊味煲仔饭种草成片_v2.mp4',
    project: '广味食品 · 腊味种草专项',
    version: 'v2',
    duration: 24,
    ratio: '9:16',
    workflow: '定制类',
    kind: '项目成片',
  },
  {
    id: 'mock-render-v1',
    name: '腊肠包装产品展示_01.mp4',
    project: '广味食品 · 广式腊味夏季投放',
    version: 'v1',
    duration: 12,
    ratio: '16:9',
    workflow: '效果类',
    kind: '渲染视频素材',
  },
  {
    id: 'mock-fission-v1',
    name: '厨房换景演示成片_v1.mp4',
    project: '广味食品 · 局部替换专项',
    version: 'v1',
    duration: 32,
    ratio: '9:16',
    workflow: '裂变类',
    kind: '项目成片',
  },
];
export const QUALITY = [
  { name: '光影匹配', score: 95, threshold: 85 },
  { name: '透视关系', score: 95, threshold: 85 },
  { name: '色彩风格', score: 94, threshold: 85 },
  { name: '边缘接缝', score: 93, threshold: 85 },
  { name: '结构保真', score: 100, threshold: 100 },
  { name: '音画同步', score: 96, threshold: 90 },
];
export interface MockDraft {
  schema: 1;
  step: number;
  source: MockVideo | null;
  start: number;
  end: number;
  bindings: Partial<Record<Dimension, string>>;
  analysis: MockStatus;
  prompt: MockStatus;
  promptRegeneration: 'text' | 'composition' | 'negative' | null;
  render: MockStatus;
  text: string;
  composition: string;
  negative: string;
  savedFingerprint: string;
  savedArtifacts: string[];
  savedTags: string;
  savedNote: string;
  archives: Record<string, { names: string[]; tags: string; note: string }>;
  importedAssets: MockAsset[];
}
export const createMockDraft = (): MockDraft => ({
  schema: 1,
  step: 1,
  source: { ...VIDEOS[0]! },
  start: 0,
  end: 0,
  bindings: {},
  analysis: 'idle',
  prompt: 'idle',
  promptRegeneration: null,
  render: 'idle',
  text: '',
  composition: '',
  negative: '',
  savedFingerprint: '',
  savedArtifacts: [],
  savedTags: '',
  savedNote: '',
  archives: {},
  importedAssets: [],
});
export const draftKey = (projectId: string): string =>
  `ai-marketing.mock.${projectId}.FISSION_LOCAL_REPLACE.demo-run-v1`;
export const timecode = (value: number): string =>
  `${String(Math.floor(value / 60)).padStart(2, '0')}:${(value % 60).toFixed(1).padStart(4, '0')}`;
export const rangeError = (draft: MockDraft): string => {
  if (!draft.source) return '请先选择一条原成片。';
  if (!Number.isFinite(draft.start) || !Number.isFinite(draft.end))
    return '请输入有效的开始与结束时间。';
  if (draft.start < 0 || draft.end > draft.source.duration) return '替换范围不能超出原片时长。';
  if (draft.end <= draft.start) return '结束时间必须晚于开始时间。';
  if (draft.end - draft.start < 0.1 - 1e-8) return '替换范围至少为 0.1 秒。';
  return '';
};
export function invalidateAfter(
  draft: MockDraft,
  boundary: 'source' | 'range' | 'binding' | 'prompt',
): void {
  if (boundary === 'source') {
    draft.start = 0;
    draft.end = 0;
  }
  if (boundary === 'source' || boundary === 'range') {
    draft.analysis = 'idle';
    draft.bindings = {};
  }
  if (boundary !== 'prompt') {
    draft.promptRegeneration = null;
    draft.prompt = 'idle';
    draft.text = '';
    draft.composition = '';
    draft.negative = '';
  }
  draft.render =
    ['done', 'warning', 'stale'].includes(draft.render) && boundary === 'prompt' ? 'stale' : 'idle';
}
export function bindAsset(draft: MockDraft, dimension: Dimension, assetId: string): boolean {
  const asset = [...ASSETS, ...draft.importedAssets].find(
    (a) => a.id === assetId && a.type === dimension,
  );
  if (!asset || draft.analysis !== 'done' || rangeError(draft)) return false;
  if (draft.bindings[dimension] === assetId) return true;
  draft.bindings[dimension] = assetId;
  invalidateAfter(draft, 'binding');
  return true;
}
export function generateMockPrompts(draft: MockDraft): void {
  const range = `${timecode(draft.start)}–${timecode(draft.end)}`;
  const mapped = DIMENSIONS.filter((d) => draft.bindings[d.id])
    .map((d) => {
      const a = [...ASSETS, ...draft.importedAssets].find((a) => a.id === draft.bindings[d.id]);
      return `${d.name}统一替换为“${a?.name}（${a?.version}）”`;
    })
    .join('；');
  draft.text = `【连续时间范围主体替换｜${range}｜共 ${(draft.end - draft.start).toFixed(1)} 秒】将范围内${mapped}。将该时段作为一个连续整体处理，只更新已映射的人物、产品与场景；必须在 ${timecode(draft.start)} 与 ${timecode(draft.end)} 精确切入和切出。保持原片结构、节奏、运镜、转场、钩子、转化点和音效卡点不变；范围外画面逐帧保持原片。执行透视、色温、遮挡和边缘连续性校正。`;
  draft.composition = `基于《${draft.source?.name}》生成一条 ${draft.source?.duration} 秒、${draft.source?.ratio} 的局部替换成片。仅在 ${range} 执行 ${Object.keys(draft.bindings).length} 个主体维度替换。严格锁定原片结构、阶段时长、黄金3秒钩子、转化点、运镜、转场和音效卡点；所有边界自然，范围外内容逐帧不得变化。`;
  draft.negative =
    '禁止改变原片结构、时长、运镜和转场；禁止新增未映射对象；禁止肢体穿模、主体漂移、透视跳变、边缘锯齿和色温断层。';
  draft.prompt = 'done';
  draft.render = 'idle';
}
export function restoreMockDraft(raw: string | null): MockDraft {
  const fallback = createMockDraft();
  if (!raw) return fallback;
  try {
    const data = JSON.parse(raw) as MockDraft;
    data.promptRegeneration = ['text', 'composition', 'negative'].includes(
      data.promptRegeneration ?? '',
    )
      ? data.promptRegeneration
      : null;
    data.importedAssets = Array.isArray(data.importedAssets)
      ? data.importedAssets.filter(
          (a) =>
            a &&
            a.local === true &&
            typeof a.id === 'string' &&
            a.id.startsWith('local-asset-') &&
            typeof a.name === 'string' &&
            typeof a.label === 'string' &&
            typeof a.variant === 'string' &&
            typeof a.version === 'string' &&
            Number.isFinite(a.fit) &&
            Array.isArray(a.tags) &&
            a.tags.every((t) => typeof t === 'string') &&
            ['person', 'product', 'scene'].includes(a.type),
        )
      : [];
    data.archives =
      data.archives && typeof data.archives === 'object' && !Array.isArray(data.archives)
        ? data.archives
        : {};
    data.savedArtifacts = Array.isArray(data.savedArtifacts)
      ? data.savedArtifacts.filter((v) => typeof v === 'string')
      : [];
    data.savedTags = typeof data.savedTags === 'string' ? data.savedTags : '';
    data.savedNote = typeof data.savedNote === 'string' ? data.savedNote : '';
    if (data.schema !== 1 || !Number.isInteger(data.step) || data.step < 1 || data.step > 5)
      return fallback;
    const states = ['idle', 'running', 'done', 'failed', 'warning', 'stale'];
    if (
      ![data.analysis, data.prompt, data.render].every((s) => states.includes(s)) ||
      typeof data.text !== 'string' ||
      typeof data.composition !== 'string' ||
      typeof data.negative !== 'string' ||
      !data.bindings ||
      typeof data.bindings !== 'object'
    )
      return fallback;
    if (
      data.source &&
      (typeof data.source.id !== 'string' ||
        typeof data.source.name !== 'string' ||
        !Number.isFinite(data.source.duration) ||
        data.source.duration <= 0)
    )
      return fallback;
    if (!Number.isFinite(data.start) || !Number.isFinite(data.end)) return fallback;
    data.bindings = Object.fromEntries(
      DIMENSIONS.filter((d) =>
        [...ASSETS, ...data.importedAssets].some(
          (a) => a.id === data.bindings[d.id] && a.type === d.id,
        ),
      ).map((d) => [d.id, data.bindings[d.id]]),
    );
    interruptMockTasks(data);
    if (rangeError(data)) {
      invalidateAfter(data, 'range');
      data.step = Math.min(data.step, 2);
    }
    return data;
  } catch {
    return fallback;
  }
}

/** A cancelled field replacement must retain the already editable prompt package. */
export function interruptMockTasks(draft: MockDraft): void {
  for (const key of ['analysis', 'prompt', 'render'] as const) {
    if (draft[key] === 'running')
      draft[key] = key === 'prompt' && draft.promptRegeneration ? 'done' : 'failed';
  }
  draft.promptRegeneration = null;
}

export function regenerateMockPromptField(
  draft: MockDraft,
  field: 'text' | 'composition' | 'negative',
): void {
  const generated = { ...draft, bindings: { ...draft.bindings } };
  generateMockPrompts(generated);
  draft[field] = generated[field];
  draft.prompt = 'done';
  invalidateAfter(draft, 'prompt');
}

export function mockNodeStatus(draft: MockDraft, step: number): string {
  if (step === draft.step) return 'current';
  if (step === 1) return draft.source ? 'done' : 'pending';
  if (step === 2) return rangeError(draft) ? 'pending' : 'done';
  const state = step === 3 ? draft.analysis : step === 4 ? draft.prompt : draft.render;
  return state === 'idle' ? 'pending' : state;
}

export function mockArtifactFingerprint(draft: MockDraft): string {
  const source = draft.source;
  const range = [draft.start, draft.end];
  const bindings = draft.bindings;
  const prompts = [draft.text, draft.composition, draft.negative];
  const content =
    draft.step === 1
      ? { source }
      : draft.step === 2
        ? { source, range }
        : draft.step === 3
          ? { source, range, bindings }
          : draft.step === 4
            ? { source, range, bindings, prompts }
            : { source, range, bindings, prompts, render: draft.render };
  return JSON.stringify({ step: draft.step, ...content });
}
