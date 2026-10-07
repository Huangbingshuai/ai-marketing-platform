import { describe, expect, it } from 'vitest';
import { effectSegmentRepairUnavailableReason } from './effect-segment-render-state';
import pageSource from './EffectSegmentRenderNodePage.vue?raw';

describe('imported clip actions', () => {
  const source = {
    status: 'COMPLETED' as const,
    repair: null,
    durationSeconds: 15.041667,
    output: {
      fileObjectId: 'file',
      originalFileName: 'import.mp4',
      mimeType: 'video/mp4',
      sizeBytes: 1024,
      contentHash: 'a'.repeat(64),
      version: 1,
      poster: null,
    },
  };
  it.each([4, 6.04, 15.041667, 30])('allows repair of %s-second imports', (durationSeconds) => {
    expect(effectSegmentRepairUnavailableReason({ ...source, durationSeconds })).toBe('');
  });
  it('explains unsupported formats, sizes and durations', () => {
    expect(effectSegmentRepairUnavailableReason({ ...source, durationSeconds: 31 })).toContain(
      '4～30',
    );
    expect(
      effectSegmentRepairUnavailableReason({
        ...source,
        output: { ...source.output, mimeType: 'video/webm' },
      }),
    ).toContain('MP4');
    expect(
      effectSegmentRepairUnavailableReason({
        ...source,
        output: { ...source.output, sizeBytes: 201 * 1024 * 1024 },
      }),
    ).toContain('200 MB');
  });
  it('does not exclude independent imports from regeneration and describes model routing', () => {
    const eligibility = pageSource.slice(
      pageSource.indexOf('const canRetryTask'),
      pageSource.indexOf('const canRetryTask') + 250,
    );
    expect(eligibility).not.toContain('!task.independentImport');
    expect(eligibility).toContain('!task.repair');
    expect(pageSource).toContain('已确认的反推提示词');
    expect(pageSource).toContain('resolveEffectImportedRenderSettings');
    expect(pageSource).toContain('importedRenderDescription(task)');
  });
});
