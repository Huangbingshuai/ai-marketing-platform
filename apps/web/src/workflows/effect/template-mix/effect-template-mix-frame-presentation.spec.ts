import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import page from './EffectTemplateMixNodePage.vue?raw';
import { TimelineFramePresentation } from './effect-template-mix-frame-presentation';

describe('montage first frame presentation', () => {
  let frames: Map<number, FrameRequestCallback>;
  const tick = () => {
    const batch = [...frames.values()];
    frames.clear();
    batch.forEach((callback) => callback(0));
  };
  const video = () => ({
    src: 'a',
    currentSrc: 'a',
    currentTime: 1.25,
    readyState: 2,
    seeking: false,
  });
  beforeEach(() => {
    frames = new Map();
    let id = 0;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.set(++id, callback);
      return id;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('retains the preview until the decoded trim frame has crossed a paint', () => {
    const gate = new TimelineFramePresentation(),
      publish = vi.fn();
    gate.present(video(), 1.25, 1 / 30, publish);
    tick();
    expect(publish).not.toHaveBeenCalled();
    tick();
    expect(publish).toHaveBeenCalledOnce();
  });
  it.each(['seeking', 'metadata', 'old-source', 'wrong-trim'])(
    'does not publish %s as a first frame',
    (kind) => {
      const gate = new TimelineFramePresentation(),
        publish = vi.fn(),
        player = video();
      gate.present(player, 1.25, 1 / 30, publish);
      if (kind === 'seeking') player.seeking = true;
      if (kind === 'metadata') player.readyState = 1;
      if (kind === 'old-source') player.currentSrc = 'old';
      if (kind === 'wrong-trim') player.currentTime = 0;
      tick();
      tick();
      expect(publish).not.toHaveBeenCalled();
    },
  );
  it('rejects replaced sources and superseded trim requests during rapid switching', () => {
    const gate = new TimelineFramePresentation(),
      old = vi.fn(),
      latest = vi.fn(),
      player = video();
    gate.present(player, 1.25, 1 / 30, old);
    tick();
    player.src = player.currentSrc = 'b';
    player.currentTime = 3;
    gate.present(player, 3, 1 / 30, latest);
    tick();
    tick();
    expect(old).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledOnce();
  });
  it('publishes only the latest seek for the same source', () => {
    const gate = new TimelineFramePresentation(),
      stale = vi.fn(),
      latest = vi.fn(),
      player = video();
    gate.present(player, 1.25, 1 / 30, stale);
    tick();
    player.currentTime = 3;
    gate.present(player, 3, 1 / 30, latest);
    tick();
    tick();
    expect(stale).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledOnce();
  });
  it('cancels pending publication on scope changes or unmount', () => {
    const gate = new TimelineFramePresentation(),
      publish = vi.fn();
    gate.present(video(), 1.25, 1 / 30, publish);
    tick();
    gate.reset();
    tick();
    expect(publish).not.toHaveBeenCalled();
    expect(frames.size).toBe(0);
  });
  it('patches sources before seeking, listens for loadeddata, and reuses trimmed cover previews', () => {
    const sync = page.split('const syncPlayerToPlayhead =')[1]!.split('const scheduleSeekSync')[0]!;
    const identity = page
      .split('const previewMediaIdentity = computed(() =>')[1]!
      .split(']));')[0]!;
    const visibility = page
      .split('const previewPosterVisible = computed(() =>')[1]!
      .split(');')[0]!;
    expect(sync.indexOf('await nextTick()')).toBeLessThan(sync.indexOf('const apply ='));
    expect(page).toContain('@loadeddata="onTimelinePlayerReady(slot.id, $event)"');
    expect(page).toContain('event.currentTarget !== video');
    expect(page).toContain(':time="coverOffset(variant)"');
    expect(page).toContain('presentedPreviewIdentity.value !== previewMediaIdentity.value');
    expect(page).toContain('framePresentation.reset()');
    expect(identity).toContain('playbackSeekVersion.value');
    expect(visibility).not.toContain('playhead.value === 0');
    expect(visibility).not.toContain('!playing.value');
    expect(page).not.toContain('captureDisplayedFrame()');
  });
});
