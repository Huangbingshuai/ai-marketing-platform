import { expect, it, vi } from 'vitest';
import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';
import type { StoryboardTask } from '@ai-marketing/contracts';
import Dialog from './StoryboardExecutionDialog.vue';

vi.mock('../../../platform/workflow/components/WorkflowExecutionGraphDialog.vue', async () => {
  const { defineComponent, h } = await import('vue');
  return { default: defineComponent({ props: ['nodes', 'open'], setup: props => () => h('section', JSON.stringify(props.nodes)) }) };
});

it.each(['2026-10-14.1', '2026-10-14.2', '2026-10-14.3', '2026-10-14.4', '2026-10-14.5', '2026-10-14.6', '2026-10-14.7', '2026-10-13.11'])(
  'renders the real brand graph for frozen version %s',
  async (version) => {
    const task: StoryboardTask = {
      id: 'task',
      workflowRunId: 'run',
      status: 'RUNNING',
      progress: 10,
      graphVersion: 'TYPED_CREATION_V1',
      routeId: 'BRAND_AD',
      outputMode: 'STORY_ONLY',
      strategyVersions: { concept: version, story: version, review: version, repair: version },
      steps: [],
      errorMessage: null,
      createdAt: '2026-10-14T00:00:00Z',
      updatedAt: '2026-10-14T00:00:00Z',
    };
    const context = {};
    const body = await renderToString(
      createSSRApp(Dialog, { open: true, projectId: 'project', task, scripts: [] }),
      context,
    );
    const html = body + JSON.stringify(context);
    expect(html.includes('品牌传播命题')).toBe(version.startsWith('2026-10-14.'));
    expect(html.includes('品牌短创意开发')).toBe(version.startsWith('2026-10-14.'));
    expect(html).toContain('品牌专项审校');
  },
);
