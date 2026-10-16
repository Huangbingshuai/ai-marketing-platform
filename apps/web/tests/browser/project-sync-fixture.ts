/** Browser-only fixture. No request reaches the real API, storage or paid workers. */
import { createApp, h, ref } from 'vue';
import type { FinalOutputItem, FinalOutputRun } from '@ai-marketing/contracts';
import Output from '../../src/workflows/effect/final-output/EffectFinalOutputNodePage.vue';
import ActionConfirmationDialog from '../../src/shared/components/ActionConfirmationDialog.vue';
import '../../src/styles/global.css';

const mode = ref('ADDED'),
  version = ref(0);
const requests: { path: string; body: unknown }[] = [];
(window as unknown as { __syncRequests: typeof requests }).__syncRequests = requests;
let updated = false;
const item = (id: string, stale = false): FinalOutputItem => ({
  id,
  variantId: id,
  name: id === 'old' ? '原有成片' : '新增成片',
  cover: null,
  status: 'COMPLETED',
  duration: 24,
  fileObjectId: `qa-file-${id}`,
  assetId: `qa-asset-${id}`,
  errorMessage: null,
  progress: 100,
  stale,
});
const output = (): FinalOutputRun => {
  const removed = ['REMOVED', 'MIXED'].includes(mode.value);
  const added = ['ADDED', 'MIXED'].includes(mode.value);
  const items =
    mode.value === 'EMPTY' || (updated && removed) ? [] : [item('old', removed && !updated)];
  if (updated && added)
    items.push({ ...item('new'), status: 'QUEUED', progress: 0, fileObjectId: null });
  return {
    id: 'qa-out',
    workflowRunId: 'qa-run',
    templateId: 't',
    templateName: '隔离模板',
    status: updated && added ? 'QUEUED' : 'COMPLETED',
    createdAt: new Date().toISOString(),
    resolution: '1080p',
    frameRate: 25,
    validated: true,
    items,
    projectChanges: {
      added: added && !updated ? [{ variantId: 'new', name: '新增成片' }] : [],
      removedItemIds: removed && !updated ? ['old'] : [],
    },
    counts: {
      total: items.length,
      queued: updated && added ? 1 : 0,
      running: 0,
      completed: items.filter((entry) => entry.status === 'COMPLETED').length,
      failed: 0,
      stale: updated ? 0 : Number(added) + Number(removed),
    },
  };
};
window.fetch = async (input, init) => {
  const path = String(input),
    method = init?.method ?? 'GET';
  let data: unknown;
  if (path.endsWith('/local-update')) {
    requests.push({ path, body: JSON.parse(String(init?.body)) });
    updated = true;
    data = output();
  } else if (path.includes('/final-output/sync')) data = { refreshed: [] };
  else if (path.includes('/final-output?')) data = [output()];
  else if (path.includes('/template-mix?'))
    data = {
      draftRevision: 1,
      materials: [],
      draft: {
        schemaVersion: 1,
        activeTemplateId: 't',
        templates: [
          {
            id: 't',
            workspace: {
              editVersion: 1,
              template: { name: '隔离模板', slots: [] },
              variants: [],
            },
          },
        ],
      },
    };
  else if (path.includes('/workflow-runs/effect/branches'))
    data = { activeWorkflowRunId: 'qa-run', branches: [] };
  else throw new Error(`隔离回归阻止未匹配请求：${method} ${path}`);
  return new Response(JSON.stringify({ data, requestId: 'qa-sync' }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
createApp({
  setup: () => () =>
    h('main', { style: 'padding:12px' }, [
      h(
        'nav',
        { style: 'display:flex;gap:8px;margin-bottom:12px' },
        ['ADDED', 'REMOVED', 'MIXED', 'EMPTY'].map((value) =>
          h(
            'button',
            {
              onClick: () => {
                mode.value = value;
                updated = false;
                requests.splice(0);
                version.value++;
              },
            },
            value,
          ),
        ),
      ),
      h(Output, { key: version.value, projectId: 'qa-project', workflowRunId: 'qa-run' }),
      h(ActionConfirmationDialog),
    ]),
}).mount('#app');
