import { afterEach, expect, it, vi } from 'vitest';
import { createRenderer, h, nextTick, ssrContextKey } from 'vue';
import type {
  ProductionDocument,
  ProductionShot,
  ProductionTask,
  ProductionWorkspace,
} from '@ai-marketing/contracts';
import Workspace from './CustomizedProductionWorkspace.vue';
import { productionApi } from './production.api';
vi.mock('./production.api', () => ({
  productionApi: {
    workspace: vi.fn(),
    task: vi.fn(),
    promptTask: vi.fn(),
    save: vi.fn(),
    start: vi.fn(),
  },
}));

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
const settle = async () => {
  for (let i = 0; i < 15; i++) {
    await Promise.resolve();
    await nextTick();
  }
};
it.each(['SHOTS', 'ASSETS'] as const)(
  '%s respects the node auto-save boundary without requiring an edit button',
  async (mode) => {
    vi.useFakeTimers();
    vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
    const content: ProductionDocument = {
      assets: [],
      shots: [
        {
          id: 's',
          title: '产品',
          visual: '原画面',
          shotType: '近景',
          cameraMovement: '固定',
          durationSeconds: 5,
          dialogue: '',
          audio: '',
          atmosphere: '',
          bindings: [],
        },
      ],
    };
    const initial = {
      script: { name: '测试' },
      document: content,
      confirmedDocument: content,
      prompts: [],
      tasks: [],
      draftRevision: 1,
    } as unknown as ProductionWorkspace;
    vi.mocked(productionApi.workspace).mockResolvedValue(initial);
    vi.mocked(productionApi.save).mockResolvedValue({ revision: 2 });
    let state: Record<string, unknown> = {};
    const app = renderer.createApp(
      {
        ...Workspace,
        render(this: { $: { setupState: Record<string, unknown> } }) {
          state = this.$.setupState;
          return h('div');
        },
      },
      { projectId: 'p', workflowRunId: 'r', mode },
    );
    app.provide(ssrContextKey, { modules: new Set() });
    app.mount(node());
    try {
      await settle();
      expect(state.editing).toBe(false);
      (state.document as { shots: ProductionShot[] }).shots[0]!.visual = '真实修改的画面';
      await settle();
      await vi.advanceTimersByTimeAsync(950);
      await settle();
      if (mode === 'SHOTS')
        expect(productionApi.save).toHaveBeenCalledWith(
          'p',
          'r',
          1,
          expect.objectContaining({
            shots: expect.arrayContaining([expect.objectContaining({ visual: '真实修改的画面' })]),
          }),
          'SHOTS',
          true,
          expect.any(AbortSignal),
        );
      else expect(productionApi.save).not.toHaveBeenCalled();
    } finally {
      app.unmount();
    }
  },
);
it('confirms a restored draft before starting a prompt, even when no new keystrokes made it dirty', async () => {
  vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  const confirmed = { assets: [], shots: [] };
  const restored: ProductionDocument = {
    assets: [],
    shots: [
      {
        id: 's',
        title: '恢复的分镜',
        bindings: [],
        shotType: '近景',
        cameraMovement: '固定',
        durationSeconds: 5,
        visual: '桌面产品近景',
        dialogue: '',
        audio: '',
        atmosphere: '',
      },
    ],
  };
  const initial = {
    script: { name: '测试' },
    document: restored,
    confirmedDocument: confirmed,
    prompts: [],
    tasks: [],
    draftRevision: 3,
    shotsConfirmed: true,
  } as unknown as ProductionWorkspace;
  vi.mocked(productionApi.workspace)
    .mockResolvedValueOnce(initial)
    .mockResolvedValueOnce({ ...initial, confirmedDocument: restored, draftRevision: 4 });
  vi.mocked(productionApi.save).mockResolvedValueOnce({ revision: 4 });
  vi.mocked(productionApi.start).mockResolvedValueOnce({
    id: 'prompt',
    operation: 'PROMPT',
    status: 'COMPLETED',
    steps: [],
    target: { kind: 'CLIP', id: 'c' },
  } as unknown as ProductionTask);
  let state: Record<string, unknown> = {};
  const app = renderer.createApp(
    {
      ...Workspace,
      render(this: { $: { setupState: Record<string, unknown> } }) {
        state = this.$.setupState;
        return h('div');
      },
    },
    { projectId: 'p', workflowRunId: 'r', mode: 'SHOTS' },
  );
  app.provide(ssrContextKey, { modules: new Set() });
  app.mount(node());
  try {
    await settle();
    expect(state.dirty).toBe(false);
    expect(state.editing).toBe(true);
    await (state.generate as (...args: unknown[]) => Promise<void>)(
      'PROMPT',
      undefined,
      undefined,
      'c',
    );
    expect(productionApi.save).toHaveBeenCalledWith(
      'p',
      'r',
      3,
      restored,
      'SHOTS',
      true,
      expect.any(AbortSignal),
    );
    expect(productionApi.start).toHaveBeenCalledWith(
      'p',
      'r',
      4,
      'PROMPT',
      undefined,
      expect.any(AbortSignal),
      undefined,
      undefined,
      { target: { kind: 'CLIP', id: 'c' } },
    );
    expect(vi.mocked(productionApi.save).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(productionApi.start).mock.invocationCallOrder[0]!,
    );
  } finally {
    app.unmount();
  }
});
it('rejects a late prompt workflow response and keeps the top entry on storyboard generation', async () => {
  vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  const shots = {
    id: 'shots',
    operation: 'SHOTS',
    status: 'COMPLETED',
    steps: [],
    progress: 100,
  } as unknown as ProductionTask;
  vi.mocked(productionApi.workspace).mockResolvedValue({
    script: { name: '测试' },
    document: { assets: [], shots: [] },
    confirmedDocument: { assets: [], shots: [] },
    prompts: [],
    tasks: [shots],
    draftRevision: 1,
  } as unknown as ProductionWorkspace);
  let resolveA!: (t: ProductionTask) => void;
  vi.mocked(productionApi.promptTask)
    .mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolveA = r;
        }),
    )
    .mockResolvedValueOnce({
      id: 'prompt-b',
      operation: 'PROMPT',
      status: 'COMPLETED',
      steps: [],
      target: { kind: 'CLIP', id: 'b' },
    } as unknown as ProductionTask);
  let state: Record<string, unknown> = {};
  const app = renderer.createApp(
    {
      ...Workspace,
      render(this: { $: { setupState: Record<string, unknown> } }) {
        state = this.$.setupState;
        return h('div');
      },
    },
    { projectId: 'p', workflowRunId: 'r', mode: 'SHOTS' },
  );
  app.provide(ssrContextKey, { modules: new Set() });
  app.mount(node());
  try {
    await settle();
    const open = state.openPromptWorkflow as (id: string) => Promise<void>;
    const pending = open('a');
    await settle();
    await open('b');
    resolveA({
      id: 'late-a',
      operation: 'PROMPT',
      steps: [],
      target: { kind: 'CLIP', id: 'a' },
    } as unknown as ProductionTask);
    await pending;
    await settle();
    expect((state.graphTask as ProductionTask).id).toBe('prompt-b');
    (state.openWorkflow as () => void)();
    await settle();
    expect((state.graphTask as ProductionTask).id).toBe('shots');
  } finally {
    app.unmount();
  }
});

it.each(['ASSETS', 'SHOTS'] as const)(
  '%s opens an untouched empty workspace without editing and restores only actual drafts',
  async (mode) => {
    vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
    const content: ProductionDocument = {
      assets: [
        {
          id: 'product',
          kind: 'PRODUCT',
          name: '充电器',
          description: '',
          knownFacts: '',
          designNotes: '',
          sourceText: '',
        },
      ],
      shots: [
        {
          id: 'shot',
          title: '产品亮相',
          shotType: '近景',
          cameraMovement: '固定',
          durationSeconds: 5,
          visual: '充电器置于桌面',
          dialogue: '',
          audio: '',
          atmosphere: '',
          bindings: [],
        },
      ],
    };
    for (const scenario of [
      {
        document: { assets: [], shots: [] },
        confirmed: { assets: [], shots: [] },
        confirmedFlag: false,
        editing: false,
      },
      {
        document: content,
        confirmed: { assets: [], shots: [] },
        confirmedFlag: false,
        editing: true,
      },
      { document: content, confirmed: content, confirmedFlag: true, editing: false },
      {
        document: { assets: [], shots: [] },
        confirmed: content,
        confirmedFlag: true,
        editing: true,
      },
    ]) {
      vi.mocked(productionApi.workspace).mockResolvedValue({
        script: {
          id: 'script',
          name: '充电器脚本',
          synopsis: '',
          structure: '',
          productFocus: '',
          shots: [],
        },
        source: { artifactId: 'script-artifact', revision: 1, fingerprint: 'confirmed' },
        sourceReady: true,
        document: scenario.document,
        confirmedDocument: scenario.confirmed,
        draftRevision: 1,
        assetsConfirmed: scenario.confirmedFlag,
        shotsConfirmed: scenario.confirmedFlag,
        prompts: [],
        tasks: [],
      } as ProductionWorkspace);
      let state: Record<string, unknown> = {};
      const app = renderer.createApp(
        {
          ...Workspace,
          render(this: { $: { setupState: Record<string, unknown> } }) {
            state = this.$.setupState;
            return h('div');
          },
        },
        { projectId: 'project', workflowRunId: 'run', mode },
      );
      app.provide(ssrContextKey, { modules: new Set() });
      app.mount(node());
      try {
        await settle();
        expect(state.editing).toBe(scenario.editing);
      } finally {
        app.unmount();
      }
    }
  },
);
afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

it.each(['ASSETS', 'SHOTS'] as const)(
  '%s prepares missing images through the asset node without starting a paid task',
  async (mode) => {
    vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
    const asset = {
      id: 'missing-product',
      kind: 'PRODUCT' as const,
      name: '充电器',
      description: '',
      knownFacts: '',
      designNotes: '',
      sourceText: '',
    };
    const document: ProductionDocument = { assets: [asset], shots: [] };
    vi.mocked(productionApi.workspace).mockResolvedValue({
      script: {
        id: 'script',
        name: '充电器方案',
        synopsis: '',
        structure: '',
        productFocus: '',
        shots: [],
      },
      source: { artifactId: 'source', revision: 1, fingerprint: 'confirmed' },
      sourceReady: true,
      document,
      confirmedDocument: document,
      draftRevision: 1,
      assetsConfirmed: true,
      shotsConfirmed: true,
      prompts: [],
      tasks: [],
    } as ProductionWorkspace);
    const back = vi.fn();
    let state: Record<string, unknown> = {};
    const app = renderer.createApp(
      {
        ...Workspace,
        render(this: { $: { setupState: Record<string, unknown> } }) {
          state = this.$.setupState;
          return h('div');
        },
      },
      { projectId: 'project', workflowRunId: 'run', mode, onBack: back },
    );
    app.provide(ssrContextKey, { modules: new Set() });
    app.mount(node());
    try {
      await settle();
      (state.prepareImage as (value: typeof asset) => void)(asset);
      expect(back).toHaveBeenCalledTimes(mode === 'SHOTS' ? 1 : 0);
      expect(state.imageDialogOpen).toBe(mode === 'ASSETS');
      expect(state.document).toEqual(document);
      expect(productionApi.start).not.toHaveBeenCalled();
      expect(productionApi.save).not.toHaveBeenCalled();
    } finally {
      app.unmount();
    }
  },
);

it.each([false, true])(
  'loads the completed generation from an edit session unless actual edits remain (dirty=%s)',
  async (hasEdits) => {
    vi.useFakeTimers();
    vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
    const task = {
      id: 'generation',
      operation: 'SHOTS',
      status: 'RUNNING',
      progress: 60,
      steps: [],
      shotId: null,
      errorMessage: null,
    } as ProductionTask;
    const initial = {
      script: {
        id: 'script',
        name: '充电器',
        synopsis: '',
        structure: '',
        productFocus: '',
        shots: [],
      },
      source: { artifactId: 's', revision: 1, fingerprint: 's' },
      sourceReady: true,
      document: {
        assets: [],
        shots: [
          {
            id: 'old',
            title: '旧分镜',
            visual: '旧画面',
            durationSeconds: 5,
            shotType: '近景',
            cameraMovement: '固定',
            dialogue: '',
            audio: '',
            atmosphere: '',
            bindings: [],
          },
        ],
      },
      confirmedDocument: { assets: [], shots: [] },
      draftRevision: 1,
      assetsConfirmed: true,
      shotsConfirmed: false,
      prompts: [],
      tasks: [task],
    } as ProductionWorkspace;
    const completed = { ...task, status: 'COMPLETED', progress: 100 } as ProductionTask;
    const oldShot = (initial.document as { shots: ProductionShot[] }).shots[0]!;
    const latest = {
      ...initial,
      document: { assets: [], shots: [{ ...oldShot, id: 'new', visual: '新完整分镜' }] },
      draftRevision: 2,
      tasks: [completed],
    };
    vi.mocked(productionApi.workspace)
      .mockResolvedValueOnce(initial)
      .mockImplementationOnce(async () => {
        // Keep the workbench mounted and preserve its selected video task.
        expect(state.loading).toBe(false);
        return latest;
      })
      .mockResolvedValueOnce({
        ...latest,
        confirmedDocument: latest.document,
        shotsConfirmed: true,
      });
    vi.mocked(productionApi.save).mockResolvedValueOnce({ revision: 2 });
    vi.mocked(productionApi.task).mockResolvedValue(completed);
    let state: Record<string, unknown> = {};
    const app = renderer.createApp(
      {
        ...Workspace,
        render(this: { $: { setupState: Record<string, unknown> } }) {
          state = this.$.setupState;
          return h('div');
        },
      },
      { projectId: 'p', workflowRunId: 'r', mode: 'SHOTS' },
    );
    app.provide(ssrContextKey, { modules: new Set() });
    app.mount(node());
    try {
      await settle();
      expect(state.editing).toBe(true);
      if (hasEdits)
        state.document = {
          ...initial.document,
          shots: [{ ...oldShot, visual: '尚未保存的人工修改' }],
        };
      await vi.advanceTimersByTimeAsync(1800);
      await settle();
      expect(state.running).toBeUndefined();
      expect(productionApi.workspace).toHaveBeenCalledTimes(hasEdits ? 1 : 3);
      if (!hasEdits)
        expect(productionApi.save).toHaveBeenCalledWith(
          'p',
          'r',
          2,
          latest.document,
          'SHOTS',
          true,
          expect.any(AbortSignal),
        );
      const d = state.document as { shots: { visual: string }[] };
      expect(d.shots[0]!.visual).toBe(hasEdits ? '尚未保存的人工修改' : '新完整分镜');
    } finally {
      app.unmount();
    }
  },
);

it.each([
  ['ASSETS', 'SHOTS'],
  ['ASSETS', 'PROMPT'],
  ['SHOTS', 'ASSETS'],
  ['SHOTS', 'IMAGE'],
] as const)('%s does not display or lock on a running %s task', async (mode, operation) => {
  vi.useFakeTimers();
  vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  const task: ProductionTask = {
    id: 'other-node',
    operation,
    status: 'RUNNING',
    progress: 25,
    steps: [],
    shotId: null,
    errorMessage: null,
  };
  vi.mocked(productionApi.workspace).mockResolvedValue({
    script: {
      id: 'script',
      name: '充电器脚本',
      synopsis: '',
      structure: '',
      productFocus: '',
      shots: [],
    },
    source: { artifactId: 'script-artifact', revision: 1, fingerprint: 'confirmed' },
    sourceReady: true,
    document: { assets: [], shots: [] },
    confirmedDocument: { assets: [], shots: [] },
    draftRevision: 1,
    assetsConfirmed: true,
    shotsConfirmed: true,
    prompts: [],
    tasks: [task],
  } as ProductionWorkspace);
  vi.mocked(productionApi.task).mockResolvedValue(task);
  let state: Record<string, unknown> = {};
  const app = renderer.createApp(
    {
      ...Workspace,
      render(this: { $: { setupState: Record<string, unknown> } }) {
        state = this.$.setupState;
        return h('div');
      },
    },
    { projectId: 'project', workflowRunId: 'run', mode },
  );
  app.provide(ssrContextKey, { modules: new Set() });
  app.mount(node());
  try {
    await settle();
    expect(state.running).toBeUndefined();
    expect(state.busy).toBe(false);
    expect(state.tasks).toEqual([]);
    expect(state.graphTask).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1800);
    await settle();
    if (operation === 'IMAGE') {
      // A video library image request refreshes silently, without video progress.
      expect(productionApi.task).toHaveBeenCalledWith(
        'project',
        'other-node',
        expect.any(AbortSignal),
      );
    } else expect(productionApi.task).not.toHaveBeenCalled();
    expect(state.running).toBeUndefined();
  } finally {
    app.unmount();
  }
});

it('recovers a failed progress read without failing the task or retaining a stale warning', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  const task: ProductionTask = {
    id: 'task',
    operation: 'ASSETS',
    status: 'RUNNING',
    progress: 73,
    steps: [],
    shotId: null,
    errorMessage: null,
  };
  const initial = {
    script: {
      id: 'script',
      name: '充电器脚本',
      synopsis: '',
      structure: '',
      productFocus: '',
      shots: [],
    },
    source: { artifactId: 'script-artifact', revision: 1, fingerprint: 'confirmed' },
    sourceReady: true,
    document: { assets: [], shots: [] },
    confirmedDocument: { assets: [], shots: [] },
    draftRevision: 1,
    assetsConfirmed: false,
    shotsConfirmed: false,
    prompts: [],
    tasks: [task],
  } as ProductionWorkspace;
  const completed = { ...task, status: 'COMPLETED', progress: 100 } as const;
  vi.mocked(productionApi.workspace)
    .mockResolvedValueOnce(initial)
    .mockResolvedValueOnce({ ...initial, tasks: [completed] });
  vi.mocked(productionApi.task)
    .mockRejectedValueOnce(new TypeError('network disconnected'))
    .mockResolvedValueOnce({ ...task, progress: 82 })
    .mockResolvedValueOnce(completed);
  let state: Record<string, unknown> = {};
  const component = {
    ...Workspace,
    render(this: { $: { setupState: Record<string, unknown> } }) {
      state = this.$.setupState;
      return h('div');
    },
  };
  const app = renderer.createApp(component, {
    projectId: 'project',
    workflowRunId: 'run',
    mode: 'ASSETS',
  });
  app.provide(ssrContextKey, { modules: new Set() });
  app.mount(node());
  try {
    await settle();
    await vi.advanceTimersByTimeAsync(1800);
    await settle();
    expect(state.error).toBe('');
    expect(state.pollingInterrupted).toBe(true);
    expect(state.running).toMatchObject({ id: 'task', status: 'RUNNING', progress: 73 });
    await vi.advanceTimersByTimeAsync(5000);
    await settle();
    expect(state.pollingInterrupted).toBe(false);
    expect(state.error).toBe('');
    expect(state.running).toMatchObject({ id: 'task', status: 'RUNNING', progress: 82 });
    await vi.advanceTimersByTimeAsync(1800);
    await settle();
    expect(state.running).toBeUndefined();
    expect(state.pollingInterrupted).toBe(false);
    expect(productionApi.task).toHaveBeenCalledTimes(3);
    expect(productionApi.workspace).toHaveBeenCalledTimes(2);
  } finally {
    app.unmount();
  }
  await vi.advanceTimersByTimeAsync(30000);
  expect(productionApi.task).toHaveBeenCalledTimes(3);
});
