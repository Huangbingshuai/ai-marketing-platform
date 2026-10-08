import { open } from 'node:fs/promises';
import { HttpStatus } from '@nestjs/common';
import { ApiHttpException } from '../../common/api-http-exception';
import type { ApiErrorCode } from '@ai-marketing/contracts';

export type ImportFileKind = 'DOCUMENT' | 'IMAGE';
const formats: Record<
  string,
  {
    kind: ImportFileKind;
    mime: string;
    signature: 'JPEG' | 'PNG' | 'WEBP' | 'PSD' | 'PDF' | 'ZIP' | 'OLE' | 'TEXT';
  }
> = {
  jpg: { kind: 'IMAGE', mime: 'image/jpeg', signature: 'JPEG' },
  jpeg: { kind: 'IMAGE', mime: 'image/jpeg', signature: 'JPEG' },
  png: { kind: 'IMAGE', mime: 'image/png', signature: 'PNG' },
  webp: { kind: 'IMAGE', mime: 'image/webp', signature: 'WEBP' },
  psd: { kind: 'IMAGE', mime: 'image/vnd.adobe.photoshop', signature: 'PSD' },
  pdf: { kind: 'DOCUMENT', mime: 'application/pdf', signature: 'PDF' },
  doc: { kind: 'DOCUMENT', mime: 'application/msword', signature: 'OLE' },
  xls: { kind: 'DOCUMENT', mime: 'application/vnd.ms-excel', signature: 'OLE' },
  docx: {
    kind: 'DOCUMENT',
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    signature: 'ZIP',
  },
  xlsx: {
    kind: 'DOCUMENT',
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    signature: 'ZIP',
  },
  txt: { kind: 'DOCUMENT', mime: 'text/plain', signature: 'TEXT' },
  md: { kind: 'DOCUMENT', mime: 'text/markdown', signature: 'TEXT' },
};
export const importFileFormat = (name: string) =>
  formats[name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? ''];
const invalid = (message: string, code: ApiErrorCode = 'FILE_TYPE_UNSUPPORTED'): never => {
  throw new ApiHttpException(message, HttpStatus.BAD_REQUEST, code);
};

/** Shared import boundary; extensions, supplied MIME and file headers must agree. */
export async function validateImportFile<
  T extends { path: string; originalname: string; mimetype: string; size: number },
>(file: T | undefined, kind: ImportFileKind, maxBytes: number): Promise<T> {
  if (!file || file.size < 1) return invalid('请选择非空文件', 'FILE_REQUIRED');
  if (file.size > maxBytes) return invalid('文件大小超过该资料类型限制', 'FILE_TOO_LARGE');
  const format = importFileFormat(file.originalname);
  if (!format || format.kind !== kind) return invalid('文件扩展名与资料类型不匹配');
  const mime = file.mimetype.toLowerCase().split(';')[0]!.trim();
  if (
    mime !== format.mime &&
    mime !== 'application/octet-stream' &&
    !(format.signature === 'TEXT' && mime === 'text/plain')
  )
    return invalid('文件 MIME 与扩展名不匹配');
  const handle = await open(file.path, 'r');
  const buffer = Buffer.alloc(4096);
  let length: number;
  try {
    if ((await handle.stat()).size !== file.size)
      return invalid('文件内容不完整', 'VALIDATION_ERROR');
    length = (await handle.read(buffer, 0, buffer.length, 0)).bytesRead;
  } finally {
    await handle.close();
  }
  const header = buffer.subarray(0, length);
  const signature = {
    JPEG: header.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])),
    PNG: header
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    WEBP:
      header.subarray(0, 4).toString('ascii') === 'RIFF' &&
      header.subarray(8, 12).toString('ascii') === 'WEBP',
    PSD: header.subarray(0, 4).toString('ascii') === '8BPS',
    PDF: header.subarray(0, 5).toString('ascii') === '%PDF-',
    ZIP: header.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])),
    OLE: header
      .subarray(0, 8)
      .equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])),
    TEXT: !header.includes(0),
  }[format.signature];
  if (!signature) return invalid('文件签名与扩展名不匹配');
  return { ...file, mimetype: format.mime };
}
