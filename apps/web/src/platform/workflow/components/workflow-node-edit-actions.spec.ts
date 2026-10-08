import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { describe, expect, it } from 'vitest';
import Actions from './WorkflowNodeEditActions.vue';

describe('shared effect/customized node editing actions', () => {
  it('shows only enter-edit for a confirmed read-only node', async () => {
    const html = await renderToString(createSSRApp(Actions, { editing: false, temporary: false }));
    expect(html).toContain('进入编辑');
    expect(html).not.toContain('保存版本');
    expect(html).not.toContain('取消编辑');
  });
  it('shows save/cancel for an isolated edit, and locks both during version saving', async () => {
    const html = await renderToString(
      createSSRApp(Actions, { editing: true, temporary: true, saving: true }),
    );
    expect(html).toContain('取消编辑');
    expect(html).toContain('正在校验…');
    expect(html.match(/disabled/g)).toHaveLength(2);
  });
  it('allows the first version to be saved without inventing a cancellable parent version', async () => {
    const html = await renderToString(createSSRApp(Actions, { editing: true, temporary: false }));
    expect(html).toContain('保存版本');
    expect(html).not.toContain('取消编辑');
  });
});
