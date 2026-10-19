import { describe, expect, it } from 'vitest';
import { createRenderer, createSSRApp, h, nextTick, ref, ssrContextKey } from 'vue';
import { renderToString } from 'vue/server-renderer';
import type { CustomizedBriefIssue } from '@ai-marketing/contracts';
import Page from './CustomizedInfoExtractionNodePage.vue';
import {
  emptyCustomizedExtractionView,
  type CustomizedExtractionView,
} from './customized-extraction-view';

const base = '容量待确认；配件待确认；未进行保温测试。';
const issue = (id: string, before: string, replacements: string[]): CustomizedBriefIssue => ({
  id,
  field: 'productSpecifications',
  message: id,
  sourceIds: ['source'],
  blocking: true,
  alternatives: replacements.map((value) => base.replace(before, value)),
  resolution: { schemaVersion: 1, baseValue: base, before, replacements },
});
const capacity = () => issue('容量差异', '容量待确认', ['容量430mL', '容量480mL']);
const accessory = () => issue('配件差异', '配件待确认', ['无附赠配件', '附赠硅胶圈']);
const initial = (): CustomizedExtractionView => ({
  ...emptyCustomizedExtractionView(),
  status: 'COMPLETED',
  editing: true,
  fields: { ...emptyCustomizedExtractionView().fields, productSpecifications: base },
  issues: [capacity(), accessory()],
});
type Host = { children: Host[]; parent: Host | null };
const node = (): Host => ({ children: [], parent: null });
const renderer = createRenderer<Host, Host>({
  createElement: node,
  createText: node,
  createComment: node,
  setText: () => {},
  setElementText: () => {},
  patchProp: () => {},
  insert(child, parent) {
    child.parent = parent;
    parent.children.push(child);
  },
  remove(child) {
    if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1);
  },
  parentNode: (child) => child.parent,
  nextSibling: () => null,
});
function mount(value = initial()) {
  const view = ref(value),
    updates: CustomizedExtractionView[] = [];
  let state: Record<string, unknown> = {};
  const component = {
    ...Page,
    render(this: { $: { setupState: Record<string, unknown> } }) {
      state = this.$.setupState;
      return h('div');
    },
  };
  const app = renderer.createApp({
    render: () =>
      h(component as unknown as typeof Page, {
        projectId: 'project',
        workflowRunId: 'run',
        sourceConfirmed: true,
        sources: [],
        available: true,
        view: view.value,
        'onUpdate:view': (next: CustomizedExtractionView) => {
          view.value = next;
          updates.push(next);
        },
      }),
  });
  app.provide(ssrContextKey, { modules: new Set() });
  app.mount(node());
  return {
    app,
    view,
    updates,
    state: () => state,
    async apply(id: string, index: number) {
      (state.useAlternative as (id: string, index: number) => void)(id, index);
      await nextTick();
    },
  };
}

describe('scoped extraction candidate interaction', () => {
  it('applies two conflicts in the same field without reverting an earlier choice or unrelated manual text', async () => {
    const m = mount();
    try {
      await m.apply('容量差异', 0);
      expect(m.view.value.issues.map((i) => i.id)).toEqual(['配件差异']);
      m.view.value.fields.productSpecifications += ' 人工补充：仅供界面测试。';
      await nextTick();
      (m.state().previewAlternative as (id: string, index: number) => void)('配件差异', 1);
      expect(m.state().candidatePreview).toMatchObject({
        applied: true,
        value: '容量430mL；附赠硅胶圈；未进行保温测试。 人工补充：仅供界面测试。',
      });
      await m.apply('配件差异', 1);
      expect(m.view.value.fields.productSpecifications).toBe(
        '容量430mL；附赠硅胶圈；未进行保温测试。 人工补充：仅供界面测试。',
      );
      expect(m.view.value.issues).toEqual([]);
      expect(m.updates).toHaveLength(2);
      await m.apply('容量差异', 1);
      expect(m.updates).toHaveLength(2);
    } finally {
      m.app.unmount();
    }
  });

  it.each(['missing', 'duplicate', 'invalid', 'stale-source', 'legacy', 'readonly'] as const)(
    'does not write or resolve issues when %s',
    async (scenario) => {
      const value = initial();
      if (scenario === 'missing')
        value.fields.productSpecifications = '容量已手动填写；配件待确认。';
      if (scenario === 'duplicate') value.fields.productSpecifications = base + '容量待确认';
      if (scenario === 'invalid')
        value.issues[0]!.resolution!.replacements[0] = '不对应原候选的内容';
      if (scenario === 'stale-source') value.status = 'STALE';
      if (scenario === 'legacy') delete value.issues[0]!.resolution;
      if (scenario === 'readonly') value.editing = false;
      const m = mount(value),
        before = structuredClone(value.fields);
      try {
        await m.apply('容量差异', 0);
        expect(m.view.value.fields).toEqual(before);
        expect(m.view.value.issues).toHaveLength(2);
        expect(m.updates).toHaveLength(0);
        if (scenario !== 'readonly')
          expect((m.state().candidateErrors as Record<string, string>)['容量差异']).toMatch(
            /保留|未修改|手动/,
          );
      } finally {
        m.app.unmount();
      }
    },
  );

  it('shows short replacements and keeps old full-field candidates available for manual review', async () => {
    const value = initial();
    value.issues.push({
      id: '旧候选',
      field: 'productAppearance',
      message: '历史外观待核对',
      alternatives: ['历史完整候选只供人工核对，不可直接覆盖当前填写。'],
      blocking: false,
      sourceIds: [],
    });
    const html = await renderToString(
      createSSRApp(Page, {
        projectId: 'project',
        workflowRunId: 'run',
        sourceConfirmed: true,
        sources: [],
        available: true,
        view: value,
      }),
    );
    expect(html).toContain('容量430mL');
    expect(html).toContain('查看本次修改片段');
    expect(html).toContain('查看完整字段');
    expect(html).toContain('历史候选未标注修改范围');
    expect(html).not.toContain(`采用：${value.issues[0]!.alternatives[0]}`);
    const m = mount(value);
    try {
      (m.state().previewAlternative as (id: string, index: number) => void)('旧候选', 0);
      expect(m.state().candidatePreview).toMatchObject({
        applied: false,
        value: value.issues[2]!.alternatives[0],
      });
      expect(m.updates).toHaveLength(0);
    } finally {
      m.app.unmount();
    }
  });
});
