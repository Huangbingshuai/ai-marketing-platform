import { describe, expect, it } from 'vitest';
import { resolveEffectTemplateMixMaterialRoles } from './effect-template-mix';

describe('mix material role choices', () => {
  it('inherits AI/manual assignments and explicit resets across confirmed replacement ids', () => {
    const materials = [{ id: 'new', replacesMaterialIds: ['old'] }];
    const pool = [{ materialId: 'old', role: 'PRODUCT' as const, matchScore: 0.8 }];
    expect(resolveEffectTemplateMixMaterialRoles(pool, {}, materials).get('new')?.role).toBe(
      'PRODUCT',
    );
    expect(
      resolveEffectTemplateMixMaterialRoles(pool, { old: 'HOOK' }, materials).get('new'),
    ).toMatchObject({ role: 'HOOK', source: 'MANUAL' });
    expect(resolveEffectTemplateMixMaterialRoles(pool, { old: null }, materials).has('new')).toBe(
      false,
    );
    expect(
      resolveEffectTemplateMixMaterialRoles(pool, { old: 'HOOK', new: 'END' }, materials).get('new')
        ?.role,
    ).toBe('END');
    expect(
      resolveEffectTemplateMixMaterialRoles(pool, { old: 'HOOK', new: null }, materials).has('new'),
    ).toBe(false);
  });
  it('does not infer a category for unrelated sources or conflicting historical choices', () => {
    expect(
      resolveEffectTemplateMixMaterialRoles([], { old: 'HOOK' }, [{ id: 'foreign' }]).has(
        'foreign',
      ),
    ).toBe(false);
    expect(
      resolveEffectTemplateMixMaterialRoles([], { a: 'HOOK', b: 'END' }, [
        { id: 'new', replacesMaterialIds: ['a', 'b'] },
      ]).has('new'),
    ).toBe(false);
  });
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
