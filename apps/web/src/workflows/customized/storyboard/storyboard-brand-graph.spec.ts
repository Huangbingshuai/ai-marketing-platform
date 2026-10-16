import { expect, it, vi } from 'vitest';
import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';
import type { StoryboardTask } from '@ai-marketing/contracts';
import Dialog from './StoryboardExecutionDialog.vue';

vi.mock('../../../platform/workflow/components/WorkflowExecutionGraphDialog.vue', async () => {
  const { defineComponent, h } = await import('vue');
  return {
    default: defineComponent({
      props: ['nodes', 'open'],
      setup: (props) => () => h('section', JSON.stringify(props.nodes)),
    }),
  };
});

it.each(['2026-10-14-drama.1', '2026-10-14-drama.2', '2026-10-14.7'])(
  'uses the shared graph with frozen drama version %s',
  async (version) => {
    const task = {
      id: 'drama-task',
      workflowRunId: 'run',
      status: 'RUNNING',
      progress: 10,
      graphVersion: 'TYPED_CREATION_V1',
      routeId: 'DRAMA',
      outputMode: 'STORY_ONLY',
      strategyVersions: { concept: version, story: version, review: version, repair: version },
      steps: [],
      errorMessage: null,
      createdAt: '2026-10-14T00:00:00Z',
      updatedAt: '2026-10-14T00:00:00Z',
    } as StoryboardTask;
    const context = {};
    const body = await renderToString(
      createSSRApp(Dialog, { open: true, projectId: 'project', task, scripts: [] }),
      context,
    );
    const html = body + JSON.stringify(context);
    expect(html.includes('剧情开发与独立择优')).toBe(version.includes('drama'));
    expect(html).toContain('剧情专项审校');
    expect(html).not.toContain('品牌传播命题');
  },
);

it.each([
  '2026-10-14.1',
  '2026-10-14.2',
  '2026-10-14.3',
  '2026-10-14.4',
  '2026-10-14.5',
  '2026-10-14.6',
  '2026-10-14.7',
  '2026-10-13.11',
])('renders the real brand graph for frozen version %s', async (version) => {
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
});

it.each([
  '2026-10-14-commerce.1',
  '2026-10-14-commerce.2',
  '2026-10-14-commerce.3',
  '2026-10-14-commerce.4',
  '2026-10-14-commerce.5',
  '2026-10-14-presenter.1',
  '2026-10-14-presenter.2',
  '2026-10-14-presenter.3',
  '2026-10-14.7',
])('keeps frozen commerce graph %s', async (version) => {
  const task = {
    id: 'commerce-task',
    workflowRunId: 'run',
    status: 'RUNNING',
    progress: 10,
    graphVersion: 'TYPED_CREATION_V1',
    routeId: 'ECOMMERCE',
    outputMode: 'STORY_ONLY',
    strategyVersions: { concept: version, story: version, review: version, repair: version },
    steps: [],
    errorMessage: null,
    createdAt: '2026-10-14T00:00:00Z',
    updatedAt: '2026-10-14T00:00:00Z',
  } as StoryboardTask;
  const context = {};
  const body = await renderToString(
    createSSRApp(Dialog, { open: true, projectId: 'project', task, scripts: [] }),
    context,
  );
  const html = body + JSON.stringify(context);
  expect(html.includes('购买动机与演示策划')).toBe(version.includes('commerce'));
  expect(html.includes('带货方案独立择优')).toBe(version.includes('commerce'));
  expect(html.includes('口播推荐策略与创意')).toBe(version.includes('presenter'));
  expect(html.includes('口播创意独立择优')).toBe(version.includes('presenter'));
  expect(html).not.toContain('品牌传播命题');
});
