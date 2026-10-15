import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Asset } from '@ai-marketing/contracts';
import { buildBrowserAssets } from './project-asset-browser';
import { extractSourceDocxText } from './asset-source-document-parser';
import {
  parseSourceDocx,
  readSourceDocumentAtPath,
  readSourceDocument,
  sourceDocumentContentPath,
  sourceDocumentMode,
  sourceDocumentModeFromFileName,
  SOURCE_DOCUMENT_PREVIEW_LIMIT,
} from './asset-source-document';
import sourceReader from './components/AssetSourceDocumentReader.vue?raw';
import reader from './components/AssetDocumentReader.vue?raw';
import browser from './components/ProjectAssetBrowser.vue?raw';
import thumbnail from './components/AssetMediaThumbnail.vue?raw';
import viteConfig from '../../../vite.config.ts?raw';

const asset = (name = '资料.docx') =>
  buildBrowserAssets(
    [],
    [
      {
        id: 'asset-one',
        projectId: 'p1',
        name,
        directory: 'SOURCE_MATERIALS',
        type: 'SOURCE_MATERIAL',
        tags: [],
        notes: null,
        originalFileName: name,
        mimeType: 'application/octet-stream',
        sizeBytes: 1024,
        previewKind: 'DOWNLOAD',
        hasFile: true,
        contentUrl: '/api/projects/p1/assets/asset-one/content',
        downloadUrl: '/download',
        storageWorkflow: 'EFFECT',
        workflowSpace: 'EFFECT',
        createdAt: '2026-10-07T00:00:00Z',
        updatedAt: '2026-10-07T00:00:00Z',
      } satisfies Asset,
    ],
    { projectId: 'p1', workflowRunId: 'r1', workflow: 'EFFECT', space: 'EFFECT' },
  )[0]!;

const zipHeader = (size: number) => {
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  return {
    bytes,
    writeUInt16LE: (value: number, offset = 0) => view.setUint16(offset, value, true),
    writeUInt32LE: (value: number, offset = 0) => view.setUint32(offset, value, true),
  };
};
const joinBytes = (parts: Uint8Array[]) => {
  const result = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
};

/** Tiny stored ZIP fixture with real DOCX XML, no external fixture generator or AI. */
function docx(body: string): ArrayBuffer {
  const entries = [
    [
      '[Content_Types].xml',
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    ],
    [
      '_rels/.rels',
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    ],
    [
      'word/document.xml',
      `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
    ],
  ];
  const local: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const [path, xml] of entries) {
    const name = new TextEncoder().encode(path!);
    const data = new TextEncoder().encode(xml!);
    let crc = 0xffffffff;
    for (const byte of data) {
      crc ^= byte;
      for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    const header = zipHeader(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(name.length, 26);
    local.push(header.bytes, name, data);
    const directory = zipHeader(46);
    directory.writeUInt32LE(0x02014b50);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt32LE(crc, 16);
    directory.writeUInt32LE(data.length, 20);
    directory.writeUInt32LE(data.length, 24);
    directory.writeUInt16LE(name.length, 28);
    directory.writeUInt32LE(offset, 42);
    central.push(directory.bytes, name);
    offset += header.bytes.length + name.length + data.length;
  }
  const directory = joinBytes(central);
  const end = zipHeader(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return joinBytes([...local, directory, end.bytes]).buffer;
}
const paragraph = (text: string) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('source document reading', () => {
  it('prebundles the lazy worker parser before a viewer can request its module', () => {
    expect(viteConfig).toContain("include: ['mammoth/mammoth.browser']");
  });
  it('extracts real DOCX paragraphs and table text completely, including the tail', async () => {
    const body =
      Array.from({ length: 60 }, (_, i) => paragraph(`资料段落${i + 1}`)).join('') +
      `<w:tbl><w:tr><w:tc>${paragraph('规格')}</w:tc><w:tc>${paragraph('220g')}</w:tc></w:tr></w:tbl>`;
    const text = await extractSourceDocxText(docx(body));
    expect(text).toContain('资料段落1');
    expect(text).toContain('资料段落60');
    expect(text).toContain('规格');
    expect(text).toContain('220g');
  });
  it('keeps untrusted markup as plain text and handles empty or corrupt documents', async () => {
    expect(
      await extractSourceDocxText(docx(paragraph('&lt;script&gt;alert(1)&lt;/script&gt;'))),
    ).toBe('<script>alert(1)</script>');
    expect(reader).not.toContain('v-html');
    expect(sourceReader).not.toContain('v-html');
    expect(await extractSourceDocxText(docx('<w:p/>'))).toBe('');
    await expect(extractSourceDocxText(new ArrayBuffer(4))).rejects.toThrow();
  });
  it('selects actual file formats without pretending unsupported DOC files are DOCX', () => {
    expect(sourceDocumentMode(asset())).toBe('DOCX');
    expect(sourceDocumentMode(asset('资料.pdf'))).toBe('PDF');
    for (const format of ['txt', 'md', 'csv', 'json'])
      expect(sourceDocumentMode(asset(`资料.${format}`))).toBe('TEXT');
    expect(sourceDocumentMode(asset('资料.doc'))).toBe('UNSUPPORTED');
    expect(sourceDocumentModeFromFileName('资料包.DOCX')).toBe('DOCX');
    expect(sourceDocumentModeFromFileName('资料包.pdf?download=1')).toBe('PDF');
    expect(sourceDocumentModeFromFileName('资料包.xlsx')).toBe('UNSUPPORTED');
  });
  it('reads a caller-supplied project-scoped document path through the shared bounded reader', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('完整资料正文'));
    vi.stubGlobal('fetch', fetch);
    expect(
      await (
        await readSourceDocumentAtPath(
          '/projects/p1/workflows/effect/source-import/drafts/SINGLE/products/product-1/materials/material-1/content',
          1024,
          'TEXT',
          new AbortController().signal,
        )
      ).text(),
    ).toBe('完整资料正文');
    expect(fetch.mock.calls[0]?.[0]).toBe(
      '/api/projects/p1/workflows/effect/source-import/drafts/SINGLE/products/product-1/materials/material-1/content',
    );
  });
  it('reads through scoped API IDs, not a supplied external URL, and returns exact original text', async () => {
    const item = asset('资料.txt');
    item.contentUrl = 'https://external.example/never-use';
    const fetch = vi.fn().mockResolvedValue(new Response('第一段\n最后一段'));
    vi.stubGlobal('fetch', fetch);
    expect(sourceDocumentContentPath(item)).toBe('/projects/p1/assets/asset-one/content');
    expect(await (await readSourceDocument(item, new AbortController().signal)).text()).toBe(
      '第一段\n最后一段',
    );
    expect(fetch.mock.calls[0]?.[0]).toBe('/api/projects/p1/assets/asset-one/content');
  });
  it('does not fetch unavailable or oversized files and bounds the response stream', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(
      readSourceDocument({ ...asset(), unavailable: true }, new AbortController().signal),
    ).rejects.toThrow('暂不可用');
    await expect(
      readSourceDocument(
        { ...asset(), sizeBytes: SOURCE_DOCUMENT_PREVIEW_LIMIT + 1 },
        new AbortController().signal,
      ),
    ).rejects.toThrow('20 MB');
    expect(fetch).not.toHaveBeenCalled();
    const cancel = vi.fn();
    fetch.mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(SOURCE_DOCUMENT_PREVIEW_LIMIT + 1));
          },
          cancel,
        }),
      ),
    );
    await expect(readSourceDocument(asset(), new AbortController().signal)).rejects.toThrow(
      '20 MB',
    );
    expect(cancel).toHaveBeenCalledOnce();
  });
  it('rejects missing content and oversized HTTP length, marks PDF blobs correctly, and preserves API errors', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null));
    vi.stubGlobal('fetch', fetch);
    await expect(readSourceDocument(asset(), new AbortController().signal)).rejects.toThrow('为空');
    fetch.mockResolvedValue(
      new Response('', {
        headers: { 'content-length': String(SOURCE_DOCUMENT_PREVIEW_LIMIT + 1) },
      }),
    );
    await expect(readSourceDocument(asset(), new AbortController().signal)).rejects.toThrow(
      '20 MB',
    );
    fetch.mockResolvedValue(new Response('%PDF-1.7'));
    expect((await readSourceDocument(asset('资料.pdf'), new AbortController().signal)).type).toBe(
      'application/pdf',
    );
    fetch.mockResolvedValue(new Response('{}', { status: 403 }));
    await expect(readSourceDocument(asset(), new AbortController().signal)).rejects.toMatchObject({
      status: 403,
    });
  });
  it('terminates each parse worker on success, failure, timeout and cancellation', async () => {
    vi.useFakeTimers();
    const mock = () => ({
      onmessage: null as null | ((event: MessageEvent) => void),
      onerror: null as null | (() => void),
      postMessage: vi.fn(),
      terminate: vi.fn(),
    });
    for (const scenario of ['success', 'failure', 'timeout', 'abort']) {
      const worker = mock();
      const controller = new AbortController();
      const result = parseSourceDocx(
        new ArrayBuffer(4),
        controller.signal,
        () => worker as unknown as Worker,
      );
      const assertion =
        scenario === 'success'
          ? expect(result).resolves.toBe('完整正文')
          : expect(result).rejects.toThrow();
      if (scenario === 'success')
        worker.onmessage?.({ data: { text: '完整正文' } } as MessageEvent);
      if (scenario === 'failure') worker.onerror?.();
      if (scenario === 'timeout') await vi.advanceTimersByTimeAsync(15_000);
      if (scenario === 'abort') controller.abort();
      await assertion;
      expect(worker.terminate).toHaveBeenCalledOnce();
    }
  });
  it('renders documents in the main grouped view, uses intrinsic image dimensions and cleans up on exit', () => {
    expect(browser).toContain('<AssetSourceDocumentReader');
    expect(browser).toContain('source-images');
    expect(thumbnail).toContain('.intrinsic-image img');
    expect(thumbnail).toContain('height: auto');
    expect(sourceReader).toContain('request?.abort()');
    expect(sourceReader).toContain('releasePdf()');
    expect(sourceReader).toContain('stamp === generation');
  });
});
