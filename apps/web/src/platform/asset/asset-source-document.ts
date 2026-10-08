import { requestRaw } from '../../api/http-client';
import { assetFileFormat, type BrowserAsset } from './project-asset-browser';

export const SOURCE_DOCUMENT_PREVIEW_LIMIT = 20 * 1024 * 1024;
export type SourceDocumentWorkerResult = { text: string } | { error: string };
export type SourceDocumentMode = 'TEXT' | 'DOCX' | 'PDF' | 'UNSUPPORTED';

export function sourceDocumentModeFromFormat(format: string): SourceDocumentMode {
  const normalized = format.trim().toUpperCase();
  if (['TXT', 'MD', 'CSV', 'JSON'].includes(normalized)) return 'TEXT';
  if (normalized === 'DOCX' || normalized === 'PDF') return normalized;
  return 'UNSUPPORTED';
}

export function sourceDocumentModeFromFileName(fileName: string): SourceDocumentMode {
  const withoutQuery = fileName.split(/[?#]/, 1)[0] ?? '';
  const dot = withoutQuery.lastIndexOf('.');
  return sourceDocumentModeFromFormat(dot >= 0 ? withoutQuery.slice(dot + 1) : '');
}

export function sourceDocumentMode(item: BrowserAsset): SourceDocumentMode {
  const format = assetFileFormat(item);
  return sourceDocumentModeFromFormat(format);
}

export async function readSourceDocumentAtPath(
  contentPath: string,
  sizeBytes: number | null,
  mode: SourceDocumentMode,
  signal: AbortSignal,
): Promise<Blob> {
  if ((sizeBytes ?? 0) > SOURCE_DOCUMENT_PREVIEW_LIMIT)
    throw new Error('文档超过 20 MB 在线查看上限，请打开原文件查看。');
  const response = await requestRaw(contentPath, {
    signal,
    operation: '读取文档',
  });
  if (Number(response.headers.get('content-length')) > SOURCE_DOCUMENT_PREVIEW_LIMIT) {
    await response.body?.cancel();
    throw new Error('文档超过 20 MB 在线查看上限，请打开原文件查看。');
  }
  if (!response.body) throw new Error('文档内容为空，请检查原文件。');
  const reader = response.body.getReader();
  const chunks: ArrayBuffer[] = [];
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > SOURCE_DOCUMENT_PREVIEW_LIMIT) {
        await reader.cancel();
        throw new Error('文档超过 20 MB 在线查看上限，请打开原文件查看。');
      }
      chunks.push(Uint8Array.from(chunk.value).buffer);
    }
  } finally {
    reader.releaseLock();
  }
  return new Blob(chunks, {
    type: mode === 'PDF' ? 'application/pdf' : 'application/octet-stream',
  });
}

export function sourceDocumentContentPath(item: BrowserAsset): string {
  const source = item.source;
  const projectId = source.kind === 'working' ? source.artifact.projectId : source.asset.projectId;
  const base = `/projects/${encodeURIComponent(projectId)}`;
  if (source.kind === 'project')
    return `${base}/assets/${encodeURIComponent(source.asset.id)}/content`;
  if (source.file)
    return `${base}/file-objects/${encodeURIComponent(source.file.fileObjectId)}/content`;
  return `${base}/working-artifacts/${encodeURIComponent(source.artifact.id)}/content`;
}

export async function readSourceDocument(item: BrowserAsset, signal: AbortSignal): Promise<Blob> {
  if (item.unavailable || !item.contentUrl) throw new Error('此版本的原文件暂不可用。');
  return readSourceDocumentAtPath(
    sourceDocumentContentPath(item),
    item.sizeBytes,
    sourceDocumentMode(item),
    signal,
  );
}

/** Each document owns a bounded worker; abort, timeout and completion all terminate it. */
export function parseSourceDocx(
  buffer: ArrayBuffer,
  signal: AbortSignal,
  createWorker = () =>
    new Worker(new URL('./asset-source-document.worker.ts', import.meta.url), { type: 'module' }),
): Promise<string> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = createWorker();
    let settled = false;
    const finish = (text: string | null, error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal.removeEventListener('abort', abort);
      worker.terminate();
      if (error) reject(error);
      else resolve(text ?? '');
    };
    const abort = () => finish(null, new DOMException('读取已取消', 'AbortError'));
    const timeout = setTimeout(
      () => finish(null, new Error('文档解析超时，请重试或下载原文件查看。')),
      15_000,
    );
    signal.addEventListener('abort', abort, { once: true });
    worker.onmessage = (event: MessageEvent<SourceDocumentWorkerResult>) => {
      const result = event.data;
      if ('error' in result) finish(null, new Error(result.error));
      else finish(result.text);
    };
    worker.onerror = () => finish(null, new Error('文档解析失败，请重试或下载原文件查看。'));
    try {
      worker.postMessage(buffer, [buffer]);
    } catch {
      finish(null, new Error('文档解析未能启动，请重试。'));
    }
  });
}
