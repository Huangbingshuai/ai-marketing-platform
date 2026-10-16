/** Browser-only fixture; every API request is intercepted, including all mutations. */
import { createApp, h, ref } from 'vue';
import type {
  EffectTemplateMixAiRun,
  EffectTemplateMixRole,
  EffectTemplateMixSlot,
  EffectTemplateMixVariant,
} from '@ai-marketing/contracts';
import Mix from '../../src/workflows/effect/template-mix/EffectTemplateMixNodePage.vue';
import ActionConfirmationDialog from '../../src/shared/components/ActionConfirmationDialog.vue';
import '../../src/styles/global.css';

const mode = ref('READY'),
  version = ref(0),
  mutations = ref(0),
  notice = ref('');
const roles: EffectTemplateMixRole[] = [
  'HOOK',
  'PAIN_POINT',
  'PRODUCT',
  'SELLING_POINT',
  'TRANSFORMATION',
  'END',
];
const slots: EffectTemplateMixSlot[] = roles.map((role, i) => ({
  id: `s${i}`,
  role,
  label: `槽位${i + 1}`,
  duration: 4,
  purpose: 'PRODUCT_DISPLAY',
  transition: '硬切',
}));
const variant: EffectTemplateMixVariant = {
  id: 'old',
  name: '原有成片（不得改写）',
  appliedTemplateVersion: 1,
  slots,
  bindings: Object.fromEntries(slots.map((slot, i) => [slot.id, `m${i}`])),
  bindingRevisions: Object.fromEntries(slots.map((slot) => [slot.id, 1])),
  offsets: {},
  manualSlotIds: [],
  conflictSlotIds: [],
  status: 'CURRENT',
  captions: [],
  subtitleStyle: 'standard',
  bgm: null,
  voice: null,
  originalVolume: 1,
};
const materials = Array.from({ length: 8 }, (_, i) => ({
  id: `m${i}`,
  code: `R-${i + 1}`,
  name: `隔离素材${i + 1}`,
  duration: 10,
  purpose: 'PRODUCT_DISPLAY',
  compatiblePurposes: ['PRODUCT_DISPLAY'],
  artifactId: `m${i}`,
  artifactKey: `render-clip:m${i}`,
  artifactRevision: 1,
  fileObjectId: `f${i}`,
  contentHash: `hash${i}`,
  contentUrl: '',
  ratio: '9:16',
  resolution: '720p',
  available: true,
  sourcePromptId: `p${i}`,
  activeSource: true,
}));
let projects = [structuredClone(variant)];
const makeRun = (): EffectTemplateMixAiRun => ({
  id: 'qa-append',
  workflowRunId: 'qa-run',
  templateId: 't',
  operation: 'APPEND',
  status: mode.value === 'RUNNING' ? 'RUNNING' : mode.value === 'FAILED' ? 'FAILED' : 'COMPLETED',
  stage: mode.value === 'RUNNING' ? 'TRIMMING' : 'COMPLETED',
  progress: mode.value === 'RUNNING' ? 65 : 100,
  targetVariantId: null,
  outputVariantId: 'new-film',
  outputVariantIds: ['new-film'],
  packageNewVariants: true,
  newMaterialUsage: [
    { materialId: 'm6', code: 'R-7', filmCount: 1 },
    { materialId: 'm7', code: 'R-8', filmCount: 0 },
  ],
  omittedNewMaterials: [{ materialId: 'm7', code: 'R-8', reason: '无足够有意义的观看差异' }],
  errorCode: mode.value === 'CONTINUATION' ? 'APPEND_CONTINUATION_FAILED' : null,
  errorMessage:
    mode.value === 'CONTINUATION'
      ? '新增成片同步暂未完成，请继续更新'
      : mode.value === 'FAILED'
        ? '隔离失败场景；原工程保留'
        : null,
  createdAt: '2026-10-04T00:00:00Z',
  updatedAt: '2026-10-04T00:00:00Z',
});
const workspace = () => ({
  draftRevision: 1,
  templateCreationReady: true,
  slotDurationMaxSeconds: 10,
  draft: {
    schemaVersion: 1,
    activeTemplateId: 't',
    templates:
      mode.value === 'EMPTY'
        ? []
        : [
            {
              id: 't',
              workspace: {
                editVersion: 1,
                template: { name: '隔离测试模板', editVersion: 1, slots },
                variants: structuredClone(projects),
              },
            },
          ],
  },
  materials,
  commits: [],
  classificationPools: [],
  aiRuns: ['RUNNING', 'COMPLETED', 'CONTINUATION', 'FAILED'].includes(mode.value)
    ? [makeRun()]
    : [],
  pendingAddedMaterialIds: { t: ['m6', 'm7'] },
});
window.fetch = async (input, init) => {
  const path = String(input),
    method = init?.method ?? 'GET';
  if (mode.value === 'LOADING') await new Promise((resolve) => setTimeout(resolve, 1500));
  if (mode.value === 'ERROR' && path.includes('/template-mix?'))
    return new Response(JSON.stringify({ message: '隔离网络错误，旧数据未被删除' }), {
      status: 503,
    });
  if (method !== 'GET') mutations.value++;
  let data: unknown;
  if (path.includes('/branches')) data = { branches: [] };
  else if (path.includes('/background-')) data = null;
  else if (path.includes('/sources?'))
    data = { materials, draftRevision: 1, pendingAddedMaterialIds: { t: ['m6', 'm7'] } };
  else if (path.includes('/resume-append')) {
    mode.value = 'COMPLETED';
    data = makeRun();
  } else if (path.includes('/ai-fill-runs')) {
    if (method === 'POST') {
      const body = JSON.parse(String(init?.body));
      if (!body.appendNewMaterials) throw new Error('隔离验收禁止完整填充');
      mode.value = 'RUNNING';
    }
    data = makeRun();
  } else if (path.includes('/variants/') && path.endsWith('/delete')) {
    const id = decodeURIComponent(path.split('/variants/')[1]!.split('/')[0]!);
    projects = projects.filter((project) => project.id !== id);
    data = { ...workspace(), draftRevision: 2 };
  } else if (path.endsWith('/empty-variants')) {
    projects.push({
      ...structuredClone(variant),
      id: `manual-${projects.length}`,
      name: '新建成片',
      bindings: {},
      bindingRevisions: {},
      conflictSlotIds: slots.map((slot) => slot.id),
    });
    data = { ...workspace(), draftRevision: 2 };
  } else if (path.includes('/template-mix?')) data = workspace();
  else if (path.includes('/draft')) data = { ...workspace(), draftRevision: 2 };
  else if (path.includes('/packaging-runs')) data = [];
  else if (path.includes('/voice')) data = [];
  else if (path.includes('/music')) data = [];
  else if (path.includes('/final-output/sync')) data = { refreshed: [] };
  else if (path.includes('/final-output')) data = [];
  else throw new Error(`隔离验收阻止未匹配请求: ${method} ${path}`);
  return new Response(JSON.stringify({ data, requestId: 'qa' }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
createApp({
  setup: () => () =>
    h('main', { style: 'padding:12px' }, [
      h(
        'nav',
        { style: 'display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px' },
        [
          'READY',
          'RUNNING',
          'COMPLETED',
          'CONTINUATION',
          'FAILED',
          'EMPTY',
          'ERROR',
          'LOADING',
        ].map((value) =>
          h(
            'button',
            {
              onClick: () => {
                mode.value = value;
                projects = [structuredClone(variant)];
                version.value++;
              },
            },
            value,
          ),
        ),
      ),
      h(
        'p',
        { 'data-testid': 'fixture-state' },
        `隔离模式 ${mode.value} · 模拟写入 ${mutations.value} · ${notice.value}`,
      ),
      h(Mix, {
        key: version.value,
        projectId: 'qa-project',
        workflowRunId: 'qa-run',
        products: [],
        onNotice: (text: string) => {
          notice.value = text;
        },
      }),
      h(ActionConfirmationDialog),
    ]),
}).mount('#app');
