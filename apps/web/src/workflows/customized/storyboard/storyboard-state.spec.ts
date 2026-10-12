import { describe, expect, it, vi } from 'vitest';
import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { isCustomizedStoryboardDraft } from '@ai-marketing/contracts';
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
} from './storyboard-state';
import { storyboardPreview } from './storyboard-preview';
import { createStoryboardDraftSaver } from './storyboard-draft-saver';
import Page from './CustomizedStoryboardNodePage.vue';
describe('storyboard workspace boundaries', () => {
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
    const script = storyboardPreview().scripts[0]!;
    const before = snapshotStoryboard(script.shots);
    reorderStoryboardShot(script, before[0]!.id, before[3]!.id);
    expect(script.shots[3]).toEqual(before[0]);
    expect(scriptDuration(script)).toBe(30);
    expect(new Set(script.shots.map((s) => s.id)).size).toBe(before.length);
  });
  it('clears removed candidate selection but keeps sibling scripts', () => {
    const draft = storyboardPreview();
    draft.mainCandidateId = draft.activeScriptId;
    removeStoryboardScript(draft, draft.activeScriptId!);
    expect(draft.mainCandidateId).toBeNull();
    expect(draft.scripts).toHaveLength(2);
    expect(draft.activeScriptId).toBe(draft.scripts[0]!.id);
  });
  it('exports the whole chosen script with dialogues and ordered shots', () => {
    const script = storyboardPreview().scripts[0]!;
    const text = storyboardText(script);
    expect(text).toContain('镜头 06');
    expect(text).toContain('共 6 镜 · 30 秒');
    expect(text).toContain(script.shots[1]!.dialogues[0]!.text);
    expect(text).toContain('人物资产：');
    expect(text).toContain('公共定义：虚构包装方案');
    expect(text).toContain('本镜要求：标签自然露出');
  });
  it('remaps imported object identities while preserving reuse and independent per-shot requirements', () => {
    const source = storyboardPreview().scripts[0]!;
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
    const draft = storyboardPreview();
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
  it('keeps preview snapshots detached and never creates a source reference', () => {
    const a = storyboardPreview(),
      b = storyboardPreview();
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
    const draft = storyboardPreview();
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
        preview: false,
        editing: false,
        sourceReady: false,
        readonly: true,
        saving: false,
        dirty: false,
        productName: '',
        saveMessage: '尚无脚本草稿',
        error: '',
        stale: false,
        projectId: "test-project", task: null, brief: null, sourceRevision: null, nextReady: false,
      }),
    );
    expect(html).toContain('从一个完整的故事开始');
    expect(html).toContain('查看界面示例');
    expect(html).not.toContain('晚餐多一点滋味');
    expect(html).toMatch(/disabled[^>]*>[^]*?AI 创作脚本/);
    expect(html).toContain('每份脚本独立保存与制作');
  });
  it('renders the seven storyboard fields without prematurely binding media', async () => {
    const html = await renderToString(
      createSSRApp(Page, {
        draft: storyboardPreview(),
        preview: true,
        editing: false,
        sourceReady: true,
        readonly: false,
        saving: false,
        dirty: false,
        productName: '虚构示例',
        saveMessage: '',
        error: '',
        stale: false,
        projectId: "test-project", task: null, brief: null, sourceRevision: null, nextReady: false,
      }),
    );
    for (const text of [
      '晚餐多一点滋味',
      '一勺之间',
      '熟悉的一餐',
      '画面内容描述',
      '台词 / 口播',
      '音效 / 音乐',
      '每份脚本拥有独立制作路径',
    ])
      expect(html).toContain(text);
    expect(html).not.toContain('音色库');
    expect(html).not.toContain('生成资产');
    expect(html).toContain('不写入项目');
    for (const label of [
      '人物资产',
      '产品资产',
      '场景资产',
      '本镜不需要产品资产',
      '归家者',
      '6 镜复用',
    ])
      expect(html).toContain(label);
  });
});
