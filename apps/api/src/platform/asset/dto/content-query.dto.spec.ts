import { validateSync } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { ContentQueryDto } from './content-query.dto';

describe('read-only content query', () => {
  const validate = (value: Record<string, unknown>) =>
    validateSync(Object.assign(new ContentQueryDto(), value), {
      whitelist: true,
      forbidNonWhitelisted: true,
    });
  it('accepts bounded image preview markers alongside the existing download flag', () => {
    expect(
      validate({
        preview: '2026-10-08T08:00:00.000Z',
        view: '/projects/p/assets/a/versions/1/content:timestamp',
        download: 'false',
      }),
    ).toEqual([]);
    expect(validate({ download: 'true' })).toEqual([]);
  });
  it('rejects unknown, oversized and non-string query fields', () => {
    expect(validate({ unexpected: 'value' })).not.toEqual([]);
    expect(validate({ view: 'x'.repeat(2049) })).not.toEqual([]);
    expect(validate({ preview: 1 })).not.toEqual([]);
  });
});
