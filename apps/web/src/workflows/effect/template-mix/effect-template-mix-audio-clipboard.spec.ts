import { describe, expect, it, vi } from 'vitest';
import { ScriptTarget, transpileModule } from 'typescript';
import page from './EffectTemplateMixNodePage.vue?raw';
import timeline from './EffectTemplateMixTimeline.vue?raw';

function execute(source: string, name: string, context: Record<string, unknown>) {
  const js = transpileModule(source, {
    compilerOptions: { target: ScriptTarget.ES2022 },
  }).outputText;
  return new Function(...Object.keys(context), `${js}; return ${name};`)(...Object.values(context));
}

describe('audio clipboard source identity', () => {
  it.each(['VOICE', 'MUSIC'] as const)(
    'copies a packaged %s as an authorized file with its mix kind',
    (kind) => {
      const clipboard = { value: null as unknown };
      const media = { fileObjectId: 'file', duration: 8, volume: 0.5 };
      const copy = execute(
        `const copyAudioClip =${timeline.split('const copyAudioClip =')[1]!.split('const contextAudioDetached =')[0]!}`,
        'copyAudioClip',
        {
          props: { packaging: { checkpoint: { music: media, voices: { line: media } } } },
          timelineClipboard: clipboard,
          emit: vi.fn(),
        },
      );
      copy(kind === 'MUSIC' ? 'music' : 'voice:line');
      const audio = (clipboard.value as { audio: Record<string, unknown> }).audio;
      const variant = { detachedAudios: [] as Record<string, unknown>[] };
      const remember = vi.fn();
      const fullPaste = execute(
        `const pasteTimelineAudioMaterial =${page.split('const pasteTimelineAudioMaterial =')[1]!.split('\nconst ')[0]!}`,
        'pasteTimelineAudioMaterial',
        {
          selectedVariant: { value: variant },
          projectEditLocked: { value: false },
          EFFECT_TEMPLATE_MIX_MAX_CONTENT_SECONDS: 3600,
          rememberTimelineEdit: remember,
          normalizeVariantAudioLanes: vi.fn(),
          selectedCaptionIds: { value: [] },
          selectedAudioClipIds: { value: [] },
          resetTimelinePlayerState: vi.fn(),
          bump: vi.fn(),
          showNotice: vi.fn(),
          crypto,
        },
      );
      fullPaste({ ...audio, start: 1 });
      expect(variant.detachedAudios[0]).toMatchObject({
        sourceType: 'FILE',
        audioKind: kind,
        fileObjectId: 'file',
        start: 1,
        duration: 8,
      });
      expect(remember).toHaveBeenCalledOnce();
      if (kind === 'MUSIC') expect(variant.detachedAudios[0]!.loopSource).toBe(true);
    },
  );
});
