import { Writable, Readable } from 'node:stream';
import type { ServerResponse } from 'node:http';

import { describe, expect, it, vi } from 'vitest';

import { AssetController } from './asset.controller';
import type { AssetService } from './asset.service';

class RecordingResponse extends Writable {
  statusCode = 0;
  readonly headers = new Map<string, string>();
  readonly chunks: Buffer[] = [];

  setHeader(name: string, value: number | readonly string[]): this;
  setHeader(name: string, value: string): this;
  setHeader(name: string, value: number | string | readonly string[]): this {
    this.headers.set(name.toLowerCase(), Array.isArray(value) ? value.join(', ') : String(value));
    return this;
  }

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.chunks.push(Buffer.from(chunk));
    callback();
  }
}

describe('AssetController content response', () => {
  it('streams a 206 media response with safe headers and no JSON envelope', async () => {
    const content = vi.fn().mockResolvedValue({
      stream: Readable.from('bc'),
      sizeBytes: 4,
      start: 1,
      end: 2,
      contentLength: 2,
      mimeType: 'video/mp4',
      originalFileName: '成片.mp4',
      previewKind: 'VIDEO',
      partial: true,
    });
    const controller = new AssetController({ content } as unknown as AssetService);
    const response = new RecordingResponse();

    await controller.content(
      'ea77ed70-8a2c-4548-91cb-28987657aa1b',
      'bb157bde-c253-4d02-91c2-e2f550d29df1',
      'bytes=1-2',
      {},
      response as unknown as ServerResponse,
    );

    expect(response.statusCode).toBe(206);
    expect(response.headers.get('content-type')).toBe('video/mp4');
    expect(response.headers.get('content-range')).toBe('bytes 1-2/4');
    expect(response.headers.get('content-disposition')).toContain('inline');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(Buffer.concat(response.chunks).toString()).toBe('bc');
  });

  it('forces non-whitelisted content to attachment and octet-stream', async () => {
    const content = vi.fn().mockResolvedValue({
      stream: Readable.from('<html>'),
      sizeBytes: 6,
      start: 0,
      end: 5,
      contentLength: 6,
      mimeType: 'text/html',
      originalFileName: 'page.html',
      previewKind: 'DOWNLOAD',
      partial: false,
    });
    const controller = new AssetController({ content } as unknown as AssetService);
    const response = new RecordingResponse();

    await controller.content(
      'ea77ed70-8a2c-4548-91cb-28987657aa1b',
      'bb157bde-c253-4d02-91c2-e2f550d29df1',
      undefined,
      {},
      response as unknown as ServerResponse,
    );

    expect(response.headers.get('content-type')).toBe('application/octet-stream');
    expect(response.headers.get('content-disposition')).toContain('attachment');
    expect(response.headers.get('accept-ranges')).toBe('none');
  });

  it('keeps the Word MIME type and .docx fallback name for attachment downloads', async () => {
    const content = vi.fn().mockResolvedValue({
      stream: Readable.from(Buffer.from('PK')),
      sizeBytes: 2,
      start: 0,
      end: 1,
      contentLength: 2,
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      originalFileName: '广式腊肠资料包.docx',
      previewKind: 'DOWNLOAD',
      partial: false,
    });
    const controller = new AssetController({ content } as unknown as AssetService);
    const response = new RecordingResponse();

    await controller.content(
      'ea77ed70-8a2c-4548-91cb-28987657aa1b',
      'bb157bde-c253-4d02-91c2-e2f550d29df1',
      undefined,
      { download: 'true' },
      response as unknown as ServerResponse,
    );

    expect(response.headers.get('content-type')).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    expect(response.headers.get('content-disposition')).toContain('filename="download.docx"');
    expect(response.headers.get('content-disposition')).toContain("filename*=UTF-8''");
    expect(Buffer.concat(response.chunks)).toEqual(Buffer.from('PK'));
  });
});
