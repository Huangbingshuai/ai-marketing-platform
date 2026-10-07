import { extractSourceDocxText } from './asset-source-document-parser';
import type { SourceDocumentWorkerResult } from './asset-source-document';

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<ArrayBuffer>) => void) | null;
  postMessage(message: SourceDocumentWorkerResult): void;
};
scope.onmessage = async (event) => {
  try {
    scope.postMessage({ text: await extractSourceDocxText(event.data) });
  } catch {
    scope.postMessage({ error: '无法读取此 DOCX 的正文，请检查文件是否完整或下载原文件查看。' });
  }
};
