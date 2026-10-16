import { describe, expect, it } from 'vitest';
import footer from '../../../../packages/ui/src/WorkflowNodeFooter.vue?raw';
import render from './effect/segment-render/EffectSegmentRenderNodePage.vue?raw';

const pages = import.meta.glob<string>('./effect/**/*NodePage.vue', {
  eager: true,
  query: '?raw',
  import: 'default',
});

describe('workflow footer navigation without redundant status', () => {
  it('keeps navigation and validation events but removes the status block', () => {
    expect(footer).not.toContain('workflow-node-footer__status');
    expect(footer).not.toContain('statusTitle');
    expect(footer).not.toContain('statusDetail');
    for (const action of ['back', 'next', 'validate'])
      expect(footer).toContain(`$emit('${action}')`);
    expect(footer).toContain(':disabled="nextDisabled"');
    expect(footer).toContain('margin-left: auto;');
  });
  it.each(Object.entries(pages))('%s has no footer status props', (_path, source) => {
    expect(source).not.toContain(':status-title=');
    expect(source).not.toContain(':status-detail=');
    expect(source).not.toContain('back-label="上一步"');
  });
  it.each([
    ['information-extraction', '资料导入'],
    ['prompt-generation', 'AI 信息提炼'],
    ['segment-render', '素材 Prompt'],
    ['template-mix', '片段渲染'],
    ['final-output', '模板混剪'],
  ])('%s names the previous node', (path, node) => {
    const source = Object.entries(pages).find(([key]) => key.includes(`/${path}/`))?.[1];
    expect(source).toContain(`back-label="上一步：${node}"`);
  });
  it('removes the redundant header export but preserves exporting selected materials', () => {
    expect(render).not.toContain('>导出素材');
    const header = render.match(/<header class="segment-heading">[\s\S]*?<\/header>/)?.[0];
    expect(header).toBeDefined();
    expect(header).not.toContain("openTransferPanel('export', $event)");
    expect(render).toContain('导出所选');
    expect(render).toContain("exportScope = 'SELECTED';");
    expect(render).toContain("openTransferPanel('export', $event);");
  });
});
