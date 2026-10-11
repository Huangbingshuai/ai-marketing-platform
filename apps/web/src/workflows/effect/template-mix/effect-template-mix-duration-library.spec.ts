import { describe, expect, it } from 'vitest';
import { computed, ref } from 'vue';
import { ScriptTarget, transpileModule } from 'typescript';
import { effectTemplateMixMaterialFitsTemplate } from '@ai-marketing/contracts';
import page from './EffectTemplateMixNodePage.vue?raw';

function harness() {
  const materials = [
    { id: 'short-ai', duration: 5.041667 },
    { id: 'short-import', duration: 5, origin: 'EXTERNAL_IMPORT' },
    { id: 'equal', duration: 6 },
    { id: 'long', duration: 15 },
    { id: 'invalid', duration: NaN },
    { id: 'removed', duration: 15, activeSource: false },
    { id: 'unavailable', duration: 15, available: false },
  ].map((value) => ({ available: true, activeSource: true, ...value, fileObjectId: value.id }));
  const workspace = ref({
    materials,
    template: { slots: Array.from({ length: 6 }, () => ({ duration: 6 })) },
  });
  const context = {
    computed,
    workspace,
    activeEntry: ref({ materialRoleOverrides: {} }),
    activeClassificationPool: ref<{ items: Array<{ materialId: string }> }>({ items: [] }),
    effectTemplateMixMaterialFitsTemplate,
  };
  const source = page
    .split('const availableMaterials =')[1]!
    .split('const expiredMaterialCount')[0]!;
  const script = transpileModule(`const availableMaterials =${source}`, {
    compilerOptions: { target: ScriptTarget.ES2022 },
  }).outputText;
  const library = new Function(...Object.keys(context), `${script}\nreturn availableMaterials;`)(
    ...Object.values(context),
  );
  return { workspace, library, context };
}

describe('template-local duration admission executes the actual library projection', () => {
  it('excludes both AI and imported 5-second sources from all-6-second slots, without deleting sources', () => {
    const { workspace, library } = harness();
    const before = JSON.stringify(workspace.value.materials);
    expect(library.value.map((item: { id: string }) => item.id)).toEqual(['equal', 'long']);
    expect(workspace.value.materials).toHaveLength(7);
    expect(JSON.stringify(workspace.value.materials)).toBe(before);
    expect(
      page.split('const unassignedMaterialCount =')[1]!.split('const preferredMaterialRole')[0]!,
    ).toContain('availableMaterials.value.filter');
    expect(
      page.split('const filteredMaterials =')[1]!.split('const materialColumnCount')[0]!,
    ).toContain('availableMaterials.value');
  });

  it('reactively admits short sources for mixed slots, then excludes them again on template switch', () => {
    const { workspace, library } = harness();
    workspace.value.template = { slots: [{ duration: 4 }, { duration: 6 }] };
    expect(library.value.map((item: { id: string }) => item.id)).toEqual([
      'short-ai',
      'short-import',
      'equal',
      'long',
    ]);
    workspace.value.template = { slots: [{ duration: 6 }] };
    expect(library.value.map((item: { id: string }) => item.id)).toEqual(['equal', 'long']);
    workspace.value.template.slots[0]!.duration = 5;
    expect(library.value).toHaveLength(4);
  });

  it('does not let old classification or manual overrides bypass duration admission', () => {
    const { library, context } = harness();
    context.activeEntry.value.materialRoleOverrides = { 'short-ai': 'HOOK' };
    context.activeClassificationPool.value.items = [{ materialId: 'short-import' }];
    expect(library.value.map((item: { id: string }) => item.id)).toEqual(['equal', 'long']);
  });
});
