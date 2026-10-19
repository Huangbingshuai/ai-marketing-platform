import { describe, expect, it } from 'vitest';
import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';
import type { ProductionShot } from '@ai-marketing/contracts';
import Directory from './ProductionShotDirectory.vue';
const shot = (id: string): ProductionShot => ({
  id,
  title: `镜头 ${id}`,
  shotType: '近景',
  cameraMovement: '固定',
  durationSeconds: 5,
  visual: '机身停留在暖光桌面',
  dialogue: '',
  audio: '',
  atmosphere: '',
  bindings: [],
});
describe('Huobao-style video task directory', () => {
  it('renders the exact compact hierarchy without prompt badges, empty illustration or a list footer', async () => {
    const html = await renderToString(
      createSSRApp(Directory, { shots: [], assets: [], locked: false }),
    );
    expect(html).toContain('视频任务列表');
    expect(html).toContain('按镜头顺序 · 0 个任务');
    expect(html).not.toContain('视频任务统计');
    expect(html).not.toContain('class="metric');
    for (const extra of ['提示词进度', '需处理', '暂无镜头任务', '添加镜头', '<footer'])
      expect(html).not.toContain(extra);
  });
  it('uses actual shot order, fields and independent video controls without fake rendered media', async () => {
    const html = await renderToString(
      createSSRApp(Directory, {
        shots: [shot('a'), shot('b')],
        assets: [],
        selectedId: 'b',
        locked: false,
      }),
    );
    expect(html).toContain('#01');
    expect(html).toContain('#02');
    expect(html).toContain('【镜头1】近景：机身停留在暖光桌面');
    expect(html).toContain('aria-label="打开镜头02制作"');
    expect(html.match(/aria-current="true"/g)).toHaveLength(1);
    expect(html.match(/待生成/g)).toHaveLength(2);
    expect(html).not.toMatch(/<video\b|<img\b/);
  });
  it('disables video actions while allowing the current tasks to be browsed', async () => {
    const html = await renderToString(
      createSSRApp(Directory, { shots: [shot('a')], assets: [], locked: true }),
    );
    expect(html).toMatch(/<button[^>]*class="shot-produce"[^>]*disabled/);
    expect(html).not.toMatch(/<button[^>]*class="shot-select"[^>]*disabled/);
  });
});
