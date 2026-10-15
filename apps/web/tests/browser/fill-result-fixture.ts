/** Explicit browser test entry; intercept every request and never call the real API. */
import { createApp, h, ref } from 'vue';
import type {
  EffectTemplateMixAiRun,
  EffectTemplateMixMaterial,
  EffectTemplateMixVariant,
} from '@ai-marketing/contracts';
import Mix from '../../src/workflows/effect/template-mix/EffectTemplateMixNodePage.vue';
import Confirmation from '../../src/shared/components/ActionConfirmationDialog.vue';
import { createEffectTemplateMixEntry } from '../../src/workflows/effect/template-mix/effect-template-mix-state';
import '../../src/styles/global.css';

const version = ref(0),
  completed = ref(false),
  released = ref(false),
  offline = ref(false);
const notices = ref<string[]>([]),
  requests = ref<string[]>([]);
const entry = createEffectTemplateMixEntry('填充衔接隔离模板');
entry.id = 't';
const slots = entry.workspace.template.slots;
const materials: EffectTemplateMixMaterial[] = slots.map((slot, i) => ({
  id: `m${i}`,
  code: `R-${i + 1}`,
  name: slot.label,
  duration: 15,
  purpose: slot.purpose,
  compatiblePurposes: [],
  artifactId: `a${i}`,
  artifactRevision: 1,
  artifactKey: `render-clip:m${i}`,
  fileObjectId: `f${i}`,
  contentHash: `hash${i}`,
  contentUrl: '',
  available: true,
  ratio: '3:4',
  resolution: '720p',
  sourcePromptId: `p${i}`,
  activeSource: true,
}));
const film: EffectTemplateMixVariant = {
  id: 'film',
  name: '已生成成片 01',
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
const run = (): EffectTemplateMixAiRun => ({
  id: 'fill',
  templateId: 't',
  workflowRunId: 'qa-fill-run',
  operation: 'FILL',
  status: completed.value ? 'COMPLETED' : 'RUNNING',
  stage: completed.value ? 'COMPLETED' : 'TRIMMING',
  progress: completed.value ? 100 : 80,
  targetVariantId: null,
  outputVariantId: completed.value ? 'film' : null,
  outputVariantIds: completed.value ? ['film'] : [],
  errorCode: null,
  errorMessage: null,
  createdAt: '2026-10-14T00:00:00Z',
  updatedAt: '2026-10-14T00:01:00Z',
});
const workspace = () => ({
  draftRevision: released.value ? 3 : 2,
  materials,
  templateCreationReady: true,
  slotDurationMaxSeconds: 15,
  draft: {
    schemaVersion: 1,
    activeTemplateId: 't',
    templates: [
      {
        ...entry,
        aiFillLocked: !released.value,
        workspace: { ...entry.workspace, variants: released.value ? [structuredClone(film)] : [] },
      },
    ],
  },
  commits: released.value
    ? [
        {
          templateId: 't',
          revision: 1,
          contentHash: 'hash',
          stale: false,
          editVersion: entry.workspace.editVersion,
        },
      ]
    : [],
  aiRuns: [run()],
  classificationPools: [],
});
window.fetch = async (input, init) => {
  const path = String(input),
    method = init?.method ?? 'GET';
  requests.value.push(`${method} ${path}`);
  if (offline.value && path.includes('/template-mix?')) {
    offline.value = false;
    throw new TypeError('isolated disconnected read');
  }
  let data: unknown;
  if (path.includes('/branches')) data = { branches: [] };
  else if (path.includes('/background-')) data = null;
  else if (path.includes('/ai-fill-runs/')) data = run();
  else if (path.includes('/sources?'))
    data = { materials, draftRevision: workspace().draftRevision };
  else if (path.includes('/template-mix?')) data = workspace();
  else if (path.endsWith('/draft') && method === 'PUT')
    data = { draftRevision: workspace().draftRevision };
  else if (method !== 'GET') throw new Error(`Blocked real mutation: ${method} ${path}`);
  else if (/packaging-runs|voices|music|final-output/.test(path)) data = [];
  else throw new Error(`Blocked unmatched request: ${path}`);
  return new Response(JSON.stringify({ data, requestId: 'isolated-fill' }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
Object.assign(window, { __fillResultTest: { requests, notices } });
createApp({
  setup: () => () =>
    h('main', { style: 'padding:12px' }, [
      h('nav', { style: 'display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px' }, [
        h(
          'button',
          {
            onClick: () => {
              completed.value = true;
            },
          },
          '任务完成（延迟结果）',
        ),
        h(
          'button',
          {
            onClick: () => {
              completed.value = true;
              released.value = true;
            },
          },
          '释放成片工程',
        ),
        h(
          'button',
          {
            onClick: () => {
              offline.value = true;
            },
          },
          '下次读取断网',
        ),
        h(
          'button',
          {
            onClick: () => {
              completed.value = false;
              released.value = false;
              version.value++;
            },
          },
          '重新开始隔离测试',
        ),
      ]),
      h('p', `仅隔离测试 · 完成回执 ${completed.value} · 工程已返回 ${released.value}`),
      h(Mix, {
        key: version.value,
        projectId: 'qa-fill-project',
        workflowRunId: 'qa-fill-run',
        products: [],
        onNotice: (text: string) => notices.value.push(text),
      }),
      h(Confirmation),
    ]),
}).mount('#app');
