import { describe, expect, it } from 'vitest';
import canvas from './EffectWorkflowCanvas.vue?raw';

const style = (selector: string) => canvas.split(`${selector} {`)[1]?.split('}')[0];

describe('canvas selection and stale warnings are independent', () => {
  it('applies current and stale classes independently', () => {
    expect(canvas).toContain("[nodeState(index), { 'needs-update': staleCount(index) > 0 }]");
    expect(canvas).toContain("if (index === props.activeStep) return 'current';");
  });

  it('blends selected blue and stale amber into one gradient border', () => {
    const combined = style('.effect-flow__node.needs-update.current');
    expect(combined).toContain('linear-gradient(112deg, #2563eb 0%, #7652c8 48%, #d97706 100%) border-box;');
    expect(combined).toContain('linear-gradient(135deg, #eff5ff 0%, #fff4df 100%) padding-box');
    expect(combined).not.toContain('0 0 0');
    expect(canvas.indexOf('.effect-flow__node.needs-update.current {'))
      .toBeGreaterThan(canvas.indexOf('.effect-flow__node.needs-update {'));
  });

  it('keeps unselected stale nodes amber and non-stale selected nodes blue', () => {
    expect(style('.effect-flow__node.needs-update')).toContain('border-color: #f3ae54;');
    expect(style('.effect-flow__node.current')).toContain('border-color: #93b4ff;');
    expect(style('.effect-flow__node.current')).not.toContain('#f59e0b');
  });

  it('retains warning text and accessible navigation without changing freshness data', () => {
    expect(canvas).toContain("? '待更新' : nodes[index]?.status");
    expect(canvas).toContain("@click=\"emit('select', index)\"");
    expect(canvas).toContain('AlertCircle v-if="staleCount(index) > 0"');
  });
});
