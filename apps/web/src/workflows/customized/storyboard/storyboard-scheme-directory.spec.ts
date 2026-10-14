import { describe, expect, it } from 'vitest';
import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';
import Directory from './StoryboardSchemeDirectory.vue';
import { createStoryboardScript, snapshotStoryboard } from './storyboard-state';

describe('script scheme directory', () => {
  it('renders every scheme with one controlled current selection without mutating scripts', async () => {
    const scripts = Array.from({ length: 8 }, (_, i) => {
      const script = createStoryboardScript(`第 ${i + 1} 套完整故事`);
      script.synopsis = `第 ${i + 1} 套故事的独立概述`;
      script.story!.beats[0]!.durationSeconds = 15 + i;
      return script;
    });
    const before = snapshotStoryboard(scripts);
    const html = await renderToString(
      createSSRApp(Directory, { scripts, activeId: scripts[3]!.id }),
    );
    for (const script of scripts) {
      expect(html).toContain(script.name);
      expect(html).toContain(script.synopsis);
    }
    expect(html.match(/aria-pressed="true"/g) ?? []).toHaveLength(1);
    expect(html.match(/tabindex="0"/g) ?? []).toHaveLength(1);
    expect(html).toContain('当前查看 04');
    expect(html).toContain('18 秒');
    expect(html).toContain('展开全部');
    expect(html).not.toContain('<select');
    expect(scripts).toEqual(before);
  });

  it('keeps a single scheme compact and leaves the page empty state to its parent', async () => {
    const script = createStoryboardScript('单个故事');
    script.synopsis = '单个方案无需重复展示的概述';
    const html = await renderToString(
      createSSRApp(Directory, { scripts: [script], activeId: script.id }),
    );
    expect(html).toContain(script.name);
    expect(html).not.toContain(script.synopsis);
    expect(html).not.toContain('展开全部');
    expect(html).not.toContain('下一组方案');
    const empty = await renderToString(createSSRApp(Directory, { scripts: [], activeId: null }));
    expect(empty).not.toContain('脚本方案目录');
  });

  it('preserves long titles, all accumulated schemes and missing-description semantics', async () => {
    const scripts = Array.from({ length: 100 }, (_, i) => createStoryboardScript(`方案 ${i + 1}`));
    scripts[99]!.name = '一段需要完整保留并可通过键盘访问的长脚本名称'.repeat(5);
    const html = await renderToString(
      createSSRApp(Directory, { scripts, activeId: scripts[99]!.id }),
    );
    expect(html.match(/aria-pressed=/g) ?? []).toHaveLength(100);
    expect(html).toContain(scripts[99]!.name);
    expect(html).toContain('当前查看 100');
    expect(html).toContain('尚未填写故事概述');
    expect(html).not.toContain('主脚本');
  });
});
