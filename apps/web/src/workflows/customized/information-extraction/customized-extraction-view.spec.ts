import { describe, expect, it } from 'vitest';
import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';
import CustomizedInfoExtractionNodePage from './CustomizedInfoExtractionNodePage.vue';
import {
  customizedExtractionEditable,
  customizedExtractionReady,
  emptyCustomizedExtractionView,
} from './customized-extraction-view';

describe('customized extraction confirmation boundary', () => {
  it('creates independent empty views without invented results', () => {
    const first = emptyCustomizedExtractionView();
    first.fields.subjectName = '人工输入';
    first.facts.push({ id: 'one', text: '资料中的事实', sourceIds: [] });
    const second = emptyCustomizedExtractionView();
    expect(Object.values(second.fields).every((value) => value === '')).toBe(true);
    expect(second.facts).toEqual([]);
    expect(second.committed).toBe(false);
  });
  it('does not enable downstream from a successful but unconfirmed result', () => {
    const view = { ...emptyCustomizedExtractionView(), status: 'COMPLETED' as const };
    expect(customizedExtractionReady(view, true, true)).toBe(false);
    expect(customizedExtractionReady({ ...view, committed: true }, true, true)).toBe(true);
  });
  it.each(['EMPTY', 'QUEUED', 'RUNNING', 'FAILED', 'PARTIAL', 'STALE'] as const)(
    'blocks downstream for %s even with an older confirmed result',
    (status) => {
      const view = { ...emptyCustomizedExtractionView(), status, committed: true };
      expect(customizedExtractionReady(view, true, true)).toBe(false);
    },
  );
  it('blocks disabled services, unconfirmed sources, isolated edits, saves and unresolved blocking conflicts', () => {
    const view = {
      ...emptyCustomizedExtractionView(),
      status: 'COMPLETED' as const,
      committed: true,
    };
    expect(customizedExtractionReady(view, false, true)).toBe(false);
    expect(customizedExtractionReady(view, true, false)).toBe(false);
    expect(customizedExtractionReady({ ...view, editing: true }, true, true)).toBe(false);
    expect(customizedExtractionReady({ ...view, saving: true }, true, true)).toBe(false);
    const issue = {
      id: 'conflict',
      field: 'duration' as const,
      alternatives: ['30 秒', '60 秒'],
      sourceIds: ['a', 'b'],
      message: '资料时长不一致',
      blocking: true,
    };
    expect(customizedExtractionReady({ ...view, issues: [issue] }, true, true)).toBe(false);
    expect(
      customizedExtractionReady({ ...view, issues: [{ ...issue, blocking: false }] }, true, true),
    ).toBe(true);
  });
  it('allows edits only in a ready isolated view, never while running or without sources', () => {
    const view = {
      ...emptyCustomizedExtractionView(),
      status: 'COMPLETED' as const,
      editing: true,
    };
    expect(customizedExtractionEditable(view, true, true)).toBe(true);
    expect(customizedExtractionEditable({ ...view, status: 'STALE' }, true, true)).toBe(true);
    expect(customizedExtractionEditable({ ...view, status: 'RUNNING' }, true, true)).toBe(false);
    expect(customizedExtractionEditable(view, false, true)).toBe(false);
    expect(customizedExtractionEditable(view, true, false)).toBe(false);
    expect(customizedExtractionEditable({ ...view, saving: true }, true, true)).toBe(false);
  });
});

describe('customized extraction presentation', () => {
  const props = {
    projectId: 'test-project',
    workflowRunId: 'test-run',
    projectName: '展示项目',
    sourceConfirmed: true,
    sources: [],
  };
  it('renders the five actual information cards before backend integration without inventing a result', async () => {
    const html = await renderToString(createSSRApp(CustomizedInfoExtractionNodePage, props));
    for (const title of ['项目与视频用途', '品牌与产品信息', '目标受众', '创意与风格', '视频规格'])
      expect(html).toContain(title);
    expect(html).toContain('AI 提炼功能待接入');
    expect(html).toContain('下一步：分镜创作');
    expect(html).toContain('readonly');
    expect(html).not.toContain('客户');
    for (const removed of [
      '声音形式',
      '文案安排',
      '配乐或音效偏好',
      '交付内容与数量',
      '必须包含的元素',
      '已有的创意或故事',
    ])
      expect(html).not.toContain(removed);
  });
  it('preserves duration ranges, free-form style and unspecified audiences in the rendered view', async () => {
    const view = emptyCustomizedExtractionView();
    view.status = 'COMPLETED';
    view.fields.duration = '28～32 秒';
    view.fields.visualStyle = '写实、清新，保留自然纹理';
    const html = await renderToString(
      createSSRApp(CustomizedInfoExtractionNodePage, { ...props, view, available: true }),
    );
    expect(html).toContain('28～32 秒');
    expect(html).toContain('写实、清新，保留自然纹理');
    expect(html).not.toContain('value="25-30"');
  });
  it('renders a loading or error state without a duplicate result form', async () => {
    const loading = await renderToString(
      createSSRApp(CustomizedInfoExtractionNodePage, { ...props, loading: true }),
    );
    expect(loading).toContain('正在恢复信息提炼');
    expect(loading).not.toContain('项目与视频用途');
    const error = await renderToString(
      createSSRApp(CustomizedInfoExtractionNodePage, { ...props, loadError: '读取暂时失败' }),
    );
    expect(error).toContain('读取暂时失败');
    expect(error).not.toContain('项目与视频用途');
  });
});
