/** Explicit browser-only fixture: never imported by the application, no real requests. */
import { createApp, h, ref } from 'vue';
import type { PackagingRun, EffectTemplateMixVariant } from '@ai-marketing/contracts';
import { packagingVisualTimeline } from '@ai-marketing/contracts';
import Packaging from '../../src/workflows/effect/template-mix/EffectTemplateMixPackaging.vue';

const mode = ref('COMPLETED'),
  mutationCount = ref(0),
  fixtureKey = ref(0);
const variants: EffectTemplateMixVariant[] = Array.from({ length: 10 }, (_, i) => ({
  id: `v-${i}`,
  name: `回归测试成片 ${i + 1}`,
  appliedTemplateVersion: 1,
  slots: [
    {
      id: 's',
      label: '产品',
      role: 'PRODUCT',
      purpose: 'PRODUCT_DISPLAY',
      duration: 10,
      transition: '硬切',
    },
  ],
  bindings: { s: 'm' },
  bindingRevisions: { s: 1 },
  offsets: { s: 0 },
  manualSlotIds: [],
  conflictSlotIds: [],
  status: 'CURRENT',
  captions: [],
  subtitleStyle: 'standard',
  bgm: null,
  voice: null,
  originalVolume: 1,
}));
const makeRun = (): PackagingRun => ({
  id: 'qa-run',
  workflowRunId: 'qa-workflow',
  templateId: 'qa-template',
  status: mode.value === 'FAILED' ? 'FAILED' : 'COMPLETED',
  createdAt: '2026-09-21T07:00:00.000Z',
  startedAt: '2026-09-21T07:00:01.000Z',
  completedAt: '2026-09-21T07:00:31.000Z',
  counts: {
    total: 10,
    completed: mode.value === 'FAILED' ? 0 : 10,
    failed: mode.value === 'FAILED' ? 10 : 0,
    stale: mode.value === 'STALE' ? 10 : 0,
    shards: 3,
  },
  items: variants.map((v, index) => ({
    id: `item-${index}`,
    variantId: v.id,
    name: v.name,
    shardIndex: Math.floor(index / 4),
    sourceTimelineHash: 'qa-hash',
    sourceVisualTimeline: packagingVisualTimeline(v),
    status: mode.value === 'FAILED' ? 'FAILED' : 'COMPLETED',
    stage: mode.value === 'FAILED' ? 'MUSIC' : 'READY',
    stale: mode.value === 'STALE',
    errorMessage: mode.value === 'FAILED' ? '音乐服务配置缺失（显式回归测试数据）' : null,
    startedAt: '2026-09-21T07:00:01.000Z',
    completedAt: '2026-09-21T07:00:31.000Z',
    checkpoint: {
      script: [
        {
          id: 'line-1',
          text: '这是一条测试口播，不是业务生成结果。',
          start: 1,
          end: 4,
          factIds: ['qa-fact'],
        },
      ],
      captions: [
        { id: 'line-1', text: '这是一条测试口播，不是业务生成结果。', start: 1, end: 3.21 },
      ],
      voices: {},
      vision: [],
    },
  })),
});
window.fetch = async (input, init) => {
  const url = String(input);
  if (!url.includes('/projects/qa-project/')) throw new Error('Fixture forbids real API calls');
  if (mode.value === 'LOADING') await new Promise((resolve) => setTimeout(resolve, 3000));
  if (mode.value === 'ERROR')
    return new Response(JSON.stringify({ message: '模拟网络错误，不代表后端故障' }), {
      status: 503,
    });
  if (init?.method === 'POST') mutationCount.value++;
  return new Response(
    JSON.stringify({
      success: true,
      data: mode.value === 'EMPTY' ? [] : init?.method === 'POST' ? makeRun() : [makeRun()],
    }),
    { headers: { 'content-type': 'application/json' } },
  );
};
createApp({
  setup() {
    const panel = ref<InstanceType<typeof Packaging>>();
    return () =>
      h(
        'main',
        { style: 'font-family:Arial,sans-serif;max-width:1200px;margin:24px auto;color:#173c6c;' },
        [
          h('h1', '包装组件隔离回归（不调用模型）'),
          h('p', `测试写请求：${mutationCount.value}`),
          h(
            'nav',
            { style: 'display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px' },
            ['COMPLETED', 'FAILED', 'EMPTY', 'STALE', 'LOADING', 'ERROR'].map((value) =>
              h(
                'button',
                {
                  onClick: () => {
                    mode.value = value;
                    fixtureKey.value++;
                  },
                },
                value,
              ),
            ),
          ),
          h('button', { onClick: () => panel.value?.open('ACTION') }, '打开批量确认'),
          h('button', { onClick: () => panel.value?.open('WORKFLOW') }, '打开包装工作流'),
          h(Packaging, {
            key: fixtureKey.value,
            ref: panel,
            projectId: 'qa-project',
            workflowRunId: 'qa-workflow',
            templateId: 'qa-template',
            variants,
            selectedVariantId: 'v-0',
            prepare: async () => 1,
            playhead: 0,
            playing: false,
          }),
        ],
      );
  },
}).mount('#app');
