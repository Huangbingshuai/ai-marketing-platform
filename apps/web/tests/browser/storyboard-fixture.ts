/** Explicit browser test only; production never imports this entry. No real API or paid tasks. */
import { createApp, h, ref } from 'vue';
import { CUSTOMIZED_STORYBOARD_STAGES, type StoryboardTask } from '@ai-marketing/contracts';
import Page from '../../src/workflows/customized/storyboard/CustomizedStoryboardNodePage.vue';
import Loading from '../../src/platform/workflow/components/WorkflowPageLoading.vue';
import Confirmation from '../../src/shared/components/ActionConfirmationDialog.vue';
import { emptyStoryboardDraft } from '../../src/workflows/customized/storyboard/storyboard-state';
import { storyboardFixture } from '../../src/workflows/customized/storyboard/__fixtures__/storyboard.fixture';
import '../../src/styles/global.css';

const state = ref('filled'),
  draft = ref(storyboardFixture()),
  editing = ref(false);
const events = ref<string[]>([]);
const extraAsset = {
  id: 'unused',
  kind: 'products' as const,
  name: '未引用产品定义',
  description: '后端目录返回但当前镜头未使用的完整外观',
};
draft.value.scripts[0]!.assets!.push(extraAsset);
const requests: string[] = [];
Object.assign(window, { __storyboardTest: { events, requests } });
window.fetch = async (input, init) => {
  const path = String(input);
  requests.push(`${init?.method ?? 'GET'} ${path}`);
  if (!path.includes('/tasks/test-task/nodes/')) throw new Error('隔离回归禁止真实网络与付费请求');
  return new Response(
    JSON.stringify({
      data: {
        nodeId: path.split('/nodes/')[1]!.split('?')[0],
        status: 'SUCCEEDED',
        summary: '真实契约详情测试',
        updatedAt: '2026-10-12T00:00:00Z',
        page: 0,
        hasMore: false,
        sections: [
          {
            kind: 'INPUT',
            title: '创作依据',
            items: [{ title: '信息卡', content: '测试信息卡完整依据' }],
          },
          {
            kind: 'OUTPUT',
            title: '结果',
            items: [
              {
                title: '完整故事',
                content: '故事、开场、发展与收束完整返回；审校与修订通过其他节点查看。',
              },
            ],
          },
        ],
      },
    }),
    { headers: { 'Content-Type': 'application/json' } },
  );
};
const task = (): StoryboardTask | null => {
  const statuses = {
    running: 'RUNNING',
    completed: 'COMPLETED',
    failed: 'FAILED',
    partial: 'PARTIAL',
    cancelled: 'CANCELLED',
  } as const;
  if (!(state.value in statuses)) return null;
  const status = statuses[state.value as keyof typeof statuses];
  return {
    id: 'test-task',
    workflowRunId: 'test-run',
    status,
    progress: status === 'COMPLETED' ? 100 : 35,
    errorMessage: status === 'FAILED' ? '测试服务暂时不可用，已完成脚本保留' : null,
    createdAt: '2026-10-12T00:00:00Z',
    updatedAt: '2026-10-12T00:00:00Z',
    steps: CUSTOMIZED_STORYBOARD_STAGES.map((n) => ({
      nodeId: n.id,
      scriptId: '',
      status: status === 'COMPLETED' ? 'SUCCEEDED' : 'PENDING',
      errorMessage: null,
      updatedAt: '2026-10-12T00:00:00Z',
    })),
  };
};
const reset = (value: string) => {
  state.value = value;
  editing.value = value === 'editing';
  draft.value = ['empty', 'source-missing'].includes(value)
    ? emptyStoryboardDraft()
    : storyboardFixture();
  if (draft.value.scripts[0]) draft.value.scripts[0].assets!.push(extraAsset);
};
createApp({
  setup: () => () => {
    const currentTask = task();
    return h('main', { style: 'padding:20px;max-width:1800px;margin:auto' }, [
      h(
        'nav',
        {
          style: 'display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px',
          'aria-label': '隔离测试状态',
        },
        [
          'filled',
          'editing',
          'empty',
          'source-missing',
          'loading',
          'running',
          'completed',
          'failed',
          'partial',
          'cancelled',
          'stale',
        ].map((s) => h('button', { onClick: () => reset(s) }, s)),
      ),
      state.value === 'loading'
        ? h(Loading, { title: '正在加载分镜脚本…', description: '隔离加载态', icon: 'extraction' })
        : h(Page, {
            key: state.value,
            draft: draft.value,
            'onUpdate:draft': (v) => {
              draft.value = v;
            },
            editing: editing.value,
            sourceReady: state.value !== 'source-missing',
            readonly: state.value === 'source-missing',
            saving: false,
            productName: '测试产品',
            saveMessage: '当前脚本版本 1',
            error: '',
            stale: state.value === 'stale',
            projectId: 'isolated-browser-test',
            task: currentTask,
            brief: null,
            sourceRevision: 1,
            nextReady: !!draft.value.scripts.length,
            progress: currentTask
              ? {
                  value: currentTask.progress,
                  summary: `测试任务 ${currentTask.status}`,
                  terminal: currentTask.status !== 'RUNNING',
                }
              : undefined,
            onBegin: () => {
              editing.value = true;
            },
            onCancel: () => {
              editing.value = false;
            },
            onSave: () => {
              events.value.push('save');
              editing.value = false;
            },
            onSelect: (id: string) => {
              draft.value.activeScriptId = id;
            },
            onCreate: (s) => {
              events.value.push('create');
              draft.value.scripts.push(s);
              draft.value.activeScriptId = s.id;
              editing.value = true;
            },
            onGenerate: () => events.value.push('generate'),
            onRetry: () => events.value.push('retry'),
            onStop: () => events.value.push('stop'),
          }),
      h(Confirmation),
    ]);
  },
}).mount('#app');
