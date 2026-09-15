import { computed, reactive, type ComputedRef } from 'vue';

type ThumbnailJob = {
  key: string;
  source: string;
  time: number;
  version: string;
};

const MAX_CONCURRENT_CAPTURES = 3;
// The current 100-project montage shares trimmed source clips. Keep all decoded
// clip frames for this workspace in memory; only evict older, unmounted frames.
const MAX_CACHED_THUMBNAILS = 2_000;
const MAX_PERSISTENT_THUMBNAILS = 6_000;
const thumbnailUrls = reactive(new Map<string, string>());
const queuedKeys = new Set<string>();
const runningKeys = new Set<string>();
const restoringKeys = new Set<string>();
const pinCounts = new Map<string, number>();
const retryAfter = new Map<string, number>();
const failureCounts = new Map<string, number>();
const jobs = new Map<string, ThumbnailJob>();
const queue: ThumbnailJob[] = [];
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let diskCache: Promise<Cache | null> | undefined;
let persistedWrites = 0;

const thumbnailKey = (source: string, time: number, version = ''): string =>
  `${source}::${version}::${Math.max(0, time).toFixed(2)}`;

const cacheRequest = (key: string): string =>
  `${window.location.origin}/__effect-template-mix-thumbnail-cache?key=${encodeURIComponent(key)}`;

const openDiskCache = (): Promise<Cache | null> => {
  diskCache ??=
    typeof caches === 'undefined'
      ? Promise.resolve(null)
      : caches.open('effect-template-mix-thumbnails-v1').catch(() => null);
  return diskCache;
};

const saveToDisk = async (key: string, blob: Blob): Promise<void> => {
  const cache = await openDiskCache();
  if (!cache) return;
  try {
    await cache.put(
      cacheRequest(key),
      new Response(blob, { headers: { 'Content-Type': 'image/jpeg' } }),
    );
    persistedWrites += 1;
    if (persistedWrites % 200 === 0) {
      const stored = await cache.keys();
      for (const request of stored.slice(0, Math.max(0, stored.length - MAX_PERSISTENT_THUMBNAILS)))
        await cache.delete(request);
    }
  } catch {
    // Browser storage quota is optional; pinned in-memory images still remain stable.
  }
};

const installThumbnail = (key: string, blob: Blob): void => {
  const previous = thumbnailUrls.get(key);
  if (previous) URL.revokeObjectURL(previous);
  thumbnailUrls.set(key, URL.createObjectURL(blob));
  retryAfter.delete(key);
  failureCounts.delete(key);
  trimCache();
};

const trimCache = (): void => {
  while (thumbnailUrls.size > MAX_CACHED_THUMBNAILS) {
    const oldest = [...thumbnailUrls.entries()].find(([key]) => !pinCounts.has(key));
    if (!oldest) return; // Visible thumbnails are never revoked.
    thumbnailUrls.delete(oldest[0]);
    URL.revokeObjectURL(oldest[1]);
  }
};

const scheduleRetry = (): void => {
  if (retryTimer || ![...retryAfter.keys()].some((key) => pinCounts.has(key))) return;
  retryTimer = window.setTimeout(() => {
    retryTimer = undefined;
    for (const [key, deadline] of retryAfter) {
      if (pinCounts.has(key) && Date.now() >= deadline) {
        const job = jobs.get(key);
        if (job) requestEffectTemplateMixThumbnail(job.source, job.time, job.version);
      }
    }
    scheduleRetry();
  }, 5_000);
};

const markFailure = (key: string): void => {
  const count = (failureCounts.get(key) ?? 0) + 1;
  failureCounts.set(key, count);
  retryAfter.set(key, Date.now() + Math.min(60_000, 5_000 * 2 ** Math.min(count - 1, 4)));
  scheduleRetry();
};

const finishJob = (key: string): void => {
  runningKeys.delete(key);
  drainQueue();
};

const captureThumbnail = ({ key, source, time }: ThumbnailJob): void => {
  runningKeys.add(key);
  const video = document.createElement('video');
  let completed = false;
  let timeout = 0;
  let targetTime = 0;
  let capturing = false;

  const cleanup = (): void => {
    window.clearTimeout(timeout);
    video.removeAttribute('src');
    video.load();
  };
  const settle = (callback: () => void): void => {
    if (completed) return;
    completed = true;
    callback();
    cleanup();
    finishJob(key);
  };
  const fail = (): void => settle(() => markFailure(key));
  const capture = (): void => {
    if (
      completed ||
      capturing ||
      video.seeking ||
      Math.abs(video.currentTime - targetTime) > 0.12 ||
      video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA ||
      video.videoWidth < 1 ||
      video.videoHeight < 1
    )
      return;
    try {
      const scale = Math.min(1, 480 / video.videoWidth);
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
      canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
      const context = canvas.getContext('2d');
      if (!context) {
        fail();
        return;
      }
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      capturing = true;
      canvas.toBlob(
        (blob) => {
          if (!blob) {
            fail();
            return;
          }
          settle(() => {
            installThumbnail(key, blob);
            void saveToDisk(key, blob);
          });
        },
        'image/jpeg',
        0.78,
      );
    } catch {
      fail();
    }
  };

  timeout = window.setTimeout(() => fail(), 20_000);

  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.addEventListener('error', fail, { once: true });
  video.addEventListener(
    'loadedmetadata',
    () => {
      const duration = Number.isFinite(video.duration) ? video.duration : 0;
      targetTime =
        duration > 0 ? Math.min(Math.max(0.04, time), Math.max(0.04, duration - 0.04)) : 0;
      if (Math.abs(video.currentTime - targetTime) < 0.02) capture();
      else video.currentTime = targetTime;
    },
    { once: true },
  );
  // These events may arrive before the seek has decoded a frame. Keep
  // listening until the requested timestamp is actually drawable.
  video.addEventListener('seeked', capture);
  video.addEventListener('loadeddata', capture);
  video.addEventListener('canplay', capture);
  video.src = source;
  video.load();
};

function drainQueue(): void {
  while (runningKeys.size < MAX_CONCURRENT_CAPTURES && queue.length) {
    const job = queue.shift();
    if (!job) return;
    queuedKeys.delete(job.key);
    if (
      !pinCounts.has(job.key) ||
      thumbnailUrls.has(job.key) ||
      Date.now() < (retryAfter.get(job.key) ?? 0)
    )
      continue;
    captureThumbnail(job);
  }
}

const restoreOrCapture = async (job: ThumbnailJob): Promise<void> => {
  restoringKeys.add(job.key);
  try {
    const cache = await openDiskCache();
    const response = await cache?.match(cacheRequest(job.key));
    if (response && pinCounts.has(job.key)) {
      installThumbnail(job.key, await response.blob());
      return;
    }
  } catch {
    // Disk cache failure must not suppress capture from the real video source.
  } finally {
    restoringKeys.delete(job.key);
  }
  if (
    !pinCounts.has(job.key) ||
    thumbnailUrls.has(job.key) ||
    queuedKeys.has(job.key) ||
    runningKeys.has(job.key)
  )
    return;
  queuedKeys.add(job.key);
  queue.push(job);
  drainQueue();
};

export const requestEffectTemplateMixThumbnail = (
  source: string,
  time = 0.12,
  version = '',
): void => {
  if (!source) return;
  const key = thumbnailKey(source, time, version);
  if (
    thumbnailUrls.has(key) ||
    queuedKeys.has(key) ||
    runningKeys.has(key) ||
    restoringKeys.has(key)
  )
    return;
  if (Date.now() < (retryAfter.get(key) ?? 0)) {
    scheduleRetry();
    return;
  }
  retryAfter.delete(key);
  const job = { key, source, time, version };
  jobs.set(key, job);
  void restoreOrCapture(job);
};

export const retainEffectTemplateMixThumbnail = (
  source: string,
  time = 0.12,
  version = '',
): void => {
  if (!source) return;
  const key = thumbnailKey(source, time, version);
  pinCounts.set(key, (pinCounts.get(key) ?? 0) + 1);
  requestEffectTemplateMixThumbnail(source, time, version);
};

export const releaseEffectTemplateMixThumbnail = (
  source: string,
  time = 0.12,
  version = '',
): void => {
  if (!source) return;
  const key = thumbnailKey(source, time, version);
  const count = pinCounts.get(key) ?? 0;
  if (count <= 1) pinCounts.delete(key);
  else pinCounts.set(key, count - 1);
  trimCache();
};

export const useEffectTemplateMixThumbnail = (
  source: ComputedRef<string>,
  time: ComputedRef<number>,
  version: ComputedRef<string>,
): ComputedRef<string> =>
  computed(() => thumbnailUrls.get(thumbnailKey(source.value, time.value, version.value)) ?? '');
