import { describe, expect, it } from 'vitest';

import selectSource from './components/EffectUpwardCreatableSelect.vue?raw';

describe('upward creatable select overlay', () => {
  it('teleports its fixed menu outside scrollable dialog ancestors', () => {
    expect(selectSource).toContain('<Teleport to="body">');
    expect(selectSource).toMatch(/\.effect-up-select__menu\s*\{[\s\S]*position:\s*fixed;/);
    expect(selectSource).toContain('bottom: `${Math.max(8, window.innerHeight - rect.top + 8)}px`');
  });

  it('treats pointer interaction inside the teleported menu as internal', () => {
    expect(selectSource).toContain('!menu.value.contains(target)');
  });
});
