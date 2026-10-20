/** Explicit controlled browser fixture: local SVG previews, no business writes or model calls. */
import { createApp, h, ref, computed } from 'vue';
import type {
  ProductionAsset,
  ProductionTask,
  CustomizedImageSettings,
} from '@ai-marketing/contracts';
import Studio from '../../src/workflows/customized/production/ProductionAssetStudio.vue';
import Dialog from '../../src/workflows/customized/production/ProductionRenderDialog.vue';
import '../../src/styles/global.css';
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 420"><rect width="800" height="420" fill="#edf0f2"/><g fill="#faf9f5" stroke="#a5abb3" stroke-width="3"><rect x="110" y="85" width="138" height="240" rx="24"/><path d="M248 130h35q65 0 65 65t-65 65h-35" fill="none" stroke-width="16"/><rect x="425" y="85" width="120" height="240" rx="23"/><ellipse cx="670" cy="208" rx="55" ry="102"/></g><g fill="#8391a0" font-family="sans-serif" font-size="16"><text x="135" y="370">正面</text><text x="455" y="370">侧面</text><text x="640" y="370">俯视</text></g></svg>`;
// ProductionAssetVisual still uses its normal version-read API. This page supplies only local read fixtures.
window.fetch = async (input, init) => {
  const url = String(input);
  if (
    (!init?.method || init.method === 'GET') &&
    url.includes('/projects/image-ui-fixture/assets/')
  )
    return new Response(
      JSON.stringify({
        success: true,
        data: { contentUrl: 'data:image/svg+xml,' + encodeURIComponent(svg) },
      }),
      { headers: { 'Content-Type': 'application/json' } },
    );
  throw new Error('隔离交互验证不调用业务接口');
};
const items: ProductionAsset[] = [
  {
    id: 'cup',
    kind: 'PRODUCT',
    name: '白釉随行杯',
    description: '白釉陶瓷杯，统一杯身、杯口与把手结构。',
    knownFacts: '白釉外观',
    designNotes: '柔和中性光线',
    sourceText: '受控测试资料',
    imageRequirements: '同一对象多视角设定图',
    image: { assetId: 'cup-image', version: 1 },
  },
  {
    id: 'room',
    kind: 'SCENE',
    name: '窗边办公桌',
    description: '明亮的窗边办公空间，保持同一布局与材质。',
    knownFacts: '',
    designNotes: '自然侧光',
    sourceText: '受控测试资料',
    imageRequirements: '同一空间不同方向',
    image: { assetId: 'room-image', version: 1 },
  },
];
createApp({
  setup() {
    const assets = ref(items),
      open = ref(false),
      selected = ref([items[0]!]);
    const task = ref<ProductionTask>();
    const settings: CustomizedImageSettings = {
      model: 'doubao-seedream-5-0-flash-260915',
      resolution: '1K',
      ratio: '4:3',
      assetIds: ['cup'],
      inputs: [
        {
          assetId: 'cup',
          prompt:
            '同一白釉随行杯的多视角设定图，正面、侧面和俯视。各视角保持同一杯身与把手，柔和中性侧光，真实釉面。',
          references: [],
        },
      ],
    };
    const busy = computed(() => !!task.value && ['RUNNING', 'QUEUED'].includes(task.value.status));
    const show = (list: ProductionAsset[]) => {
      selected.value = list;
      open.value = true;
    };
    const generate = (input: CustomizedImageSettings) => {
      task.value = {
        id: 'controlled-image',
        operation: 'IMAGE',
        status: 'RUNNING',
        progress: 20,
        steps: [],
        shotId: null,
        errorMessage: null,
        imageSettings: input,
        completedImageAssetIds: [],
      };
    };
    const state = (status: ProductionTask['status'], completed: string[] = []) => {
      task.value = {
        id: 'controlled-image',
        operation: 'IMAGE',
        status,
        progress: status === 'COMPLETED' ? 100 : 50,
        steps: [],
        shotId: null,
        errorMessage:
          status === 'FAILED' ? '本次生成未完成，原图与提示词保留，可以重新生成。' : null,
        imageSettings: { ...settings, assetIds: ['cup', 'room'] },
        completedImageAssetIds: completed,
      };
    };
    return () =>
      h('main', { style: 'max-width:1540px;margin:30px auto;padding:0 24px;color:#263850' }, [
        h(
          'p',
          { style: 'font-size:12px;color:#8492a5' },
          '隔离交互验证 · 本页图片与任务为受控示例，不调用模型、不写项目数据',
        ),
        h('nav', { style: 'display:flex;gap:10px;flex-wrap:wrap;margin-bottom:24px' }, [
          h('button', { onClick: () => show([assets.value[0]!]) }, '打开单图制作'),
          h(
            'button',
            {
              onClick: () => {
                state('RUNNING');
                show(assets.value);
              },
            },
            '打开批量运行中',
          ),
          h('button', { onClick: () => state('QUEUED') }, '模拟排队'),
          h('button', { onClick: () => state('RUNNING', ['cup']) }, '模拟部分完成'),
          h('button', { onClick: () => state('COMPLETED', ['cup', 'room']) }, '模拟成功'),
          h('button', { onClick: () => state('FAILED', ['cup']) }, '模拟部分失败'),
        ]),
        h('h1', { style: 'font-size:23px' }, '资产准备'),
        h(
          'p',
          { style: 'color:#7e8fa7;margin-bottom:24px' },
          '统一公共形象，生成状态保留在对应资产中',
        ),
        h(Studio, {
          projectId: 'image-ui-fixture',
          assets: assets.value,
          shots: [],
          editing: false,
          locked: busy.value,
          imageTasks: task.value ? [task.value] : [],
          onImages: show,
        }),
        h(Dialog, {
          open: open.value,
          projectId: 'image-ui-fixture',
          workflowRunId: 'fixture-run',
          type: 'IMAGE',
          assets: selected.value,
          catalog: assets.value,
          task: task.value,
          settings,
          busy: busy.value,
          onClose: () => {
            open.value = false;
          },
          onGenerate: generate,
        }),
      ]);
  },
}).mount('#app');
