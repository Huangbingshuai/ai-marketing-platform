import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MaterialFirstFrame } from './effect-material-first-frame';

class Video extends EventTarget {
  src = 'material-a';
  currentSrc = 'material-a';
  readyState = 2;
  seeking = false;
  videoWidth = 720;
  videoHeight = 1280;
  frames = new Map<number, VideoFrameRequestCallback>();
  id = 0;
  requestVideoFrameCallback = (callback: VideoFrameRequestCallback) => {
    this.frames.set(++this.id, callback);
    return this.id;
  };
  cancelVideoFrameCallback = (id: number) => {
    this.frames.delete(id);
  };
  present() {
    const callbacks = [...this.frames.values()];
    this.frames.clear();
    for (const callback of callbacks) callback(0, {} as VideoFrameCallbackMetadata);
  }
}

describe('material audition decoded first-frame gate', () => {
  let paints: Map<number, FrameRequestCallback>;
  const paint = () => {
    const callbacks = [...paints.values()];
    paints.clear();
    for (const callback of callbacks) callback(0);
  };
  beforeEach(() => {
    paints = new Map();
    let id = 0;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      paints.set(++id, callback);
      return id;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => paints.delete(id));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('keeps the cover through metadata/canplay until the decoder presents a frame', () => {
    const gate = new MaterialFirstFrame(),
      video = new Video(),
      publish = vi.fn();
    video.readyState = 1;
    gate.wait(video, publish);
    video.dispatchEvent(new Event('loadedmetadata'));
    video.readyState = 4;
    video.dispatchEvent(new Event('canplay'));
    paint();
    paint();
    expect(publish).not.toHaveBeenCalled();
    expect(video.frames.size).toBe(1);
    video.present();
    expect(publish).toHaveBeenCalledOnce();
    video.dispatchEvent(new Event('playing'));
    expect(video.frames.size).toBe(0);
  });

  it.each(['metadata', 'seeking', 'old-source', 'no-size'])('rejects a %s frame', (kind) => {
    const gate = new MaterialFirstFrame(),
      video = new Video(),
      publish = vi.fn();
    gate.wait(video, publish);
    if (kind === 'metadata') video.readyState = 1;
    if (kind === 'seeking') video.seeking = true;
    if (kind === 'old-source') video.currentSrc = 'old';
    if (kind === 'no-size') video.videoWidth = 0;
    video.present();
    expect(publish).not.toHaveBeenCalled();
    video.readyState = 2;
    video.seeking = false;
    video.currentSrc = video.src;
    video.videoWidth = 720;
    video.present();
    expect(publish).toHaveBeenCalledOnce();
  });

  it('allows a decoded paused first frame without requiring playback or skipping content', () => {
    const gate = new MaterialFirstFrame(),
      video = new Video(),
      publish = vi.fn();
    gate.wait(video, publish);
    video.present();
    expect(publish).toHaveBeenCalledOnce();
    expect(video).not.toHaveProperty('currentTime');
  });

  it('cancels stale frames and listeners when switching, replaying, closing or failing', () => {
    const gate = new MaterialFirstFrame(),
      a = new Video(),
      b = new Video();
    const old = vi.fn(),
      latest = vi.fn();
    gate.wait(a, old);
    const stale = [...a.frames.values()][0]!;
    gate.wait(b, latest);
    expect(a.frames.size).toBe(0);
    stale(0, {} as VideoFrameCallbackMetadata);
    a.dispatchEvent(new Event('playing'));
    expect(a.frames.size).toBe(0);
    expect(old).not.toHaveBeenCalled();
    b.present();
    expect(latest).toHaveBeenCalledOnce();
    gate.wait(b, old);
    gate.reset();
    gate.reset();
    b.present();
    b.dispatchEvent(new Event('loadeddata'));
    expect(old).not.toHaveBeenCalled();
    expect(b.frames.size).toBe(0);
  });

  it('does not publish a source replaced in place', () => {
    const gate = new MaterialFirstFrame(),
      video = new Video(),
      publish = vi.fn();
    gate.wait(video, publish);
    video.src = video.currentSrc = 'material-b';
    video.present();
    expect(publish).not.toHaveBeenCalled();
    gate.reset();
  });

  it('uses two compositor paints only after loaded data on browsers without video-frame callbacks', () => {
    const gate = new MaterialFirstFrame(),
      video = new Video(),
      publish = vi.fn();
    const fallback = {
      src: video.src,
      currentSrc: video.currentSrc,
      readyState: 1,
      seeking: false,
      videoWidth: 720,
      videoHeight: 1280,
      addEventListener: video.addEventListener.bind(video),
      removeEventListener: video.removeEventListener.bind(video),
    };
    gate.wait(fallback, publish);
    paint();
    paint();
    expect(publish).not.toHaveBeenCalled();
    fallback.readyState = 2;
    video.dispatchEvent(new Event('loadeddata'));
    paint();
    expect(publish).not.toHaveBeenCalled();
    paint();
    expect(publish).toHaveBeenCalledOnce();
  });

  it('cancels fallback paints on reset and rejects a seek started before reveal', () => {
    const gate = new MaterialFirstFrame(),
      video = new Video(),
      publish = vi.fn();
    const fallback = {
      src: video.src,
      currentSrc: video.currentSrc,
      readyState: 2,
      seeking: false,
      videoWidth: 720,
      videoHeight: 1280,
      addEventListener: video.addEventListener.bind(video),
      removeEventListener: video.removeEventListener.bind(video),
    };
    gate.wait(fallback, publish);
    paint();
    fallback.seeking = true;
    paint();
    expect(publish).not.toHaveBeenCalled();
    fallback.seeking = false;
    video.dispatchEvent(new Event('seeked'));
    paint();
    gate.reset();
    paint();
    expect(publish).not.toHaveBeenCalled();
    expect(paints.size).toBe(0);
  });
});
