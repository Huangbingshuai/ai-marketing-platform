import { expect, it } from 'vitest';
import { emptyCustomizedBrief, type StoryboardInput } from '@ai-marketing/contracts';
import { storyboardDetail } from './storyboard-detail';
import brandFixture from '../../../../../../packages/contracts/fixtures/customized-brand-creation.json';
import dramaFixture from '../../../../../../packages/contracts/fixtures/customized-drama-creation.json';
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
it('shows original drama methods and independent selection, including partial progress', () => {
  const input = dramaFixture.input as unknown as StoryboardInput;
  for (const output of [
    dramaFixture.selection,
    { developmentResult: { value: dramaFixture.selection.development } },
  ]) {
    const content = JSON.stringify(
      storyboardDetail(
        input,
        [{ ...step('DRAMA_CONCEPT', output), scriptId: '' }],
        'DRAMA_CONCEPT',
      ),
    );
    expect(content).toContain('信息揭示安排');
    expect(content).toContain('对话试探');
    expect(content).toContain('具体人物行动0');
    expect(content).not.toContain('F01');
    expect(content).not.toContain('I0');
  }
  expect(
    JSON.stringify(
      storyboardDetail(
        input,
        [{ ...step('DRAMA_CONCEPT', dramaFixture.selection), scriptId: '' }],
        'DRAMA_CONCEPT',
      ),
    ),
  ).toContain('正文需要兑现');
});
it('shows real brand propositions, ideas and selection reasons without internal references', () => {
  const input = brandFixture.input as unknown as StoryboardInput;
  const steps = [
    { ...step('BRAND_AD_PROPOSITION', brandFixture.development), scriptId: '' },
    { ...step('BRAND_AD_IDEAS', brandFixture.development), scriptId: '' },
    { ...step('BRAND_AD_CONCEPT', brandFixture.selection), scriptId: '' },
  ];
  for (const node of ['BRAND_AD_PROPOSITION', 'BRAND_AD_IDEAS', 'BRAND_AD_CONCEPT'] as const) {
    const detail = storyboardDetail(input, steps, node);
    expect(detail.sections[2]!.items.length).toBeGreaterThan(0);
    expect(JSON.stringify(detail)).not.toContain('F01');
  }
  expect(JSON.stringify(storyboardDetail(input, steps, 'BRAND_AD_PROPOSITION'))).toContain(
    '未经受众调研验证',
  );
  expect(JSON.stringify(storyboardDetail(input, steps, 'BRAND_AD_CONCEPT'))).toContain(
    '创意保留清单',
  );
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
it('shows actual type, soft reference and custom section body without old instructions', () => {
  const content = 'P01｜产品亮相\n\n橙色端口从深灰轮廓中显现。';
  const result = storyboardDetail(
    {
      ...input,
      outputMode: 'STORY_ONLY',
      storyFormat: 'VIDEO_SCRIPT_V2',
      settings: {
        ...input.settings,
        videoType: 'BRAND_AD',
        structureMode: 'CUSTOM',
        structureSections: ['产品亮相'],
        instructions: '旧要求不得展示',
      },
    },
    [
      step('STORY', {
        title: '亮相',
        content,
        beats: [{ id: 'P01', content, durationSeconds: 42 }],
      }),
    ],
    'STORY',
  );
  expect(JSON.stringify(result)).toContain('品牌广告');
  expect(JSON.stringify(result)).toContain('参考 30 秒');
  expect(JSON.stringify(result)).not.toContain('旧要求不得展示');
  expect(result.sections[2]!.items.find((row) => row.title === '剧本正文')?.content).toBe(content);
});
it('preserves public screenplay scene headings and the exact body in workflow details', () => {
  const content = 'S01｜内景 · 候车区｜傍晚\n\n周越合上电脑。\n\n周越：走吧。';
  const result = storyboardDetail(
    { ...input, outputMode: 'STORY_ONLY', storyFormat: 'SCREENPLAY_V1' },
    [
      step('STORY', {
        title: '候车时刻',
        content,
        beats: [{ id: 'S01', content, durationSeconds: 30 }],
      }),
    ],
    'STORY',
  );
  expect(result.sections[2]!.items.find((row) => row.title === '剧本正文')?.content).toBe(content);
});
it('projects actual and proposed asset identifiers into readable business objects without changing checkpoints', () => {
  const steps = [
    step('STORY', { beats: [{ id: 'B3' }] }),
    step('SHOTS', { assets: [{ id: 'prod_phone', name: '不具名智能手机' }], shots: [] }),
    step('REPAIR', { script: { assets: [{ id: 'prod_client_phone', name: '负责人的手机' }] } }),
    step('REVIEW', {
      summary: '同一prod_phone被用于两台设备，Beat B3需同步assetRequirements',
      findings: [
        {
          message: 'prod_phone引用混乱',
          evidence: 'prod_phone与prod_client_phone不同',
          suggestion: '拆分为prod_xuhe_phone和prod_client_phone，保留USB-C端口说明',
          shotIds: [],
        },
      ],
    }),
  ];
  const original = JSON.stringify(steps);
  const text = JSON.stringify(storyboardDetail(input, steps, 'REVIEW', 'script-id'));
  expect(text).not.toMatch(/prod_(phone|client_phone|xuhe_phone)/);
  expect(text).toContain('同一不具名智能手机被用于两台设备');
  expect(text).toContain('负责人的手机');
  expect(text).toContain('待定义产品对象');
  expect(text).toContain('USB-C端口说明');
  expect(text).toContain('故事段落 1需同步资产关联');
  expect(text).not.toContain('Beat B3');
  expect(text).not.toContain('assetRequirements');
  expect(JSON.stringify(steps)).toBe(original);
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

it('translates leaked creative hypothesis and candidate labels without changing stored output', () => {
  const development = structuredClone(brandFixture.development);
  development.proposition.audienceObservation = 'CREATIVE_HYPOTHESIS：具体观察';
  const selection = { ...brandFixture.selection, reason: development.ideas[0]!.id + '有具体画面' };
  const steps = [
    { ...step('BRAND_AD_PROPOSITION', development), scriptId: '' },
    { ...step('BRAND_AD_IDEAS', development), scriptId: '' },
    { ...step('BRAND_AD_CONCEPT', selection), scriptId: '' },
  ];
  const original = JSON.stringify(steps);
  const input = brandFixture.input as unknown as StoryboardInput;
  expect(JSON.stringify(storyboardDetail(input, steps, 'BRAND_AD_PROPOSITION'))).not.toContain(
    'CREATIVE_HYPOTHESIS',
  );
  expect(
    JSON.stringify(
      [0, 1, 2, 3].map((page) =>
        storyboardDetail(input, steps, 'BRAND_AD_CONCEPT', undefined, page),
      ),
    ),
  ).toContain('候选创意 1有具体画面');
  expect(JSON.stringify(steps)).toBe(original);
});

it('shows real commerce motives, demonstration boundaries and independent selection', async () => {
  const fixture = (
    await import('../../../../../../packages/contracts/fixtures/customized-commerce-creation.json')
  ).default;
  const source = fixture.input as unknown as StoryboardInput;
  const steps = [
    { ...step('ECOMMERCE_MOTIVATION', fixture.development), scriptId: '' },
    { ...step('ECOMMERCE_CONCEPT', fixture.selection), scriptId: '' },
  ];
  const development = JSON.stringify(storyboardDetail(source, steps, 'ECOMMERCE_MOTIVATION'));
  expect(development).toContain('购买理由');
  expect(development).toContain('可观察结果');
  expect(development).toContain('不据此推导未知性能');
  expect(development).toContain('未经受众调研验证');
  const choice = JSON.stringify(storyboardDetail(source, steps, 'ECOMMERCE_CONCEPT'));
  expect(choice).toContain('独立择优结论');
  expect(choice).toContain('需要兑现的演示');
  for (const detail of [development, choice]) {
    expect(detail).not.toContain('F02');
    expect(detail).not.toContain('O01');
  }
});

it('shows the retained reason when every commerce opportunity is rejected', async () => {
  const fixture = (
    await import('../../../../../../packages/contracts/fixtures/customized-commerce-creation.json')
  ).default;
  const source = fixture.input as unknown as StoryboardInput;
  const decision = {
    status: 'REWORK',
    reason: '没有可观察的购买利益',
    missing: [],
    choices: [],
    concepts: [],
    evaluations: fixture.selection.evaluations.map((e) => ({
      ...e,
      verdict: 'REJECT',
      reason: '只有参数目录',
    })),
  };
  const steps = [
    { ...step('ECOMMERCE_MOTIVATION', fixture.development), scriptId: '' },
    {
      ...step('ECOMMERCE_CONCEPT', { secondSelection: { value: decision }, exhausted: true }),
      status: 'FAILED',
      scriptId: '',
    },
  ];
  const detail = JSON.stringify(storyboardDetail(source, steps, 'ECOMMERCE_CONCEPT'));
  expect(detail).toContain('没有可观察的购买利益');
  expect(detail).toContain('只有参数目录');
  expect(detail).not.toContain('需要兑现的演示');
});

it('shows presenter and creative arrangements in both development and selected details', async () => {
  const fixture = (
    await import('../../../../../../packages/contracts/fixtures/customized-commerce-creation.json')
  ).default;
  const development = structuredClone(fixture.development);
  const opportunity = development.opportunities[0]!;
  Object.assign(opportunity, {
    creativeIdea: '把购买疑问变成可观察选择',
    approach: {
      speaker: '讲述者自然面对观众',
      recommendation: '从实际需要讲解选择',
      speechAndVisual: '人物口播与实物近景互补',
    },
  });
  const source = {
    ...fixture.input,
    strategyVersions: Object.fromEntries(
      ['concept', 'story', 'review', 'repair'].map((k) => [k, '2026-10-14-presenter.1']),
    ),
  } as unknown as StoryboardInput;
  const selection = { ...fixture.selection, reason: `${opportunity.id}有实际讲述关系` };
  const steps = [
    { ...step('ECOMMERCE_MOTIVATION', development), scriptId: '' },
    { ...step('ECOMMERCE_CONCEPT', selection), scriptId: '' },
  ];
  for (const node of ['ECOMMERCE_MOTIVATION', 'ECOMMERCE_CONCEPT'] as const) {
    const detail = JSON.stringify(storyboardDetail(source, steps, node));
    expect(detail).toContain('讲述者自然面对观众');
    expect(detail).toContain('人物口播与实物近景互补');
    expect(detail).toContain('把购买疑问变成可观察选择');
    expect(detail).not.toContain('speechAndVisual');
    expect(detail).not.toContain(opportunity.id);
  }
});
