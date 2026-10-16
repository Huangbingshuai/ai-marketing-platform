import { describe, expect, it, vi } from 'vitest';
import { ScriptTarget, transpileModule } from 'typescript';
import timeline from './EffectTemplateMixTimeline.vue?raw';

function dropFixture(slotId = '', border: { kind: string; lane: number } | null = null) {
  const emit = vi.fn();
  const context = {
    emit,
    acceptsMaterialDrag: () => true,
    trackInsertTarget: { value: border },
    materialDropSlotId: { value: '' },
    slotIdFromDragEvent: () => slotId,
    setSelection: vi.fn(),
    videoTrack: { value: { getBoundingClientRect: () => ({ top: 100 }) } },
    occupiedVideoLaneValues: { value: [0, 2] },
    videoLaneAtClientY: () => 2,
    dropTimeFromClientX: () => 6,
  };
  const source = `const onMaterialDrop =${timeline.split('const onMaterialDrop =')[1]!.split('const acceptsMusicAssetDrag =')[0]!}`;
  const js = transpileModule(source, {
    compilerOptions: { target: ScriptTarget.ES2022 },
  }).outputText;
  const drop = new Function(...Object.keys(context), `${js}; return onMaterialDrop;`)(
    ...Object.values(context),
  );
  drop({
    preventDefault: vi.fn(),
    clientX: 90,
    clientY: 200,
    dataTransfer: { getData: () => 'new-material' },
  });
  return { emit, context };
}
describe('video library drop into free track space', () => {
  it('places a new clip at the pointer without requiring a bound template slot', () => {
    expect(dropFixture().emit).toHaveBeenCalledWith('placeMaterialTrack', 'new-material', 2, 6);
  });
  it('still replaces the specific material under the pointer', () => {
    const f = dropFixture('slot-1');
    expect(f.emit).toHaveBeenCalledWith('assignMaterial', 'new-material', 'slot-1');
    expect(f.emit).toHaveBeenCalledTimes(1);
  });
  it('still inserts a new row on a row border', () => {
    expect(dropFixture('', { kind: 'VIDEO', lane: 1 }).emit).toHaveBeenCalledWith(
      'insertMaterialTrack',
      'new-material',
      1,
      6,
    );
  });
});
