import { describe, expect, it } from 'vitest';
import { computed, ref } from 'vue';
import { ScriptTarget, transpileModule } from 'typescript';
import { effectResolvedCanvasRatio } from '@ai-marketing/contracts';
import page from './EffectTemplateMixNodePage.vue?raw';

function harness() {
  const selectedVariant = ref<{
    canvasRatio?: string;
    slots: { id: string }[];
    bindings: Record<string, string>;
  } | null>(null);
  const sourceMaterials = ref<{ id: string; ratio: string }[]>([]);
  const renderAspectRatio = ref<string | null>('adaptive');
  const context = {
    computed,
    selectedVariant,
    sourceMaterials,
    renderAspectRatio,
    effectResolvedCanvasRatio,
  };
  const source = page.split('const sourceAspectLabel =')[1]!.split('const stageStyle =')[0]!;
  const script = transpileModule(`const sourceAspectLabel =${source}`, {
    compilerOptions: { target: ScriptTarget.ES2022 },
  }).outputText;
  const result = new Function(
    ...Object.keys(context),
    `${script}\nreturn { sourceAspectLabel, stageAspectRatio };`,
  )(...Object.values(context));
  return { ...context, ...result };
}

describe('player canvas initializes before a project or playback exists', () => {
  it('resolves adaptive from saved sources immediately, without creating or editing a project', () => {
    const state = harness();
    state.sourceMaterials.value = [
      { id: 'requested-adaptive', ratio: 'adaptive' },
      { id: 'known-file', ratio: '3:4' },
    ];
    expect(state.sourceAspectLabel.value).toBe('3:4');
    expect(state.stageAspectRatio.value).toBe(3 / 4);
    expect(state.selectedVariant.value).toBeNull();
  });

  it('recomputes on source restoration and scope switches without retaining the old aspect', () => {
    const state = harness();
    expect(state.sourceAspectLabel.value).toBe('9:16');
    state.sourceMaterials.value = [{ id: 'portrait', ratio: '3:4' }];
    expect(state.stageAspectRatio.value).toBe(3 / 4);
    state.sourceMaterials.value = [{ id: 'landscape', ratio: '16:9' }];
    expect(state.sourceAspectLabel.value).toBe('16:9');
    expect(state.stageAspectRatio.value).toBe(16 / 9);
    state.sourceMaterials.value = [];
    state.renderAspectRatio.value = null;
    expect(state.sourceAspectLabel.value).toBe('9:16');
  });

  it('uses identical defaults before and after an engineering project is selected', () => {
    const state = harness();
    state.sourceMaterials.value = [{ id: 'source', ratio: '3:4' }];
    const ratio = state.sourceAspectLabel.value;
    state.selectedVariant.value = { slots: [{ id: 'slot' }], bindings: { slot: 'source' } };
    expect(state.sourceAspectLabel.value).toBe(ratio);
    state.selectedVariant.value = null;
    expect(state.sourceAspectLabel.value).toBe(ratio);
  });

  it('preserves explicit engineering canvas choices and the configured default', () => {
    const state = harness();
    state.sourceMaterials.value = [{ id: 'source', ratio: '3:4' }];
    state.renderAspectRatio.value = '16:9';
    expect(state.sourceAspectLabel.value).toBe('16:9');
    state.selectedVariant.value = { canvasRatio: '1:1', slots: [], bindings: {} };
    state.sourceMaterials.value = [{ id: 'replacement', ratio: '9:16' }];
    expect(state.sourceAspectLabel.value).toBe('1:1');
    expect(state.stageAspectRatio.value).toBe(1);
    expect(state.selectedVariant.value.canvasRatio).toBe('1:1');
    delete state.selectedVariant.value.canvasRatio;
    expect(state.sourceAspectLabel.value).toBe('16:9');
  });
});
