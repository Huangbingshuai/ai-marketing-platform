import { describe, expect, it, vi } from 'vitest';
import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { isCustomizedStoryboardDraft, type StoryboardTask } from '@ai-marketing/contracts';
import {
  createStoryboardScript,
  createStoryboardShot,
  emptyStoryboardDraft,
  removeStoryboardScript,
  reorderStoryboardShot,
  scriptDuration,
  snapshotStoryboard,
  storyboardText,
  importStoryboardScript,
  storyboardAssetText,
  storyboardStructure,
  setStoryboardStructure,
} from './storyboard-state';
import { storyboardFixture } from './__fixtures__/storyboard.fixture';
import { createStoryboardDraftSaver } from './storyboard-draft-saver';
import Page from './CustomizedStoryboardNodePage.vue';
import ShotCard from './StoryboardShotCard.vue';
describe('storyboard workspace boundaries', () => {
  it('keeps ordered structure editable and clears retired creation instructions', () => {
    const draft = emptyStoryboardDraft();
    expect(draft.settings.videoType).toBe('BRAND_AD');
    draft.settings.instructions = '历史内容';
    setStoryboardStructure(draft.settings, ['黄金 3 秒钩子', '产品亮相']);
    expect(storyboardStructure(draft.settings)).toEqual(['黄金 3 秒钩子', '产品亮相']);
    expect(draft.settings.structure).toBe('黄金 3 秒钩子 → 产品亮相');
    expect(draft.settings.instructions).toBe('');
    setStoryboardStructure(draft.settings, []);
    expect(draft.settings.structureMode).toBe('AI');
    const { structureSections: _, ...legacy } = draft.settings;
    expect(
      storyboardStructure({ ...legacy, structureMode: 'CUSTOM', structure: '开场 → 收束' }),
    ).toEqual(['开场', '收束']);
  });
  it('creates genuinely empty custom scripts with independent IDs', () => {
    const a = createStoryboardScript('a'),
      b = createStoryboardScript('b');
    expect(a.shots).toEqual([]);
    expect(a.id).not.toBe(b.id);
    const s = createStoryboardShot();
    expect(s.visual).toBe('');
    expect(s.dialogues).toEqual([]);
  });
  it('reorders stable shot identities without losing their contents', () => {
    const script = storyboardFixture().scripts[0]!;
    const before = snapshotStoryboard(script.shots);
    reorderStoryboardShot(script, before[0]!.id, before[3]!.id);
    expect(script.shots[3]).toEqual(before[0]);
    expect(scriptDuration(script)).toBe(30);
    expect(new Set(script.shots.map((s) => s.id)).size).toBe(before.length);
  });
  it('clears removed candidate selection but keeps sibling scripts', () => {
    const draft = storyboardFixture();
    draft.mainCandidateId = draft.activeScriptId;
    removeStoryboardScript(draft, draft.activeScriptId!);
    expect(draft.mainCandidateId).toBeNull();
    expect(draft.scripts).toHaveLength(2);
    expect(draft.activeScriptId).toBe(draft.scripts[0]!.id);
  });
  it('exports the whole chosen script with dialogues and ordered shots', () => {
    const script = storyboardFixture().scripts[0]!;
    const text = storyboardText(script);
    expect(text).toContain('镜头 06');
    expect(text).toContain('共 6 镜 · 30 秒');
    expect(text).toContain(script.shots[1]!.dialogues[0]!.text);
    expect(text).toContain('人物资产：');
    expect(text).toContain('公共定义：虚构包装方案');
    expect(text).toContain('本镜要求：标签自然露出');
  });
  it('exports screenplay text directly and keeps creative notes out of the body', () => {
    const script = createStoryboardScript('候车时刻');
    script.synopsis = '用于介绍方案的概述';
    script.story!.content = 'S01｜内景 · 候车区｜傍晚\n\n周越收起电脑。\n\n周越：走吧。';
    script.story!.opening = '辅助创作说明';
    const text = storyboardText(script);
    expect(text).toContain(script.story!.content);
    expect(text).not.toContain(script.synopsis);
    expect(text).not.toContain(script.story!.opening);
    expect(text).not.toContain('历史方案');
  });
  it('remaps imported object identities while preserving reuse and independent per-shot requirements', () => {
    const source = storyboardFixture().scripts[0]!;
    const copy = importStoryboardScript(source);
    const other = importStoryboardScript(source);
    expect(isCustomizedStoryboardDraft({ ...emptyStoryboardDraft(), scripts: [copy, other] })).toBe(
      true,
    );
    expect(copy.id).not.toBe(source.id);
    expect(copy.assets!.every((a) => !source.assets!.some((s) => s.id === a.id))).toBe(true);
    expect(copy.assets!.every((a) => !other.assets!.some((s) => s.id === a.id))).toBe(true);
    const uses = copy.shots.slice(1).map((s) => s.assetRequirements!.products.items[0]!);
    expect(new Set(uses.map((u) => u.assetId)).size).toBe(1);
    uses[0]!.description = '只改本镜';
    expect(uses[1]!.description).not.toBe('只改本镜');
    copy.assets!.find((a) => a.id === uses[0]!.assetId)!.name = '新的公共名称';
    expect(storyboardAssetText(copy, copy.shots[2]!)).toContain('新的公共名称');
    expect(storyboardAssetText(source, source.shots[2]!)).not.toContain('新的公共名称');
  });
  it('preserves every object and requirement through draft saving and reload', async () => {
    const draft = storyboardFixture();
    let stored: unknown;
    const saver = createStoryboardDraftSaver(
      {
        snapshot: () => draft,
        put: async (_revision, value) => {
          stored = JSON.parse(JSON.stringify(value));
          return 2;
        },
      },
      1,
      draft,
    );
    draft.scripts[0]!.shots[1]!.assetRequirements!.products.items[0]!.description = '真实草稿修改';
    await saver.flush();
    expect(stored).toEqual(draft);
    expect(isCustomizedStoryboardDraft(stored)).toBe(true);
  });
  it('keeps test fixtures detached and production initial state genuinely empty', () => {
    const a = storyboardFixture(),
      b = storyboardFixture();
    a.scripts[0]!.shots[0]!.visual = 'modified';
    expect(b.scripts[0]!.shots[0]!.visual).not.toBe('modified');
    expect(b.source).toBeNull();
    expect(b.mainCandidateId).toBeNull();
    expect(isCustomizedStoryboardDraft(b)).toBe(true);
    expect(emptyStoryboardDraft().scripts).toEqual([]);
  });
  it('does not write unchanged snapshots or race saves arriving during a write', async () => {
    const draft = emptyStoryboardDraft();
    let unblock!: () => void;
    const gate = new Promise<void>((r) => {
      unblock = r;
    });
    const put = vi.fn(async () => {
      if (put.mock.calls.length === 1) await gate;
      return put.mock.calls.length;
    });
    const saver = createStoryboardDraftSaver({ snapshot: () => draft, put }, null, draft);
    await saver.flush();
    expect(put).not.toHaveBeenCalled();
    draft.settings.instructions = 'first';
    const pending = saver.flush();
    draft.settings.instructions = 'second';
    const same = saver.flush();
    expect(same).toBe(pending);
    unblock();
    await pending;
    expect(put).toHaveBeenCalledTimes(2);
    expect(saver.dirty()).toBe(false);
  });
  it('preserves local content after a conflict and retains the expected revision', async () => {
    const draft = emptyStoryboardDraft();
    const put = vi.fn().mockRejectedValueOnce(new Error('409')).mockResolvedValue(9);
    const saver = createStoryboardDraftSaver({ snapshot: () => draft, put }, 8, draft);
    draft.settings.instructions = 'keep me';
    await expect(saver.flush()).rejects.toThrow('409');
    expect(saver.dirty()).toBe(true);
    expect(draft.settings.instructions).toBe('keep me');
    await saver.flush();
    expect(put.mock.calls.map((args) => args[0])).toEqual([8, 8]);
  });
  it('does not save or dirty a draft when only viewing another candidate', async () => {
    const draft = storyboardFixture();
    const put = vi.fn();
    const saver = createStoryboardDraftSaver({ snapshot: () => draft, put }, 3, draft);
    draft.activeScriptId = draft.scripts[1]!.id;
    expect(saver.dirty()).toBe(false);
    await saver.flush();
    expect(put).not.toHaveBeenCalled();
  });
  it('renders real empty state and keeps AI and downstream actions disabled', async () => {
    const html = await renderToString(
      createSSRApp(Page, {
        draft: emptyStoryboardDraft(),
        editing: false,
        sourceReady: false,
        readonly: true,
        saving: false,
        productName: '',
        saveMessage: '尚无脚本草稿',
        error: '',
        stale: false,
        projectId: 'test-project',
        task: null,
        brief: null,
        sourceRevision: null,
        nextReady: false,
      }),
    );
    expect(html).toContain('还没有完整脚本');
    expect(html).toContain('请先保存信息提炼版本');
    expect(html).not.toContain('查看界面示例');
    expect(html).not.toMatch(/<button[^>]*>[^<]*(?:<svg[^]*?<\/svg>)?方案对比/);
    expect(html).not.toContain('进入编辑');
    expect(html).not.toContain('晚餐多一点滋味');
    expect(html).toMatch(/disabled[^>]*>[^]*?AI 创作脚本/);
    expect(html).not.toContain('每份脚本独立保存与制作');
  });
  it('renders story choices without editing shots in the story node', async () => {
    const html = await renderToString(
      createSSRApp(Page, {
        draft: storyboardFixture(),
        editing: false,
        sourceReady: true,
        readonly: false,
        saving: false,
        productName: '虚构示例',
        saveMessage: '',
        error: '',
        stale: false,
        projectId: 'test-project',
        task: null,
        brief: null,
        sourceRevision: null,
        nextReady: false,
      }),
    );
    for (const text of [
      '晚餐多一点滋味',
      '完整脚本',
      '历史脚本',
      '此方案尚未保存完整剧本正文',
      '下一步：资产准备',
    ])
      expect(html).toContain(text);
    const story = html.match(/<section[^>]*aria-label="完整脚本"[^]*?<\/section>/)?.[0];
    expect(story).toBeDefined();
    expect(story).not.toContain(storyboardFixture().scripts[0]!.synopsis);
    expect(html).toContain(storyboardFixture().scripts[0]!.synopsis);
    expect(html).not.toContain('添加镜头');
    expect(html).not.toContain('资产目录 ·');
  });

  it('offers permanent deletion for a selected published script without entering edit mode', async () => {
    const html = await renderToString(
      createSSRApp(Page, {
        draft: storyboardFixture(),
        editing: false,
        sourceReady: true,
        readonly: false,
        saving: false,
        productName: '测试产品',
        saveMessage: '',
        error: '',
        stale: false,
        projectId: 'test-project',
        task: null,
        brief: null,
        sourceRevision: 1,
        nextReady: true,
        canDelete: true,
      }),
    );
    expect(html).toContain('删除脚本');
    expect(html).not.toContain('删除空白脚本');
    expect(html).toContain('script-delete-button');
  });

  it.each([false, true])(
    'keeps the final story complete in reading/editing mode: %s',
    async (editing) => {
      const draft = emptyStoryboardDraft();
      const script = createStoryboardScript('完整脚本');
      script.story!.content =
        '第一场：候车区。\n\n周越：“我先接一下。”\n最后一场：收好充电器离开。';
      script.story!.opening = '仅在创作说明中查看的开场';
      script.synopsis = '不应重复展开的概述';
      draft.scripts = [script];
      draft.activeScriptId = script.id;
      const before = snapshotStoryboard(draft);
      const html = await renderToString(
        createSSRApp(Page, {
          draft,
          editing,
          sourceReady: true,
          readonly: false,
          saving: false,
          productName: '充电器',
          saveMessage: '',
          error: '',
          stale: false,
          projectId: 'test-project',
          task: null,
          brief: null,
          sourceRevision: 1,
          nextReady: true,
        }),
      );
      expect(html).toContain(script.story!.content);
      expect(html).not.toContain(script.synopsis);
      expect(html).not.toContain(script.story!.opening);
      expect((html.match(/<textarea\b/g) ?? []).length).toBe(editing ? 1 : 0);
      expect(html.includes('class="story-prose"')).toBe(!editing);
      expect(html).toContain('选择脚本方案');
      expect(draft).toEqual(before);
    },
  );

  it.each([false, true])(
    'shows shot edit controls only in real editing mode: %s',
    async (editable) => {
      const script = storyboardFixture().scripts[0]!;
      const html = await renderToString(
        createSSRApp(ShotCard, {
          shot: script.shots[0]!,
          index: 0,
          total: script.shots.length,
          editable,
          assets: script.assets!,
          shots: script.shots,
        }),
      );
      expect(html.includes('删除镜头')).toBe(editable);
      expect(html.includes('上移镜头')).toBe(editable);
      expect(html.includes('drag-handle')).toBe(editable);
      expect(html).not.toContain('重新创作');
    },
  );

  it('preserves legacy shot and asset data while showing the story overview', async () => {
    const draft = storyboardFixture(),
      script = draft.scripts[0]!;
    script.assets!.push({
      id: 'unused',
      kind: 'products',
      name: '未引用的产品对象',
      description: '完整且未截断的后端对象定义',
    });
    const html = await renderToString(
      createSSRApp(Page, {
        draft,
        editing: false,
        sourceReady: true,
        readonly: false,
        saving: false,
        productName: '测试产品',
        saveMessage: '',
        error: '',
        stale: false,
        projectId: 'test-project',
        task: null,
        brief: null,
        sourceRevision: 1,
        nextReady: true,
      }),
    );
    for (const text of [script.name, script.synopsis]) expect(html).toContain(text);
    // Supporting notes are available on demand instead of repeating the story on the main page.
    expect(html).toContain('创作说明');
    expect(script.structure).toBe('归家 → 准备晚餐 → 一勺点睛 → 落座享用');
    expect(script.productFocus).toBeTruthy();
    // Legacy data remains intact but shot/asset editing belongs to production now.
    expect(html).not.toContain('删除镜头');
    expect(script.shots.length).toBeGreaterThan(0);
    expect(script.assets!.find((a) => a.id === 'unused')?.description).toBe(
      '完整且未截断的后端对象定义',
    );
  });

  it('omits empty optional panels without hiding any supplied shot content', async () => {
    const shot = { ...createStoryboardShot(), title: '测试镜头', visual: '完整画面' };
    const render = () =>
      renderToString(
        createSSRApp(ShotCard, {
          shot,
          index: 0,
          total: 1,
          editable: false,
          assets: [],
          shots: [shot],
        }),
      );
    const empty = await render();
    expect(empty).toContain('完整画面');
    for (const label of ['台词 / 口播', '音效 / 音乐', '衔接说明'])
      expect(empty).not.toContain(label);
    shot.dialogues = [{ id: 'voice', speaker: '旁白', text: '完整对白' }];
    shot.audio = '真实声音提示';
    shot.continuity = '后端完整衔接说明';
    const filled = await render();
    for (const text of ['完整对白', '真实声音提示', '衔接说明']) expect(filled).toContain(text);
    // The expandable content remains in the component, never removed from the data.
    expect(shot.continuity).toBe('后端完整衔接说明');
  });

  it.each(['QUEUED', 'RUNNING', 'COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED'] as const)(
    'renders actual task status and recovery rather than a mock completion: %s',
    async (status) => {
      const running = ['QUEUED', 'RUNNING'].includes(status);
      const task: StoryboardTask = {
        id: 'task',
        workflowRunId: 'run',
        status,
        progress: status === 'COMPLETED' ? 100 : 30,
        steps: [],
        errorMessage: status === 'FAILED' ? '真实失败原因' : null,
        createdAt: '2026-10-12T00:00:00Z',
        updatedAt: '2026-10-12T00:01:00Z',
      };
      const html = await renderToString(
        createSSRApp(Page, {
          draft: emptyStoryboardDraft(),
          editing: false,
          sourceReady: true,
          readonly: false,
          saving: false,
          productName: '测试产品',
          saveMessage: '',
          error: '',
          stale: false,
          projectId: 'test-project',
          task,
          brief: null,
          sourceRevision: 1,
          nextReady: false,
          progress: {
            value: task.progress,
            summary: `真实任务 ${status}`,
            terminal: !running,
          },
        }),
      );
      expect(html.includes(`真实任务 ${status}`)).toBe(running);
      expect(html).not.toContain('取消本次创作');
      expect(html).not.toContain('aria-label="方案数量"');
      if (running) expect(html.indexOf('创作设置')).toBeLessThan(html.indexOf(`真实任务 ${status}`));
      expect(html).toContain('查看工作流');
      expect(html.includes('恢复未完成方案')).toBe(
        ['FAILED', 'PARTIAL', 'CANCELLED'].includes(status),
      );
      expect(html.includes('真实失败原因')).toBe(status === 'FAILED');
      expect(html).not.toContain('界面示例');
    },
  );
});
