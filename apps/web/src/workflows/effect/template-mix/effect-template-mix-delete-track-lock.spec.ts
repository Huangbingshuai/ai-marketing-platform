import { describe, expect, it, vi } from 'vitest';
import { ScriptTarget, transpileModule } from 'typescript';
import page from './EffectTemplateMixNodePage.vue?raw';

function deleteFixture(kind: 'VIDEO' | 'AUDIO' | 'CAPTION', locked: boolean) {
  const remove = vi.fn();
  const context = {
    selectedCaptionIds: { value: kind === 'CAPTION' ? ['caption-1'] : [] },
    selectedAudioClipIds: { value: kind === 'AUDIO' ? ['detached:audio-1'] : [] },
    timelineRef: { value: { isMaterialLocked: () => locked, clearSelection: vi.fn() } },
    videoTrackLocked: { value: locked },
    showNotice: vi.fn(),
    selectedVariant: {
      value: {
        slots: [{ id: 'slot-1' }],
        bindings: { 'slot-1': 'material' },
        captions: [{ id: 'caption-1' }],
      },
    },
    activeUi: { value: { selectedSlotId: 'slot-1' } },
    selectedPackaging: { value: null },
    projectEditLocked: { value: false },
    activeTransitionSlotId: { value: '' },
    removeMaterialFromSlot: remove,
    deleteSelectedAudioClips: remove,
    rememberTimelineEdit: vi.fn(),
    bump: remove,
  };
  const source = `const deleteSelectedTimelineItem =${page.split('const deleteSelectedTimelineItem =')[1]!.split('const previewTransitionDuration =')[0]!}`;
  const js = transpileModule(source, {
    compilerOptions: { target: ScriptTarget.ES2022 },
  }).outputText;
  const execute = new Function(
    ...Object.keys(context),
    `${js}; return deleteSelectedTimelineItem;`,
  )(...Object.values(context));
  execute();
  return { remove, context };
}
describe('Delete respects manually locked tracks', () => {
  it.each(['VIDEO', 'AUDIO', 'CAPTION'] as const)(
    'keeps locked %s material and undo history intact',
    (kind) => {
      const f = deleteFixture(kind, true);
      expect(f.remove).not.toHaveBeenCalled();
      expect(f.context.rememberTimelineEdit).not.toHaveBeenCalled();
      expect(f.context.showNotice).toHaveBeenCalledWith(
        '轨道已锁定，请先解锁再删除素材',
        'warning',
      );
    },
  );
  it.each(['VIDEO', 'AUDIO', 'CAPTION'] as const)('still deletes unlocked %s material', (kind) => {
    expect(deleteFixture(kind, false).remove).toHaveBeenCalledOnce();
  });
});
