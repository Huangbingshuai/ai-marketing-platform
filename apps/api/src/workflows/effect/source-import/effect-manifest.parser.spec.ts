import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import ExcelJS from 'exceljs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { normalizeManifestFileName, parseEffectManifest } from './effect-manifest.parser';

describe('effect manifest parser', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'effect-manifest-'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('parses a BOM CSV without requiring product identity columns', async () => {
    const path = join(directory, 'products.csv');
    await writeFile(
      path,
      '\uFEFF电商链接,商品图片,产品文档\r\n' +
        'https://example.com,a.jpg|b.jpg,\r\n' +
        ',,manual.pdf\r\n',
      'utf8',
    );

    const result = await parseEffectManifest(path, 'products.csv');

    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toMatchObject({
      name: '',
      category: '',
      normalizedSku: '',
      materialReferences: [
        { type: 'PRODUCT_IMAGE', expectedFileName: 'a.jpg' },
        { type: 'PRODUCT_IMAGE', expectedFileName: 'b.jpg' },
      ],
    });
    expect(result.rows.every((row) => row.issues.length === 0)).toBe(true);
  });

  it('rejects formula cells without evaluating them', async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('清单');
    sheet.addRow(['电商链接', '商品图片', '产品文档']);
    sheet.addRow([{ formula: 'CONCAT("危","险")', result: '危险' }, 'front.jpg', '']);
    const path = join(directory, 'products.xlsx');
    await workbook.xlsx.writeFile(path);

    const result = await parseEffectManifest(path, 'products.xlsx');

    expect(result.rows[0]?.name).toBe('');
    expect(result.rows[0]?.issues.map((issue) => issue.code)).toContain(
      'MANIFEST_FORMULA_UNSUPPORTED',
    );
  });

  it('normalizes safe basenames with Unicode NFKC and case folding', () => {
    expect(normalizeManifestFileName('C:\\tmp\\ＦＲＯＮＴ.JPG')).toBe('front.jpg');
  });

  it('reports oversized cells and truncates persisted preview fields safely', async () => {
    const path = join(directory, 'oversized.csv');
    await writeFile(
      path,
      '电商链接,商品图片,产品文档\n' + `${'h'.repeat(2001)},${'a'.repeat(256)}.jpg,\n`,
      'utf8',
    );

    const result = await parseEffectManifest(path, 'oversized.csv');

    expect(result.rows[0]?.name).toBe('');
    expect(result.rows[0]?.category).toBe('');
    expect(result.rows[0]?.commerceUrl).toHaveLength(2000);
    expect(result.rows[0]?.sku).toBe('');
    expect(result.rows[0]?.materialReferences[0]?.expectedFileName).toHaveLength(255);
    expect(result.rows[0]?.issues.map((item) => item.code)).toContain('FIELD_TOO_LONG');
  });
});
