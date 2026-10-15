import { describe, expect, it } from 'vitest';
import { transpileModule } from 'typescript';
import page from './EffectTemplateMixNodePage.vue?raw';

function transitionAt(options: { missing?: string; nextStart?: number } = {}) {
  const source = page
    .split('const transitionPreviewAt =')[1]!
    .split('const activeTransitionPreview =')[0]!;
  const compiled = transpileModule(`const execute = ${source}`, {}).outputText;
  const context = {
    selectedVariant: {
      value: {
        slots: [
          { id: 'out', transition: '硬切' },
          { id: 'in', transition: '左滑' },
        ],
      },
    },
    currentTiming: {
      value: {
        slots: [
          { id: 'out', start: 0, end: 4 },
          { id: 'in', start: options.nextStart ?? 4, end: 8 },
        ],
      },
    },
    currentDuration: { value: 8 },
    TIMELINE_FPS: 30,
    materialForSlot: (id: string) => id !== options.missing,
    effectTemplateMixTransitionDuration: () => 0.6,
  };
  return new Function(...Object.keys(context), `${compiled}\nreturn execute;`)(
    ...Object.values(context),
  ) as (seconds: number) => { start: number; end: number; progress: number } | null;
}

describe('two-decoder transition boundaries', () => {
  it('requires both pictures and keeps the centered transition progress deterministic', () => {
    expect(transitionAt()(4)).toMatchObject({ start: 3.7, end: 4.3, progress: 0.5 });
    expect(transitionAt()(3.6)).toBeNull();
    expect(transitionAt()(4.3)).toBeNull();
  });
  it.each(['in', 'out'])(
    'does not wait for a nonexistent %s decoder in an empty slot',
    (missing) => {
      expect(transitionAt({ missing })(4)).toBeNull();
    },
  );
  it('does not blend across an intentional timeline gap', () => {
    expect(transitionAt({ nextStart: 4.5 })(4.5)).toBeNull();
  });
});
