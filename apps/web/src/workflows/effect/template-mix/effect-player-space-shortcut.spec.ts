import { describe, expect, it } from 'vitest';
import { ownsPlayerSpace } from './effect-player-space-shortcut';
import page from './EffectTemplateMixNodePage.vue?raw';

const space = {
  code: 'Space',
  key: ' ',
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  isComposing: false,
};
const workbench = { active: true, blocked: false, textEditing: false, inDialog: false };

describe('workbench playback Space ownership', () => {
  it.each(['button', 'range', 'number', 'track control', 'material', 'canvas'])(
    'owns Space on %s',
    () => {
      expect(ownsPlayerSpace(space, workbench)).toBe(true);
    },
  );
  it('supports Space by key when code is absent', () => {
    expect(ownsPlayerSpace({ ...space, code: '' }, workbench)).toBe(true);
  });
  it.each(['active', 'blocked', 'textEditing', 'inDialog'] as const)('respects %s guard', (key) => {
    expect(ownsPlayerSpace(space, { ...workbench, [key]: key !== 'active' })).toBe(false);
  });
  it.each(['ctrlKey', 'metaKey', 'altKey', 'isComposing'] as const)(
    'leaves %s combinations alone',
    (key) => {
      expect(ownsPlayerSpace({ ...space, [key]: true }, workbench)).toBe(false);
    },
  );
  it('does not claim Enter or another key', () => {
    expect(ownsPlayerSpace({ ...space, code: 'Enter', key: 'Enter' }, workbench)).toBe(false);
  });
  it('captures before child key handlers and suppresses focused-button activation on release', () => {
    for (const [type, handler] of [
      ['keydown', 'onPlayerSpaceKeydown'],
      ['keyup', 'onPlayerSpaceKeyup'],
    ]) {
      expect(page).toContain(`window.addEventListener('${type}', ${handler}, true);`);
      expect(page).toContain(`window.removeEventListener('${type}', ${handler}, true);`);
    }
    const handler = page
      .split('const onPlayerSpaceKeydown =')[1]!
      .split('const resetPlayerSpace')[0]!;
    expect(handler.match(/event.preventDefault\(\)/g)).toHaveLength(2);
    expect(handler.match(/event.stopPropagation\(\)/g)).toHaveLength(2);
    expect(handler).toContain('!event.repeat && !playerSpacePressed');
    expect(handler).toContain('finishVideoWheelGesture();');
    expect(handler).toContain('togglePreviewPlayback();');
    expect(page).toContain("window.addEventListener('blur', resetPlayerSpace);");
    expect(page).toContain('active: workbenchActive');
    expect(page).toContain('onDeactivated(() => {\n  resetPlayerSpace();');
  });
});
