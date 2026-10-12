import { expect, it } from 'vitest';
import { emptyCustomizedBrief, type StoryboardInput } from '@ai-marketing/contracts';
import { storyboardDetail } from './storyboard-detail';
const input: StoryboardInput = {
  schemaVersion: 1,
  source: { artifactId: 'internal-id', revision: 2, fingerprint: 'hash' },
  brief: { ...emptyCustomizedBrief(), productName: '杯子' },
  settings: {
    targetDurationSeconds: 30,
    variantCount: 1,
    structureMode: 'AI',
    structure: '',
    instructions: '',
  },
  scriptIds: ['script-id'],
  existingConcepts: [],
  models: { creative: 'pro', detail: 'turbo' },
  brandReferences: [],
};
const step = (nodeId: string, output: unknown) => ({
  nodeId,
  scriptId: 'script-id',
  status: 'SUCCEEDED',
  output,
  errorMessage: null,
  updatedAt: new Date(),
});
it('paginates all shots without truncating actual results or exposing internal IDs', () => {
  const shots = Array.from({ length: 45 }, (_, i) => ({
    id: `internal-${i}`,
    title: `标题${i + 1}`,
    visual: `画面${i + 1}`,
    durationSeconds: 1,
    assetRequirements: {},
  }));
  const steps = [step('SHOTS', { shots })];
  const pages = [0, 1, 2].map((page) => storyboardDetail(input, steps, 'SHOTS', 'script-id', page));
  expect(pages.map((p) => p.sections[2]!.items.length)).toEqual([20, 20, 5]);
  expect(pages.map((p) => p.hasMore)).toEqual([true, true, false]);
  expect(JSON.stringify(pages)).not.toContain('internal-');
  expect(pages[2]!.sections[2]!.items[4]!.content).toContain('画面45');
});
it('shows evidence, affected shot names and meaningful skip results', () => {
  const steps = [
    step('SHOTS', { shots: [{ id: 'shot-id', title: '倒水' }] }),
    step('REVIEW', {
      summary: '需要修改',
      findings: [
        {
          shotIds: ['shot-id'],
          message: '未知认证',
          evidence: 'shot-id：简报未提供认证',
          suggestion: '删除认证标识',
        },
      ],
    }),
  ];
  const detail = storyboardDetail(input, steps, 'REVIEW', 'script-id');
  expect(detail.sections[2]!.items[1]!.content).toContain('镜头 1 · 倒水');
  expect(detail.sections[2]!.items[1]!.content).toContain('简报未提供认证');
  expect(JSON.stringify(detail)).not.toContain('shot-id');
  expect(
    storyboardDetail(input, [{ ...step('REPAIR', {}), status: 'SKIPPED' }], 'REPAIR', 'script-id')
      .sections[2]!.items[0]!.title,
  ).toBe('无需修订');
});
it('does not fabricate outputs before a stage runs', () => {
  const result = storyboardDetail(input, [], 'STORY');
  expect(result.status).toBe('PENDING');
  expect(result.sections[2]!.items).toEqual([]);
});
it('renders model shot labels and repair references as user-facing shot numbers', () => {
  const script = { shots: [{ id: 'stable-shot', title: '倒水' }] };
  const detail = storyboardDetail(
    input,
    [
      step('REPAIR', {
        script,
        reason: 'shot-01 的动作过多',
        changes: [
          {
            before: 'stable-shot：连续三个动作',
            after: 'shot_1：只倒水',
            reason: 'shot-01 时长不足',
          },
        ],
        review: { summary: 'shot-01 已修正', findings: [] },
      }),
    ],
    'REPAIR',
  );
  const text = JSON.stringify(detail);
  expect(text).not.toContain('stable-shot');
  expect(text).not.toContain('shot-01');
  expect(text).not.toContain('shot_1');
  expect(text).toContain('镜头 1 的动作过多');
});
it('shows saved chunks and actionable validation errors without displaying rejected shots as completed', () => {
  const detail = storyboardDetail(
    input,
    [
      {
        ...step('SHOTS', {
          chunks: [{ shots: [{ title: '已保存画面', visual: '倒水', durationSeconds: 10 }] }],
          rejectedChunk: {
            chunk: { shots: [{ title: '未采用画面', visual: '不完整' }] },
            issues: [{ code: 'DURATION_SUM', expected: 20, actual: 5 }],
            correctionComplete: true,
          },
        }),
        status: 'FAILED',
      },
    ],
    'SHOTS',
  );
  const text = JSON.stringify(detail);
  expect(text).toContain('已保存画面');
  expect(text).toContain('目标 20 秒');
  expect(text).toContain('当前镜头合计 5 秒');
  expect(text).not.toContain('未采用画面');
  expect(text).not.toContain('DURATION_SUM');
});
