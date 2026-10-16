import { describe, expect, it } from 'vitest';
import { normalizeMultipartFileName, safeOriginalFileName } from './file-name';

describe('file name encoding boundaries', () => {
  it('preserves an already decoded generated Chinese image name', () => {
    const name = '弧电G65氮化镓充电器.png';
    expect(normalizeMultipartFileName(name)).toBe(name);
    expect(safeOriginalFileName(name)).toBe(name);
  });
  it('still decodes actual multipart Latin-1 bytes', () => {
    const name = '弧电-品牌标识.png';
    expect(safeOriginalFileName(Buffer.from(name, 'utf8').toString('latin1'))).toBe(name);
  });
  it('keeps Unicode names while removing path segments and control characters', () => {
    expect(safeOriginalFileName('C:\\fakepath\\充电器\u0000.png')).toBe('充电器.png');
    expect(safeOriginalFileName('角色🧡.png')).toBe('角色🧡.png');
  });
});
