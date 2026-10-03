import { describe, expect, it } from 'vitest';
import { resolveEffectTemplateMixMaterialRoles } from './effect-template-mix';

describe('mix material role choices', () => {
  it('keeps legacy AI classifications and allows manual changes and explicit resets', () => {
    const pool = [
      { materialId: 'a', role: 'HOOK' as const, matchScore: 0.8 },
      { materialId: 'b', role: 'PRODUCT' as const, matchScore: 0.7 },
    ];
    expect(resolveEffectTemplateMixMaterialRoles(pool).size).toBe(2);
    const result = resolveEffectTemplateMixMaterialRoles(pool, { a: 'END', b: null, c: 'PRODUCT' });
    expect(result.get('a')).toMatchObject({ role: 'END', source: 'MANUAL' });
    expect(result.has('b')).toBe(false);
    expect(result.get('c')).toMatchObject({ role: 'PRODUCT', source: 'MANUAL' });
    expect(pool[0]!.role).toBe('HOOK');
    expect(resolveEffectTemplateMixMaterialRoles([]).size).toBe(0);
  });
});
