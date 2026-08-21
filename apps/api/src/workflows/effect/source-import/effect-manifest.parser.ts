import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';

import {
  EFFECT_IMPORT_LIMITS,
  EFFECT_MANIFEST_COLUMNS,
  type EffectImportMaterialType,
  type EffectImportValidationIssue,
  type EffectManifestColumn,
  type EffectManifestFormat,
  type EffectManifestPreviewRow,
} from '@ai-marketing/contracts';
import ExcelJS from 'exceljs';

const MATERIAL_COLUMNS: ReadonlyArray<[EffectManifestColumn, EffectImportMaterialType]> = [
  ['商品图片', 'PRODUCT_IMAGE'],
  ['产品文档', 'PRODUCT_DOCUMENT'],
  ['品牌规范', 'BRAND_GUIDELINE'],
  ['参考视频', 'REFERENCE_VIDEO'],
];

const issue = (
  code: EffectImportValidationIssue['code'],
  message: string,
  rowNumber: number | null,
  field: string | null = null,
): EffectImportValidationIssue => ({
  code,
  severity: 'ERROR',
  scope: rowNumber === null ? 'MANIFEST_FILE' : 'MANIFEST_ROW',
  message,
  field,
  productId: null,
  materialId: null,
  manifestRowNumber: rowNumber,
  fileName: null,
});

const parseCsv = (source: string): string[][] => {
  const rows: string[][] = [];
  let row: string[] = [];
  let value = '';
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index] ?? '';
    if (quoted) {
      if (character === '"' && source[index + 1] === '"') {
        value += '"';
        index += 1;
      } else if (character === '"') quoted = false;
      else value += character;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === ',') {
      row.push(value);
      value = '';
    } else if (character === '\n') {
      row.push(value.replace(/\r$/, ''));
      rows.push(row);
      row = [];
      value = '';
    } else value += character;
  }
  if (quoted) throw new Error('CSV_UNCLOSED_QUOTE');
  if (value !== '' || row.length > 0) {
    row.push(value.replace(/\r$/, ''));
    rows.push(row);
  }
  return rows;
};

const excelCellText = (cell: ExcelJS.Cell): { text: string; formula: boolean } => {
  const value = cell.value;
  if (value && typeof value === 'object' && ('formula' in value || 'sharedFormula' in value))
    return { text: '', formula: true };
  if (value === null || value === undefined) return { text: '', formula: false };
  if (typeof value === 'object' && 'text' in value) {
    return { text: String(value.text ?? ''), formula: false };
  }
  return { text: String(value), formula: false };
};

const parseXlsx = async (
  path: string,
): Promise<{ cells: string[][]; formulaCells: Set<string> }> => {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(path);
  const worksheet = workbook.worksheets.find((candidate) => {
    let populated = false;
    candidate.eachRow((row) => {
      if (
        Array.isArray(row.values) &&
        row.values.some((value) => value !== null && value !== undefined && value !== '')
      ) {
        populated = true;
      }
    });
    return populated;
  });
  if (!worksheet) return { cells: [], formulaCells: new Set() };
  const cells: string[][] = [];
  const formulaCells = new Set<string>();
  worksheet.eachRow({ includeEmpty: true }, (row, rowNumber) => {
    const values: string[] = [];
    for (let columnNumber = 1; columnNumber <= worksheet.columnCount; columnNumber += 1) {
      const result = excelCellText(row.getCell(columnNumber));
      values.push(result.text);
      if (result.formula) formulaCells.add(`${rowNumber}:${columnNumber}`);
    }
    cells.push(values);
  });
  return { cells, formulaCells };
};

const splitFileNames = (value: string): string[] =>
  value
    .split(/[|\r\n]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);

export const normalizeManifestFileName = (value: string): string =>
  value.split(/[\\/]/).at(-1)!.trim().normalize('NFKC').toLocaleLowerCase('en-US');

export type ParsedEffectManifest = {
  format: EffectManifestFormat;
  rows: EffectManifestPreviewRow[];
  issues: EffectImportValidationIssue[];
};

export async function parseEffectManifest(
  path: string,
  originalFileName: string,
): Promise<ParsedEffectManifest> {
  const extension = extname(originalFileName).toLocaleLowerCase('en-US');
  const format: EffectManifestFormat = extension === '.csv' ? 'csv' : 'xlsx';
  if (extension !== '.csv' && extension !== '.xlsx') {
    return {
      format,
      rows: [],
      issues: [issue('MANIFEST_FORMAT_UNSUPPORTED', '仅支持 CSV 或 XLSX 清单', null)],
    };
  }

  let cells: string[][];
  let formulaCells = new Set<string>();
  try {
    if (format === 'csv') {
      const source = (await readFile(path, 'utf8')).replace(/^\uFEFF/, '');
      cells = parseCsv(source);
    } else ({ cells, formulaCells } = await parseXlsx(path));
  } catch {
    return {
      format,
      rows: [],
      issues: [issue('MANIFEST_FORMAT_UNSUPPORTED', '清单文件损坏或无法解析', null)],
    };
  }

  const headerRowIndex = cells.findIndex((row) => row.some((value) => value.trim() !== ''));
  const header = headerRowIndex < 0 ? [] : (cells[headerRowIndex] ?? []);
  const headerIndexes = new Map<string, number>();
  header.forEach((value, index) => headerIndexes.set(value.trim(), index));
  const issues: EffectImportValidationIssue[] = [];
  for (const column of EFFECT_MANIFEST_COLUMNS) {
    if (!headerIndexes.has(column)) {
      issues.push(issue('MANIFEST_HEADER_MISSING', `缺少清单列：${column}`, null, column));
    }
  }

  const nonEmpty = cells
    .map((row, index) => ({ row, rowNumber: index + 1 }))
    .slice(headerRowIndex + 1)
    .filter(({ row }) => row.some((value) => value.trim() !== ''));
  if (nonEmpty.length > EFFECT_IMPORT_LIMITS.maxManifestRows) {
    issues.push(
      issue(
        'MANIFEST_ROW_LIMIT_EXCEEDED',
        `清单最多允许 ${EFFECT_IMPORT_LIMITS.maxManifestRows} 行产品`,
        null,
      ),
    );
  }
  const productRows = nonEmpty.slice(0, EFFECT_IMPORT_LIMITS.maxManifestRows);
  const rows = productRows.map(({ row, rowNumber }): EffectManifestPreviewRow => {
    const get = (column: EffectManifestColumn): string =>
      (row[headerIndexes.get(column) ?? -1] ?? '').trim();
    const rawName = get('产品名称');
    const rawCategory = get('品类');
    const rawCommerceUrl = get('电商链接');
    const name = rawName.slice(0, 120);
    const category = rawCategory.slice(0, 120);
    const commerceUrl = rawCommerceUrl.slice(0, 2000) || null;
    const rowIssues: EffectImportValidationIssue[] = [];
    for (const [field, value] of [
      ['name', name],
      ['category', category],
    ] as const) {
      if (!value) rowIssues.push(issue('REQUIRED_FIELD', `${field} 为必填字段`, rowNumber, field));
    }
    for (const [field, value, limit] of [
      ['name', rawName, 120],
      ['category', rawCategory, 120],
      ['commerceUrl', rawCommerceUrl, 2000],
    ] as const) {
      if (value.length > limit) {
        rowIssues.push(
          issue('FIELD_TOO_LONG', `${field} 超过 ${limit} 个字符，已安全截断`, rowNumber, field),
        );
      }
    }
    for (const [column, columnIndex] of header.map(
      (value, columnIndex) => [value, columnIndex] as const,
    )) {
      if (formulaCells.has(`${rowNumber}:${columnIndex + 1}`)) {
        rowIssues.push(
          issue('MANIFEST_FORMULA_UNSUPPORTED', `不支持公式单元格：${column}`, rowNumber, column),
        );
      }
    }
    const materialReferences = MATERIAL_COLUMNS.flatMap(([column, type]) =>
      splitFileNames(get(column)).map((rawExpectedFileName) => {
        if (rawExpectedFileName.length > 255) {
          rowIssues.push(
            issue(
              'FIELD_TOO_LONG',
              `${column}文件名超过 255 个字符，已安全截断`,
              rowNumber,
              column,
            ),
          );
        }
        return {
          type,
          expectedFileName: rawExpectedFileName.slice(0, 255),
          matchStatus: 'MISSING' as const,
          stagedFileIds: [],
        };
      }),
    );
    return {
      rowNumber,
      name,
      category,
      sku: '',
      normalizedSku: '',
      commerceUrl,
      materialReferences,
      issues: rowIssues,
      valid: rowIssues.length === 0,
    };
  });

  return { format, rows, issues };
}
