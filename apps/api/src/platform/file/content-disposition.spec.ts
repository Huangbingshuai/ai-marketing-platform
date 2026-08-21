import { describe, expect, it } from 'vitest';

import { fileContentDisposition } from './content-disposition';

describe('fileContentDisposition', () => {
  it('keeps an ASCII extension fallback while preserving the UTF-8 Word file name', () => {
    expect(fileContentDisposition('attachment', '广式腊肠资料包.docx')).toBe(
      'attachment; filename="download.docx"; filename*=UTF-8\'\'%E5%B9%BF%E5%BC%8F%E8%85%8A%E8%82%A0%E8%B5%84%E6%96%99%E5%8C%85.docx',
    );
  });

  it('removes path and control characters from response file names', () => {
    expect(fileContentDisposition('inline', '../folder/report\r\n.docx')).toContain(
      'filename="download.docx"',
    );
    expect(fileContentDisposition('inline', '../folder/report\r\n.docx')).not.toContain('\r\n');
  });
});
