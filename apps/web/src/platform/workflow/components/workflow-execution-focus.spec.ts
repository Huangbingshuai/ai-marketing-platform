import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRenderer, h, nextTick, reactive, ssrContextKey, markRaw } from 'vue';
import Dialog from './WorkflowExecutionGraphDialog.vue';

type Host = { children: Host[]; parent: Host | null };
const node = (): Host => ({ children: [], parent: null });
const renderer = createRenderer<Host, Host>({
  createElement: node,
  createText: node,
  createComment: node,
  setText() {},
  setElementText() {},
  patchProp() {},
  insert(c, p) {
    c.parent = p;
    p.children.push(c);
  },
  remove(c) {
    if (c.parent) c.parent.children.splice(c.parent.children.indexOf(c), 1);
  },
  parentNode: (c) => c.parent,
  nextSibling: () => null,
});
const cleanups: (() => void)[] = [];
const settle = async () => {
  for (let i = 0; i < 8; i++) {
    await Promise.resolve();
    await nextTick();
  }
};
type TestDocument = {
  activeElement: TestElement;
  body: TestElement;
  documentElement: TestElement;
  native: TestElement[];
  dialogs: TestElement[];
};
let doc: TestDocument;
class TestElement {
  constructor() {
    markRaw(this);
  }
  parent: TestElement | null = null;
  visible = true;
  isConnected = true;
  disabled = false;
  hidden = false;
  tabIndex = 0;
  controls: TestElement[] = [];
  owner: TestElement | null = null;
  classList = { contains: () => false };
  focus = vi.fn(() => {
    doc.activeElement = this;
  });
  getClientRects() {
    return this.visible ? [{}] : [];
  }
  matches(selector: string) {
    return selector === ':disabled' && this.disabled;
  }
  closest(selector: string) {
    return selector.includes('[hidden]') ? (this.hidden ? this : null) : this.owner;
  }
  contains(value: TestElement | null) {
    while (value) {
      if (value === this) return true;
      value = value.parent;
    }
    return false;
  }
  querySelectorAll() {
    return this.controls;
  }
}
class TestObserver {
  static all: TestObserver[] = [];
  observe = vi.fn();
  disconnect = vi.fn();
  constructor(readonly callback: () => void) {
    TestObserver.all.push(this);
  }
}
function key(
  key: string,
  target: TestElement,
  options: { prevented?: boolean; composing?: boolean; shift?: boolean } = {},
) {
  return {
    key,
    target,
    defaultPrevented: options.prevented ?? false,
    isComposing: options.composing ?? false,
    shiftKey: options.shift ?? false,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  } as unknown as KeyboardEvent;
}
async function mount() {
  const body = new TestElement(),
    html = new TestElement(),
    trigger = new TestElement(),
    root = new TestElement(),
    close = new TestElement();
  close.parent = root;
  close.owner = root;
  root.controls = [close];
  doc = { activeElement: trigger, body, documentElement: html, native: [], dialogs: [root] };
  vi.stubGlobal('Element', TestElement);
  vi.stubGlobal('HTMLElement', TestElement);
  vi.stubGlobal('MutationObserver', TestObserver);
  vi.stubGlobal('document', {
    get activeElement() {
      return doc.activeElement;
    },
    body,
    documentElement: html,
    querySelectorAll: (selector: string) =>
      selector.startsWith('dialog[open],')
        ? [...doc.native, ...doc.dialogs]
        : selector === 'dialog[open]'
          ? doc.native
          : doc.dialogs,
  });
  const props = reactive({
    open: true,
    title: '工作流',
    eyebrow: '执行详情',
    description: '只读',
    rows: [],
    nodes: [],
    selected: null,
  });
  const closed = vi.fn();
  let state: Record<string, unknown> = {};
  const component = {
    ...Dialog,
    render(this: { $: { setupState: Record<string, unknown> } }) {
      state = this.$.setupState;
      return h('div');
    },
  } as unknown as typeof Dialog;
  const app = renderer.createApp({ render: () => h(component, { ...props, onClose: closed }) });
  app.provide(ssrContextKey, { modules: new Set() });
  app.mount(node());
  cleanups.push(() => app.unmount());
  state.panel = root;
  state.closeButton = close;
  await settle();
  const call = (method: string, ...args: unknown[]) =>
    (state[method] as (...args: unknown[]) => void)(...args);
  return { props, state, root, close, trigger, closed, call };
}
afterEach(async () => {
  cleanups.splice(0).forEach((fn) => fn());
  await settle();
  TestObserver.all = [];
  vi.unstubAllGlobals();
});
describe('shared execution dialog focus lifecycle', () => {
  it('recovers focus lost by a query button replacement, then Escape closes only this layer', async () => {
    const { root, close, closed, call } = await mount();
    expect(doc.activeElement).toBe(close);
    doc.activeElement = doc.body;
    TestObserver.all.at(-1)!.callback();
    await settle();
    expect(doc.activeElement).toBe(close);
    const event = key('Escape', close);
    call('keydown', event);
    expect(closed).toHaveBeenCalledOnce();
    expect(event.stopPropagation).toHaveBeenCalledOnce();
    expect(root).toBe(close.parent);
  });
  it('preserves valid editing focus and yields Escape to an inner control or IME', async () => {
    const { root, close, closed, call } = await mount(),
      input = new TestElement();
    input.parent = root;
    input.owner = root;
    doc.activeElement = input;
    call('recoverFocus');
    expect(doc.activeElement).toBe(input);
    call('keydown', key('Escape', input, { prevented: true }));
    call('keydown', key('Escape', input, { composing: true }));
    expect(closed).not.toHaveBeenCalled();
    expect(close.focus).toHaveBeenCalledTimes(1);
    call('keydown', key('Escape', input));
    expect(closed).toHaveBeenCalledOnce();
  });
  it('does not steal focus or Escape from native or teleported inner dialogs', async () => {
    const { root, closed, call } = await mount(),
      inner = new TestElement();
    doc.native = [inner];
    doc.activeElement = doc.body;
    call('recoverFocus');
    call('keydown', key('Escape', root));
    expect(doc.activeElement).toBe(doc.body);
    expect(closed).not.toHaveBeenCalled();
    doc.native = [];
    doc.dialogs = [root, inner];
    call('recoverFocus');
    call('keydown', key('Escape', root));
    expect(doc.activeElement).toBe(doc.body);
    expect(closed).not.toHaveBeenCalled();
    doc.dialogs = [root];
    const nestedTarget = new TestElement();
    nestedTarget.owner = inner;
    call('keydown', key('Escape', nestedTarget));
    expect(closed).not.toHaveBeenCalled();
  });
  it('traps forward/backward Tab with editable controls and provides a no-controls fallback', async () => {
    const { root, close, call } = await mount(),
      input = new TestElement(),
      editable = new TestElement();
    input.parent = root;
    editable.parent = root;
    root.controls = [close, input, editable];
    doc.activeElement = editable;
    call('keydown', key('Tab', editable));
    expect(doc.activeElement).toBe(close);
    call('keydown', key('Tab', close, { shift: true }));
    expect(doc.activeElement).toBe(editable);
    doc.activeElement = root;
    call('keydown', key('Tab', root));
    expect(doc.activeElement).toBe(close);
    root.controls = [];
    call('keydown', key('Tab', root));
    expect(doc.activeElement).toBe(root);
  });
  it('disconnects on close, restores the trigger and ignores late recovery callbacks', async () => {
    const { props, close, trigger } = await mount(),
      observer = TestObserver.all.at(-1)!;
    props.open = false;
    await settle();
    expect(doc.activeElement).toBe(trigger);
    expect(observer.disconnect).toHaveBeenCalled();
    const outside = new TestElement();
    doc.activeElement = outside;
    observer.callback();
    await settle();
    expect(doc.activeElement).toBe(outside);
    expect(close.focus).toHaveBeenCalledTimes(1);
  });
  it('recovers disabled/hidden targets, and does not restore a trigger behind a new modal', async () => {
    const { root, close, props, trigger, call } = await mount(),
      input = new TestElement();
    input.parent = root;
    input.owner = root;
    input.disabled = true;
    doc.activeElement = input;
    call('recoverFocus');
    expect(doc.activeElement).toBe(close);
    input.disabled = false;
    input.hidden = true;
    doc.activeElement = input;
    call('recoverFocus');
    expect(doc.activeElement).toBe(close);
    const nested = new TestElement();
    doc.dialogs = [root, nested];
    doc.activeElement = nested;
    props.open = false;
    await settle();
    expect(doc.activeElement).toBe(nested);
    expect(trigger.focus).not.toHaveBeenCalled();
  });
});
