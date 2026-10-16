import { compile, createRenderer, defineComponent } from 'vue';
import { describe, expect, it, vi } from 'vitest';
import { WorkflowNodeFooter } from '@ai-marketing/ui';
import footerSource from '../../../../../../packages/ui/src/WorkflowNodeFooter.vue?raw';
import extractionPage from '../information-extraction/EffectInfoExtractionNodePage.vue?raw';
import renderPage from '../segment-render/EffectSegmentRenderNodePage.vue?raw';

type TestNode = { type: string; props: Record<string, unknown>; children: TestNode[] };
const node = (type: string): TestNode => ({ type, props: {}, children: [] });
const RenderedFooter = Object.assign({}, WorkflowNodeFooter, {
  render: compile(footerSource.split('<template>')[1]!.split('</template>')[0]!),
});
const renderer = createRenderer<TestNode, TestNode>({
  patchProp: (element, key, _previous, value) => {
    element.props[key] = value;
  },
  insert: (element, parent) => {
    parent.children.push(element);
  },
  remove: () => {},
  createElement: node,
  createText: () => node('text'),
  createComment: () => node('comment'),
  setText: () => {},
  setElementText: () => {},
  parentNode: () => null,
  nextSibling: () => null,
  insertStaticContent: (_content, parent) => {
    const element = node('static');
    parent.children.push(element);
    return [element, element];
  },
});

function footer(source: string, state: Record<string, unknown>) {
  const emit = vi.fn();
  const template = source.match(/<WorkflowNodeFooter\b[\s\S]*?\/>/u)?.[0];
  if (!template) throw new Error('Node footer missing');
  const app = renderer.createApp(
    defineComponent({
      components: { WorkflowNodeFooter: RenderedFooter },
      setup: () => ({
        emit,
        loading: false,
        validating: false,
        editBusy: false,
        editTransitioning: false,
        operation: null,
        readyForNext: false,
        validated: false,
        ...state,
      }),
      render: compile(template),
    }),
  );
  app.provide(Symbol.for('v-scx'), {});
  const root = node('root');
  app.mount(root);
  const findNext = (entry: TestNode): TestNode | undefined =>
    entry.props.class === 'workflow-node-footer__next'
      ? entry
      : entry.children.map(findNext).find(Boolean);
  const next = findNext(root);
  if (!next) throw new Error('Next button missing');
  return { next, emit, unmount: () => app.unmount() };
}

describe.each([
  ['extraction', extractionPage],
  ['render', renderPage],
])('%s footer navigation', (_name, source) => {
  it.each(['NOT_GENERATED', 'DRAFT_CHANGED', 'STALE', 'RUNNING', 'COMMITTED'])(
    'can navigate with %s results without confirming or generating',
    (status) => {
      const f = footer(source, {
        readyForNext: status === 'COMMITTED',
        validated: status === 'COMMITTED',
      });
      expect(Boolean(f.next.props.disabled)).toBe(false);
      (f.next.props.onClick as () => void)();
      expect(f.emit).toHaveBeenCalledExactlyOnceWith('next');
      f.unmount();
    },
  );
});

it('temporarily blocks extraction navigation while saving a confirmed version', () => {
  const f = footer(extractionPage, { readyForNext: true, validating: true });
  expect(f.next.props.disabled).toBe(true);
  f.unmount();
});
it('temporarily blocks render navigation while an explicit operation is being submitted', () => {
  const f = footer(renderPage, { validated: true, operation: 'VALIDATING' });
  expect(f.next.props.disabled).toBe(true);
  f.unmount();
});
