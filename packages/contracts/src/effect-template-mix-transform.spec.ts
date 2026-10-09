import { describe, it, expect } from 'vitest';
import {
  EFFECT_VIDEO_TRANSFORM_DEFAULT as identity,
  effectCanvasAspect,
  effectVideoGeometry,
  effectVideoTransformValid,
  effectVideoTransformSnapshot,
  effectResolvedCanvasRatio,
  EFFECT_CANVAS_RATIOS,
} from './effect-template-mix-transform';
describe('canvas and video transform contract', () => {
  it.each(EFFECT_CANVAS_RATIOS)('supports $value', ({ value }) =>
    expect(effectCanvasAspect(value)).not.toBeNull(),
  );
  it.each(['adaptive', '0:1', '1:0', 'NaN:1', '100:1', '1:100', '1:-1', '16/9', '', '1e3:1'])(
    'rejects %s',
    (value) => expect(effectCanvasAspect(value)).toBeNull(),
  );
  it('contains a portrait within a landscape and rotates its bounds', () => {
    const g = effectVideoGeometry(9 / 16, 16 / 9, { ...identity });
    expect(g.height).toBe(1);
    expect(g.width).toBeCloseTo(81 / 256);
    const rotated = effectVideoGeometry(9 / 16, 16 / 9, { ...identity, rotation: 90 });
    expect(rotated.boxWidth).toBeCloseTo(9 / 16);
    expect(rotated.boxHeight).toBeCloseTo(9 / 16);
  });
  it('accepts bounded nonuniform transforms but rejects nonfinite and out-of-range numbers', () => {
    expect(
      effectVideoTransformValid({
        ...identity,
        scaleX: 5,
        scaleY: 0.1,
        x: -2,
        y: 2,
        rotation: -180,
        uniform: false,
      }),
    ).toBe(true);
    for (const patch of [
      { x: Infinity },
      { y: NaN },
      { scaleX: 0 },
      { scaleY: 5.1 },
      { rotation: 181 },
      { uniform: 1 },
    ])
      expect(effectVideoTransformValid({ ...identity, ...patch })).toBe(false);
  });
  it('does not restate a physical identity when the uniform toggle changes', () => {
    expect(effectVideoTransformSnapshot()).toBeUndefined();
    expect(effectVideoTransformSnapshot({ ...identity, uniform: false })).toBeUndefined();
    expect(effectVideoTransformSnapshot({ ...identity, x: 0.1, uniform: false })).toEqual({
      x: 0.1,
      y: 0,
      scaleX: 1,
      scaleY: 1,
      rotation: 0,
    });
  });
  it('keeps the user selection and uses render configuration only as a default', () => {
    const v = {
      slots: [{ id: 'a' }, { id: 'b' }],
      bindings: { a: 'first', b: 'second' },
      canvasRatio: '1:1',
    };
    const materials = [
      { id: 'first', ratio: '3:4' },
      { id: 'second', ratio: '16:9' },
    ];
    expect(effectResolvedCanvasRatio(v, materials, 'adaptive')).toBe('1:1');
    expect(effectResolvedCanvasRatio(v, materials, '9:16')).toBe('1:1');
    expect(
      effectResolvedCanvasRatio({ ...v, canvasRatio: undefined } as never, materials, 'adaptive'),
    ).toBe('3:4');
    expect(
      effectResolvedCanvasRatio({ ...v, canvasRatio: undefined } as never, materials, '4:3'),
    ).toBe('4:3');
  });
  it('defaults adaptive to the most frequent actual pool ratio, not the first clip', () => {
    const variant = { slots: [], bindings: {} };
    const materials = [
      { id: 'first', ratio: '16:9' },
      { id: 'portrait1', ratio: '720:1280' },
      { id: 'portrait2', ratio: '9:16' },
      { id: 'invalid', ratio: 'adaptive' },
    ];
    expect(effectResolvedCanvasRatio(variant, materials, 'adaptive')).toBe('9:16');
    expect(effectResolvedCanvasRatio(variant, [...materials].reverse(), 'adaptive')).toBe('9:16');
    expect(
      effectResolvedCanvasRatio(
        variant,
        [...materials, { id: 'l2', ratio: '16:9' }, { id: 'l3', ratio: '16:9' }],
        'adaptive',
      ),
    ).toBe('16:9');
    expect(effectResolvedCanvasRatio(variant, [], 'adaptive')).toBe('9:16');
    expect(effectResolvedCanvasRatio(variant, [materials[0]!, materials[2]!], 'adaptive')).toBe(
      '9:16',
    );
  });
});
