/** Parsed read-only text only, in this browser document's memory. No persistent storage. */
export class ImportDocumentCache {
  private readonly entries = new Map<string, { text: string; expires: number }>();
  constructor(
    private readonly maxBytes = 2 * 1024 * 1024,
    private readonly ttlMs = 5 * 60_000,
  ) {}

  async read(
    path: string,
    version: string | undefined,
    mode: string,
    signal: AbortSignal,
    load: () => Promise<string>,
  ): Promise<string> {
    signal.throwIfAborted();
    for (const [key, entry] of this.entries) {
      if (entry.expires <= Date.now()) this.entries.delete(key);
    }
    const key = path && version ? JSON.stringify([path, version, mode]) : null;
    const cached = key ? this.entries.get(key) : undefined;
    if (cached) {
      this.entries.delete(key!);
      this.entries.set(key!, cached);
      return cached.text;
    }
    const text = await load();
    signal.throwIfAborted();
    if (text.length > 1_000_000) throw new Error('文档正文过大，请打开原文件查看完整内容。');
    if (key && text.length * 2 <= this.maxBytes) {
      this.entries.set(key, { text, expires: Date.now() + this.ttlMs });
      let bytes = [...this.entries.values()].reduce((sum, entry) => sum + entry.text.length * 2, 0);
      while (this.entries.size > 8 || bytes > this.maxBytes) {
        const oldest = this.entries.keys().next().value!;
        bytes -= this.entries.get(oldest)!.text.length * 2;
        this.entries.delete(oldest);
      }
    }
    return text;
  }
}
export const importDocumentCache = new ImportDocumentCache();
