import { readFileSync } from 'node:fs';
import { createSSRApp, createRenderer, nextTick, ssrContextKey, h, reactive } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ProductionVideoDocument, ProductionWorkspace } from '@ai-marketing/contracts';
import Workbench from './ProductionVideoWorkbench.vue';
import { productionApi } from './production.api';
vi.mock('./production.api', () => ({ productionApi: { prompt: vi.fn() } }));
const fixture = () =>
  JSON.parse(
    readFileSync(
      new URL(
        '../../../../../../packages/contracts/fixtures/customized-video-plan-v2.json',
        import.meta.url,
      ),
      'utf8',
    ),
  ).document as ProductionVideoDocument;
const workspace = (d: ProductionVideoDocument) =>
  ({
    document: d,
    confirmedDocument: d,
    shotsConfirmed: true,
    assetsConfirmed: true,
    prompts: [],
    tasks: [],
    draftRevision: 1,
  }) as unknown as ProductionWorkspace;
describe('clip workbench', () => {
  it('keeps current prompt progress inside the prompt editor and ignores other clip tasks', async () => {
    const d = fixture(),
      w = workspace(d);
    w.tasks = [
      {
        id: 'other',
        operation: 'PROMPT',
        target: { kind: 'CLIP', id: 'clip-b' },
        status: 'RUNNING',
        progress: 71,
        steps: [{ status: 'RUNNING', content: '另一镜的审校' }],
      },
      {
        id: 'current',
        operation: 'PROMPT',
        target: { kind: 'CLIP', id: 'clip-a' },
        status: 'RUNNING',
        progress: 42,
        steps: [{ status: 'RUNNING', content: '当前镜的提示词审校' }],
      },
    ] as ProductionWorkspace['tasks'];
    const html = await renderToString(
      createSSRApp(Workbench, {
        projectId: 'p',
        workflowRunId: 'r',
        document: d,
        workspace: w,
        editing: true,
        locked: true,
        dirty: false,
        savePlan: async () => true,
      }),
    );
    const promptArea = html.split('class="prompt-section"')[1]!.split('</main>')[0]!;
    expect(promptArea).toContain('当前镜的提示词审校');
    expect(promptArea).toContain('aria-valuenow="42"');
    expect(html).not.toContain('另一镜的审校');
    expect(html.split('aria-label="逐镜渲染"')[1]).not.toContain('aria-valuenow="42"');
  });
  it('shows reference images only for actual prompt mentions, never all shot candidates', async () => {
    const d = fixture(),
      w = workspace(d);
    d.assets.forEach((a) => {
      a.image = { assetId: `image-${a.id}`, version: 1 };
    });
    w.prompts = [
      {
        revision: 1,
        stale: false,
        value: {
          target: { kind: 'CLIP', id: 'clip-a' },
          content: '@陶瓷杯的杯身近景',
          assetIds: ['cup', 'room'],
        },
      },
    ];
    const html = await renderToString(
      createSSRApp(Workbench, {
        projectId: 'p',
        workflowRunId: 'r',
        document: d,
        workspace: w,
        editing: false,
        locked: false,
        dirty: false,
        savePlan: async () => true,
      }),
    );
    const aside = html.split('aria-label="逐镜渲染"')[1]!;
    expect(aside).toContain('预览绑定图片陶瓷杯');
    expect(aside).not.toContain('预览绑定图片阅读室');
    expect(aside).toMatch(/class="count"[^>]*>1<\/span>/);
  });
  it.each([false, true])(
    'renders one description per task, including historical multi-shot data (editing=%s)',
    async (editing) => {
      const d = fixture();
      const html = await renderToString(
        createSSRApp(Workbench, {
          projectId: 'p',
          workflowRunId: 'r',
          document: d,
          workspace: workspace(d),
          editing,
          locked: false,
          dirty: false,
          savePlan: async () => true,
        }),
      );
      expect(html).toContain('2 个任务');
      expect(html).toContain('选择分镜02');
      const main = html.split('<main')[1]!.split('</main>')[0]!;
      expect((main.match(/<textarea/g) ?? []).length).toBe(2);
      expect(main).toContain('aria-label="分镜视频提示词"');
      expect(html).not.toContain('镜头 1');
      expect(html).not.toContain('镜头 2');
      expect(html).not.toContain('片段编排');
      expect(html).not.toContain('添加镜头');
      expect(html).not.toContain('片段内镜头');
      expect(main).not.toContain('开始状态');
      expect(main).not.toContain('结束状态');
      expect(html).toContain('开始状态');
      expect(html).toContain('结束状态');
      expect(html).toContain('分镜视频提示词');
      expect(html).toContain('查看当前分镜提示词工作流');
      expect(html).not.toContain('原稿声音与画面文字');
      expect(html).not.toContain('保存分镜提示词');
      expect(main).not.toMatch(/<textarea\b[^>]*\sreadonly/);
      expect(html).toContain('参考素材');
      expect(html).toContain('生成当前分镜视频');
      expect(html).toContain('提示词尚未引用参考图');
      expect(html).not.toContain('已完成视频');
    },
  );
  it('preserves local prompt and current selection when saving fails', async () => {
    vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
    type Host = {
      tag: string;
      children: Host[];
      parent: Host | null;
      text: string;
      props: Record<string, unknown>;
      addEventListener: () => void;
      removeEventListener: () => void;
      tagName: string;
      value: string;
      type: string;
    };
    const node = (tag = ''): Host => ({
      tag,
      children: [],
      parent: null,
      text: '',
      props: {},
      addEventListener: () => {},
      removeEventListener: () => {},
      tagName: tag.toUpperCase(),
      value: '',
      type: '',
    });
    const renderer = createRenderer<Host, Host>({
      createElement: node,
      createText: (text) => ({ ...node(), text }),
      createComment: () => node(),
      setText: (n, t) => {
        n.text = t;
      },
      setElementText: (n, t) => {
        n.text = t;
      },
      patchProp: (n, k, _o, v) => {
        n.props[k] = v;
      },
      insert: (n, p) => {
        n.parent = p;
        p.children.push(n);
      },
      remove: (n) => {
        if (n.parent) n.parent.children.splice(n.parent.children.indexOf(n), 1);
      },
      parentNode: (n) => n.parent,
      nextSibling: () => null,
    });
    const d = fixture(),
      w = reactive(workspace(d)),
      error = vi.fn(),
      app = renderer.createApp(
        {
          ...Workbench,
          // Vitest loads the SFC's SSR render. Exercise the real setup/save handlers
          // with a minimal host renderer here; browser coverage verifies the full DOM.
          render() {
            const state = (this as unknown as { $: { setupState: { promptText: string } } }).$
              .setupState;
            return h('textarea', {
              value: state.promptText,
              'aria-label': '片段视频提示词',
              'onUpdate:modelValue': (v: string) => {
                state.promptText = v;
              },
            });
          },
        },
        {
          projectId: 'p',
          workflowRunId: 'r',
          document: d,
          workspace: w,
          editing: false,
          locked: false,
          dirty: false,
          savePlan: async () => true,
          onError: error,
        },
      );
    app.provide(ssrContextKey, {});
    const root = node();
    const vm = app.mount(root) as unknown as {
      flushPendingEdits: () => Promise<boolean>;
      hasDirty: boolean;
    };
    const descendants = (n: Host): Host[] => [n, ...n.children.flatMap(descendants)];
    const textarea = descendants(root).find((n) => n.props['aria-label'] === '片段视频提示词')!;
    (textarea.props['onUpdate:modelValue'] as (v: string) => void)('我手动编辑的片段提示词');
    await nextTick();
    vi.mocked(productionApi.prompt).mockRejectedValueOnce(new Error('保存冲突，本地保留'));
    expect(await vm.flushPendingEdits()).toBe(false);
    expect(vm.hasDirty).toBe(true);
    expect(error).toHaveBeenCalledWith('保存冲突，本地保留');
    w.prompts = [
      {
        revision: 1,
        stale: false,
        value: {
          target: { kind: 'CLIP', id: 'clip-a' },
          content: '迟到的旧请求内容',
          assetIds: [],
        },
      },
    ];
    await nextTick();
    expect(textarea.props.value).toBe('我手动编辑的片段提示词');
    expect((productionApi.prompt as ReturnType<typeof vi.fn>).mock.calls[0]?.[3]).toMatchObject({
      target: { kind: 'CLIP', id: 'clip-a' },
      content: '我手动编辑的片段提示词',
    });
    app.unmount();
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
