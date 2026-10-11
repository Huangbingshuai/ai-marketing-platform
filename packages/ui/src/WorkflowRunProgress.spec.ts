import { describe, expect, it } from 'vitest';

import componentSource from './WorkflowRunProgress.vue?raw';

describe('WorkflowRunProgress', () => {
  it('shows terminal results without a frozen execution bar or a fake success percentage', () => {
    expect(componentSource).toContain('terminal: false');
    expect(componentSource).toContain('v-if="!terminal"');
    expect(componentSource).toContain('<strong v-if="!terminal">');
    expect(componentSource).toContain("'is-terminal': terminal");
  });
  it('provides one accessible and reusable workflow progress layout', () => {
    expect(componentSource).toContain('role="progressbar"');
    expect(componentSource).toContain(':aria-valuenow="normalizedProgress"');
    expect(componentSource).toContain('{{ normalizedProgress }}%');
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
  it('omits the action button and unused grid column when the label is empty', () => {
    expect(componentSource).toContain('<button v-if="actionLabel"');
    expect(componentSource).toContain("'without-action': !actionLabel");
    expect(componentSource).toContain('grid-template-columns: minmax(120px, 1fr) auto;');
  });
  it('shares a yellow update tone without changing default generation progress', () => {
    expect(componentSource).toContain("tone?: 'default' | 'update'");
    expect(componentSource).toContain("tone: 'default'");
    expect(componentSource).toContain("'is-update': tone === 'update'");
    expect(componentSource).toContain('--progress-fill: #2563eb;');
    expect(componentSource).toContain('--progress-fill: #f59e0b;');
    expect(componentSource).toContain('background: var(--progress-fill)');
    expect(componentSource).toContain('color: var(--progress-accent)');
  });
});
