import { describe, expect, it, vi } from 'vitest';
import { ScriptTarget, transpileModule } from 'typescript';
import page from './EffectTemplateMixNodePage.vue?raw';

function fixture(duration: number, offset = 1) {
  const variant = {
    slots: [{ id: 'target', duration: 4 }],
    bindings: { target: 'old' },
    bindingRevisions: {},
    offsets: {},
    manualSlotIds: [],
    conflictSlotIds: [],
  };
  const context = {
    selectedVariant: { value: variant },
    workspace: {
      value: {
        materials: [
          {
            id: 'new',
            available: true,
            artifactRevision: 2,
            duration: 4,
            fileObjectId: 'file-new',
          },
          {
            id: 'old',
            available: true,
            artifactRevision: 2,
            duration: 4,
            fileObjectId: 'file-old',
          },
        ],
      },
    },
    projectEditLocked: { value: false },
    activeUi: { value: {} },
    effectVideoTransformValid: () => true,
    rememberTimelineEdit: vi.fn(),
    clearDetachedAudioForSlots: vi.fn(),
    cloneMaterial: structuredClone,
    resetTimelinePlayerState: vi.fn(),
    clearDetachedTransitions: vi.fn(),
    bump: vi.fn(),
    showNotice: vi.fn(),
  };
  const source = `const pasteTimelineVideoMaterials =${page.split('const pasteTimelineVideoMaterials =')[1]!.split('const pasteTimelineAudioMaterial =')[0]!}`;
  const js = transpileModule(source, {
    compilerOptions: { target: ScriptTarget.ES2022 },
  }).outputText;
  const paste = new Function(...Object.keys(context), `${js}; return pasteTimelineVideoMaterials;`)(
    ...Object.values(context),
  );
  paste([{ materialId: 'new', targetSlotId: 'target', duration, offset }]);
  return { variant, context };
}

describe('trimmed video clipboard', () => {
  it.each([1 / 30, 1.9, 3])(
    'pastes a %s-second source range into the selected target',
    (duration) => {
      const { variant, context } = fixture(duration);
      expect(variant.bindings.target).toBe('new');
      expect(variant.slots[0]!.duration).toBe(duration);
      expect(context.bump).toHaveBeenCalledOnce();
    },
  );
  it.each([
    [0, 1],
    [NaN, 1],
    [4, 1],
    [1, NaN],
    [1, -1],
  ])('rejects invalid or out-of-source range %s/%s', (duration, offset) => {
    const { variant, context } = fixture(duration, offset);
    expect(variant.bindings.target).toBe('old');
    expect(context.rememberTimelineEdit).not.toHaveBeenCalled();
  });
});
