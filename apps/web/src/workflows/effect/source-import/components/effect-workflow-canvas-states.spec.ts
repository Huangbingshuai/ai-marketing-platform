import { describe, expect, it } from 'vitest';
import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';
import WorkflowCanvas from './EffectWorkflowCanvas.vue';
import canvas from './EffectWorkflowCanvas.vue?raw';

const style = (selector: string) => canvas.split(`${selector} {`)[1]?.split('}')[0];

describe('shared canvas runtime defaults', () => {
  it('keeps six effect nodes and its branch entry when optional Boolean props are absent', async () => {
    const html = await renderToString(createSSRApp(WorkflowCanvas, { activeStep: 0 }));
    expect(html).toContain('查看版本分支树');
    expect(html.match(/\beffect-flow__node\b/g)).toHaveLength(6);
    expect(html).toContain('/ 06');
  });

  it('uses the same selection and preceding-step highlights for seven customized nodes', async () => {
    const nodes = Array.from({ length: 7 }, (_, index) => ({
      label: `节点${index}`,
      title: `节点${index}`,
      status: '待接入',
      description: '定制节点',
    }));
    const html = await renderToString(
      createSSRApp(WorkflowCanvas, {
        activeStep: 3,
        nodes,
        workflowLabel: '定制类',
        showBranches: false,
      }),
    );
    expect(html.match(/\beffect-flow__node\b/g)).toHaveLength(7);
    expect(html).toContain('定制类工作流节点');
    expect(html).toContain('/ 07');
    expect(html).not.toContain('查看版本分支树');
    expect(html.match(/<article[^>]*class="[^"]*\bcompleted\b/g)).toHaveLength(3);
    expect(html.match(/<article[^>]*class="[^"]*\bcurrent\b/g)).toHaveLength(1);
    expect(html.match(/<article[^>]*class="[^"]*\bready\b/g)).toHaveLength(3);
  });
});

describe('canvas selection and stale warnings are independent', () => {
  it('applies current and stale classes independently', () => {
    expect(canvas).toContain("[nodeState(index), { 'needs-update': staleCount(index) > 0 }]");
    expect(canvas).toContain("if (index === props.activeStep) return 'current';");
  });

  it('blends selected blue and stale amber into one gradient border', () => {
    const combined = style('.effect-flow__node.needs-update.current');
    expect(combined).toContain(
      'linear-gradient(112deg, #2563eb 0%, #7652c8 48%, #d97706 100%) border-box;',
    );
    expect(combined).toContain('linear-gradient(135deg, #eff5ff 0%, #fff4df 100%) padding-box');
    expect(combined).not.toContain('0 0 0');
    expect(canvas.indexOf('.effect-flow__node.needs-update.current {')).toBeGreaterThan(
      canvas.indexOf('.effect-flow__node.needs-update {'),
    );
  });

  it('keeps unselected stale nodes amber and non-stale selected nodes blue', () => {
    expect(style('.effect-flow__node.needs-update')).toContain('border-color: #f3ae54;');
    expect(style('.effect-flow__node.current')).toContain('border-color: #93b4ff;');
    expect(style('.effect-flow__node.current')).not.toContain('#f59e0b');
  });

  it('retains warning text and accessible navigation without changing freshness data', () => {
    expect(canvas).toContain("? '待更新' : nodes.value[index]?.status");
    expect(canvas).toContain('@click="emit(\'select\', index)"');
    expect(canvas).toMatch(/AlertCircle\s+v-if="staleCount\(index\) > 0"/);
  });
});
