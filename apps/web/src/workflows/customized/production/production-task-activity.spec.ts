import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { expect, it } from 'vitest';
import type { ProductionTask } from '@ai-marketing/contracts';
import Activity from './ProductionTaskActivity.vue';

it('shows persisted stage and progress without inventing a timer', async () => {
  const html = await renderToString(
    createSSRApp(Activity, {
      label: '提示词生成进度',
      task: {
        status: 'RUNNING',
        progress: 63,
        steps: [{ status: 'RUNNING', content: '核对当前画面与引用' }],
      } as ProductionTask,
    }),
  );
  expect(html).toContain('核对当前画面与引用');
  expect(html).toContain('aria-valuenow="63"');
  expect(html).toContain('width:63%');
});

it.each(['COMPLETED', 'FAILED', 'CANCELLED'] as const)(
  'removes local progress at terminal state %s',
  async (status) => {
    const html = await renderToString(
      createSSRApp(Activity, {
        label: '视频渲染进度',
        task: {
          id: 'task',
          operation: 'PROMPT',
          status,
          progress: 100,
          steps: [],
          errorMessage: null,
          shotId: null,
        },
      }),
    );
    expect(html).not.toContain('progressbar');
    expect(html).not.toContain('100%');
  },
);

it('keeps a queued task at its server progress and labels it as waiting', async () => {
  const html = await renderToString(
    createSSRApp(Activity, {
      label: '视频渲染进度',
      task: { status: 'QUEUED', progress: 0, steps: [] } as unknown as ProductionTask,
    }),
  );
  expect(html).toContain('等待执行');
  expect(html).toContain('aria-valuenow="0"');
});
