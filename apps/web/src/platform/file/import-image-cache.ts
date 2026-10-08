/** Volatile, bounded reuse of already authorized and loaded images in this document only. */
export class ImportImageCache {
  private readonly entries = new Map<
    string,
    { image: HTMLImageElement; bytes: number; expires: number }
  >();

  constructor(
    private readonly maxEntries = 24,
    private readonly maxBytes = 32 * 1024 * 1024,
    private readonly ttlMs = 5 * 60_000,
  ) {}

  private key(url: string, version?: string): string | null {
    return url && version ? JSON.stringify([url, version]) : null;
  }

  private prune(): void {
    for (const [key, entry] of this.entries) {
      if (entry.expires <= Date.now()) this.entries.delete(key);
    }
  }

  get(url: string, version?: string): HTMLImageElement | null {
    this.prune();
    const key = this.key(url, version);
    const entry = key ? this.entries.get(key) : undefined;
    if (!entry || !entry.image.complete || entry.image.naturalWidth === 0) return null;
    this.entries.delete(key!);
    this.entries.set(key!, entry);
    return entry.image;
  }

  put(url: string, version: string | undefined, image: HTMLImageElement): void {
    this.prune();
    const key = this.key(url, version);
    const bytes = image.naturalWidth * image.naturalHeight * 4;
    if (!key || !image.complete || bytes <= 0 || bytes > this.maxBytes) return;
    // Repeated viewers do not extend the authorization reuse window indefinitely.
    if (this.entries.get(key)?.image === image) return;
    this.entries.delete(key);
    this.entries.set(key, { image, bytes, expires: Date.now() + this.ttlMs });
    let used = [...this.entries.values()].reduce((sum, entry) => sum + entry.bytes, 0);
    while (this.entries.size > this.maxEntries || used > this.maxBytes) {
      const oldest = this.entries.keys().next().value!;
      used -= this.entries.get(oldest)!.bytes;
      this.entries.delete(oldest);
    }
  }

  clear(): void {
    this.entries.clear();
  }
}

export const importImageCache = new ImportImageCache();

export function drawImportImage(
  canvas: HTMLCanvasElement,
  image: HTMLImageElement,
  maxSide = 2400,
): boolean {
  if (!image.complete || !image.naturalWidth || !image.naturalHeight) return false;
  const context = canvas.getContext('2d');
  if (!context) return false;
  const scale = Math.min(1, maxSide / Math.max(image.naturalWidth, image.naturalHeight));
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return true;
}
