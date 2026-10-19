import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRenderer, h, nextTick, ssrContextKey } from 'vue';
import {
  mergeVideoTaskShots,
  type ProductionVideoDocument,
  type ProductionWorkspace,
  type VideoPlan,
} from '@ai-marketing/contracts';
import Workbench from './ProductionVideoWorkbench.vue';
import Workspace from './CustomizedProductionWorkspace.vue';
import { productionApi } from './production.api';
vi.mock('./production.api', () => ({
  productionApi: { workspace: vi.fn(), save: vi.fn(), start: vi.fn() },
}));
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
const cleanup: (() => void)[] = [];
const settle = async () => {
  for (let i = 0; i < 15; i++) {
    await Promise.resolve();
    await nextTick();
  }
};
const call = (state: Record<string, unknown>, key: string, ...args: unknown[]) =>
  (state[key] as (...args: unknown[]) => unknown)(...args);
afterEach(() => {
  cleanup.splice(0).forEach((fn) => fn());
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

async function mountWorkspace() {
  let workbench: Record<string, unknown> = {},
    workspace: Record<string, unknown> = {};
  const child = {
    ...Workbench,
    render(this: { $: { setupState: Record<string, unknown> } }) {
      workbench = this.$.setupState;
      return h('div');
    },
  } as unknown as typeof Workbench;
  const parent = {
    ...Workspace,
    render(this: { $: { setupState: Record<string, unknown> } }) {
      workspace = this.$.setupState;
      if (workspace.loading || !workspace.workspace) return h('div');
      return h(child, {
        projectId: 'p',
        workflowRunId: 'r',
        document: workspace.document as ProductionVideoDocument,
        workspace: workspace.workspace as ProductionWorkspace,
        editing: true,
        locked: !!workspace.busy || !!workspace.running,
        dirty: !!workspace.dirty,
        savePlan: workspace.save as () => Promise<boolean>,
        'onUpdate-plan': (plan: VideoPlan) => {
          (workspace.document as ProductionVideoDocument).videoPlan = plan;
        },
      });
    },
  } as unknown as typeof Workspace;
  const app = renderer.createApp(parent, { projectId: 'p', workflowRunId: 'r', mode: 'SHOTS' });
  app.provide(ssrContextKey, { modules: new Set() });
  app.mount(node());
  cleanup.push(() => app.unmount());
  await settle();
  return { workbench, workspace };
}

describe('editable storyboard start and end states', () => {
  it.each([false, true])(
    'saves both shot/clip states in the same Run and restores them on refresh (already single=%s)',
    async (single) => {
      vi.useFakeTimers();
      vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
      let stored = fixture();
      if (single) stored.videoPlan = mergeVideoTaskShots(stored.videoPlan, 'clip-a');
      const sibling = structuredClone(stored.videoPlan.clips[1]!);
      const siblingShot = structuredClone(
        stored.videoPlan.shots.find((s) => s.id === sibling.shotIds[0])!,
      );
      const sourceUnits = structuredClone(stored.videoPlan.sourceUnits);
      const sourceEvents = structuredClone(stored.videoPlan.events);
      let revision = 1;
      vi.mocked(productionApi.workspace).mockImplementation(
        async () =>
          ({
            script: { name: '测试' },
            document: structuredClone(stored),
            confirmedDocument: structuredClone(stored),
            prompts: [],
            tasks: [],
            draftRevision: revision,
            shotsConfirmed: true,
            assetsConfirmed: true,
          }) as unknown as ProductionWorkspace,
      );
      vi.mocked(productionApi.save).mockImplementation(async (_p, _r, _rev, document) => {
        stored = structuredClone(document) as ProductionVideoDocument;
        return { revision: ++revision };
      });
      const first = await mountWorkspace();
      call(first.workbench, 'updateTask', 'startState', '右手持杯，左手拿包');
      await settle();
      call(first.workbench, 'updateTask', 'endState', '右手独立握稳杯身，左手仍拿包');
      await settle();
      await vi.advanceTimersByTimeAsync(950);
      await settle();
      expect(productionApi.save).toHaveBeenCalledTimes(1);
      expect(productionApi.save).toHaveBeenCalledWith(
        'p',
        'r',
        1,
        expect.any(Object),
        'SHOTS',
        true,
        expect.any(AbortSignal),
      );
      const current = stored.videoPlan.clips[0]!,
        shot = stored.videoPlan.shots.find((s) => s.id === current.shotIds[0])!;
      expect(current.shotIds).toHaveLength(1);
      expect(current.startState).toBe(shot.startState);
      expect(current.endState).toBe(shot.endState);
      expect(current.endState).toBe('右手独立握稳杯身，左手仍拿包');
      expect(stored.videoPlan.clips[1]).toEqual(sibling);
      expect(stored.videoPlan.shots.find((s) => s.id === siblingShot.id)).toEqual(siblingShot);
      expect(stored.videoPlan.sourceUnits).toEqual(sourceUnits);
      expect(stored.videoPlan.events).toEqual(sourceEvents);
      cleanup.shift()!();
      const refreshed = await mountWorkspace();
      expect(refreshed.workbench.task).toMatchObject({
        startState: '右手持杯，左手拿包',
        endState: current.endState,
      });
      await vi.advanceTimersByTimeAsync(950);
      await settle();
      expect(productionApi.save).toHaveBeenCalledTimes(1);
      expect(productionApi.start).not.toHaveBeenCalled();
    },
  );
  it('does not write while browsing or while the workbench is locked', () => {
    const document = fixture(),
      original = structuredClone(document),
      update = vi.fn();
    let state: Record<string, unknown> = {};
    const app = renderer.createApp(
      {
        ...Workbench,
        render(this: { $: { setupState: Record<string, unknown> } }) {
          state = this.$.setupState;
          return h('div');
        },
      } as unknown as typeof Workbench,
      {
        projectId: 'p',
        workflowRunId: 'r',
        document,
        workspace: { prompts: [], tasks: [] } as unknown as ProductionWorkspace,
        editing: true,
        locked: true,
        dirty: false,
        savePlan: async () => true,
        'onUpdate-plan': update,
      },
    );
    app.provide(ssrContextKey, { modules: new Set() });
    app.mount(node());
    cleanup.push(() => app.unmount());
    expect(update).not.toHaveBeenCalled();
    call(state, 'updateTask', 'startState', '不能写入');
    call(state, 'updateTask', 'endState', '不能写入');
    expect(update).not.toHaveBeenCalled();
    expect(document).toEqual(original);
  });
});
