import { describe, expect, it } from 'vitest';

import componentSource from './WorkflowRunProgress.vue?raw';

describe('WorkflowRunProgress', () => {
  it('provides one accessible and reusable workflow progress layout', () => {
    expect(componentSource).toContain('role="progressbar"');
    expect(componentSource).toContain(':aria-valuenow="normalizedProgress"');
    expect(componentSource).toContain("actionLabel: '查看节点进度'");
    expect(componentSource).toContain("emit('showDetails', $event)");
    expect(componentSource).toContain('Math.min(100, Math.max(0, props.progress))');
  });

  it('supports optional attempt and retry information without coupling to one workflow', () => {
    expect(componentSource).toContain('v-if="attemptLabel"');
    expect(componentSource).toContain('v-if="warning"');
    expect(componentSource).not.toContain('Prompt 生成');
    expect(componentSource).not.toContain('信息提炼');
  });
});
