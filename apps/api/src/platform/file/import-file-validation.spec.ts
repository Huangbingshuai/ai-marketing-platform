import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { validateImportFile } from './import-file-validation';

describe('shared import file validation', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'import-validation-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const file = async (name: string, bytes: Buffer | string, mime: string) => {
    const path = join(root, name);
    await writeFile(path, bytes);
    return { path, originalname: name, size: Buffer.byteLength(bytes), mimetype: mime };
  };
  it.each([
    [
      'brief.docx',
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'DOCUMENT',
    ],
    ['brief.pdf', '%PDF-1.7', 'application/pdf', 'DOCUMENT'],
    ['brief.txt', '产品与视频制作目标', 'text/plain', 'DOCUMENT'],
    [
      'scene.png',
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      'image/png',
      'IMAGE',
    ],
    ['style.psd', '8BPS0000', 'image/vnd.adobe.photoshop', 'IMAGE'],
  ] as const)('normalizes MIME for supported %s', async (name, bytes, mime, kind) => {
    expect(
      (await validateImportFile(await file(name, bytes, 'application/octet-stream'), kind, 100))
        .mimetype,
    ).toBe(mime);
  });
  it('rejects cross-area, disguised extensions, MIME mismatches, empty and oversized files', async () => {
    await expect(
      validateImportFile(
        await file('fake.docx', '%PDF-1.7', 'application/octet-stream'),
        'DOCUMENT',
        100,
      ),
    ).rejects.toThrow('签名');
    await expect(
      validateImportFile(
        await file('fake.txt', Buffer.from([0, 1, 2]), 'text/plain'),
        'DOCUMENT',
        100,
      ),
    ).rejects.toThrow('签名');
    const pdf = await file('brief.pdf', '%PDF-1.7', 'application/pdf');
    await expect(validateImportFile(pdf, 'IMAGE', 100)).rejects.toThrow('资料类型');
    await expect(
      validateImportFile({ ...pdf, mimetype: 'image/png' }, 'DOCUMENT', 100),
    ).rejects.toThrow('MIME');
    await expect(validateImportFile(pdf, 'DOCUMENT', 1)).rejects.toThrow('大小');
    await expect(validateImportFile({ ...pdf, size: 20 }, 'DOCUMENT', 100)).rejects.toMatchObject({
      response: { message: '文件内容不完整', code: 'VALIDATION_ERROR' },
      status: 400,
    });
    await expect(validateImportFile(undefined, 'DOCUMENT', 100)).rejects.toThrow('非空');
  });
});
