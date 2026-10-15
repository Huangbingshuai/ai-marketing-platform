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
  it('accepts an advancing decoded playback frame without requiring the paused trim timestamp', () => {
    const gate = new TimelineFramePresentation(),
      publish = vi.fn(),
      player = video();
    player.currentTime = 4.75;
    expect(gate.presentPlayback(player, publish)).toBe(true);
    player.currentTime += 0.1;
    tick();
    tick();
    expect(publish).toHaveBeenCalledOnce();
  });
  it.each(['seeking', 'metadata', 'old-source'])(
    'does not hand off a %s playback frame',
    (kind) => {
      const gate = new TimelineFramePresentation(),
        publish = vi.fn(),
        player = video();
      if (kind === 'seeking') player.seeking = true;
      if (kind === 'metadata') player.readyState = 1;
      if (kind === 'old-source') player.currentSrc = 'old';
      expect(gate.presentPlayback(player, publish)).toBe(false);
      expect(publish).not.toHaveBeenCalled();
    },
  );
  it('cancels a still-frame paint request when decoded playback takes over', () => {
    const gate = new TimelineFramePresentation(),
      still = vi.fn(),
      running = vi.fn(),
      player = video();
    gate.present(player, 1.25, 1 / 30, still);
    tick();
    player.currentTime = 1.5;
    expect(gate.presentPlayback(player, running)).toBe(true);
    tick();
    expect(still).not.toHaveBeenCalled();
    expect(running).toHaveBeenCalledOnce();
    expect(frames.size).toBe(0);
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
  it('does not restart the paint gate for repeated readiness reports of the same frame', () => {
    const gate = new TimelineFramePresentation(), player = video(), publish = vi.fn();
    gate.present(player, 1.25, 1 / 30, publish);
    tick();
    gate.present(player, 1.25, 1 / 30, publish);
    gate.present(player, 1.25, 1 / 30, publish);
    tick();
    expect(publish).toHaveBeenCalledOnce();
    expect(frames.size).toBe(0);
  });
  it('retains the paint deadline but refreshes the callback for a duplicate target', () => {
    const gate = new TimelineFramePresentation(), player = video(), old = vi.fn(), latest = vi.fn();
    gate.present(player, 1.25, 1 / 30, old);
    tick();
    gate.present(player, 1.25, 1 / 30, latest);
    tick();
    expect(old).not.toHaveBeenCalled();
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
    expect(page).toContain('presentedPreviewSourceIdentity.value !== previewSourceIdentity.value');
    expect(page).toContain('framePresentation.reset()');
    expect(identity).toContain('playbackSeekVersion.value');
    expect(visibility).not.toContain('playhead.value === 0');
    expect(visibility).toContain('!playing.value');
    expect(visibility).toContain('!displayedTimelineSlotId.value && !!previewCachedPoster.value');
    expect(visibility).not.toContain('previewMediaIdentity.value');
    expect(page).not.toContain('captureDisplayedFrame()');
  });
  it('keeps an already decoded source visible during scrubbing while fencing stale seek callbacks', () => {
    const sourceIdentity = page.split('const previewSourceIdentity = computed(() =>')[1]!
      .split(']));')[0]!;
    const seekIdentity = page.split('const previewMediaIdentity = computed(() =>')[1]!
      .split(']));')[0]!;
    expect(sourceIdentity).not.toContain('playbackSeekVersion.value');
    expect(sourceIdentity).toContain('currentWorkspaceScope.value');
    expect(sourceIdentity).toContain('selectedVariant.value?.id');
    expect(sourceIdentity).toContain('previewMaterial.value?.contentHash');
    expect(sourceIdentity).toContain('selectedVariant.value?.offsets');
    expect(seekIdentity).toContain('previewSourceIdentity.value, playbackSeekVersion.value');
    expect(page).toContain('identity !== previewMediaIdentity.value');
    expect(page).toContain('presentedPreviewSourceIdentity.value = previewSourceIdentity.value');
    expect(page).toContain("presentedPreviewSourceIdentity.value = ''");
  });
  it('uses decoded playback handoffs and never re-seeks a natural boundary from the poster watcher', () => {
    const playback = page
      .split('const syncPlayingVideoFrame =')[1]!
      .split('const updatePlaybackFrame =')[0]!;
    const switched = playback.split('if (switchedSlot) {')[1]!.split('// Only unprepared')[0]!;
    const watcher = page
      .split('watch(previewMediaIdentity,')[1]!
      .split('watch(auditionMaterial,')[0]!;
    expect(page).toContain('framePresentation.presentPlayback(video, publish)');
    expect(playback).toContain('presentTimelineFrame(slot.id, video)');
    expect(playback).toContain('presentTimelineFrame(transition.incomingSlot.id, incoming)');
    expect(switched).not.toContain("displayedTimelineSlotId.value = ''");
    expect(page).toContain('playing.value ? playbackDisplaySlotId.value');
    expect(watcher).toContain('if (playing.value) syncPlayingVideoFrame()');
    expect(watcher).not.toContain('syncPlayerToPlayhead(playing.value)');
  });
  it('hands the media layer over immediately only after source and decoded-frame validation', () => {
    const presentation = page
      .split('const presentTimelineFrame =')[1]!
      .split('const slotHasDetachedAudio')[0]!;
    const callback = presentation
      .split('const publish = () => {')[1]!
      .split('if (playing.value) {')[0]!;
    expect(callback.indexOf('identity !== previewMediaIdentity.value')).toBeLessThan(
      callback.indexOf('player.style.opacity'),
    );
    expect(callback).toContain("player.classList.toggle('is-visible', visible)");
    expect(callback).toContain('displayedTimelineSlotId.value = slotId');
    const running = page
      .split('const syncPlayingVideoFrame =')[1]!
      .split('const updatePlaybackFrame =')[0]!;
    expect(running).not.toContain('displayedTimelineSlotId.value = slot.id');
  });
});
