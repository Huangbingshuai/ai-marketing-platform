import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
import {
  CreatePackagingCaptionVoiceDto,
  UpdatePackagingAudioDto,
} from './effect-packaging.controller';

describe('packaging audio update DTO', () => {
  it('accepts a package-wide caption font size through the HTTP whitelist', async () => {
    const dto = plainToInstance(UpdatePackagingAudioDto, {
      expectedUpdatedAt: '2026-09-24T00:00:00.000Z',
      captionFontSize: 17,
    });

    expect(await validate(dto, { whitelist: true, forbidNonWhitelisted: true })).toEqual([]);
    expect(dto.captionFontSize).toBe(17);
  });

  it('rejects caption font sizes outside the editor range', async () => {
    for (const captionFontSize of [7, 49, 16.5]) {
      const dto = plainToInstance(UpdatePackagingAudioDto, {
        expectedUpdatedAt: '2026-09-24T00:00:00.000Z',
        captionFontSize,
      });

      expect(
        JSON.stringify(await validate(dto, { whitelist: true, forbidNonWhitelisted: true })),
      ).toContain('captionFontSize');
    }
  });

  it('accepts a blank manually-created subtitle draft through the HTTP whitelist', async () => {
    const dto = plainToInstance(UpdatePackagingAudioDto, {
      expectedUpdatedAt: '2026-09-24T00:00:00.000Z',
      captions: [
        {
          id: 'manual-caption',
          manual: true,
          trackId: 'subtitle-track-0000000000001-test',
          text: '',
          start: 0,
          end: 3,
        },
      ],
    });

    const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });

    expect(errors).toEqual([]);
    expect(dto.captions?.[0]).toMatchObject({
      manual: true,
      trackId: 'subtitle-track-0000000000001-test',
      text: '',
    });
  });

  it('accepts a cleared row as a value rather than an omission', async () => {
    // Sending the field back to the implicit row is a clear, not a missing field, so `null` has to
    // survive the whitelist — `@IsOptional()` skips it exactly as it skips an omission, and the
    // service is what tells the two apart.
    const dto = plainToInstance(UpdatePackagingAudioDto, {
      expectedUpdatedAt: '2026-09-24T00:00:00.000Z',
      captions: [{ id: 'manual-caption', text: '商品', start: 0, end: 3, trackId: null }],
    });

    const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });

    expect(errors).toEqual([]);
    expect(dto.captions?.[0]?.trackId).toBeNull();
  });

  it('continues rejecting caption fields outside the editor contract', async () => {
    const dto = plainToInstance(UpdatePackagingAudioDto, {
      expectedUpdatedAt: '2026-09-24T00:00:00.000Z',
      captions: [
        {
          id: 'manual-caption',
          manual: true,
          text: '',
          start: 0,
          end: 3,
          property: 'unexpected',
        },
      ],
    });

    const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });

    expect(JSON.stringify(errors)).toContain('property');
  });
});

describe('caption narration audio update DTO', () => {
  it('accepts a moved caption narration through the HTTP whitelist', async () => {
    const dto = plainToInstance(UpdatePackagingAudioDto, {
      expectedUpdatedAt: '2026-09-24T00:00:00.000Z',
      captionVoices: {
        'caption-2183e9e90838e91503c6b262': {
          start: 10,
          offset: 0,
          duration: 3.01,
          volume: 1,
          fadeIn: 0,
          fadeOut: 0,
        },
      },
    });

    expect(await validate(dto, { whitelist: true, forbidNonWhitelisted: true })).toEqual([]);
    expect(dto.captionVoices?.['caption-2183e9e90838e91503c6b262']?.start).toBe(10);
  });

  it('still rejects a caption narration that is not a map of clips', async () => {
    const dto = plainToInstance(UpdatePackagingAudioDto, {
      expectedUpdatedAt: '2026-09-24T00:00:00.000Z',
      captionVoices: 'caption-2183e9e90838e91503c6b262',
    });

    expect(JSON.stringify(await validate(dto))).toContain('captionVoices');
  });
});

describe('audio removal request DTO', () => {
  it('accepts every removal channel the editor sends', async () => {
    // These three are not geometry edits — there is no clip left to describe — so each needs its own
    // field on the whitelist. Without them the global pipe answers 400 before the service runs,
    // which is what made deleting the music bed or a caption narration fail in the browser while the
    // service tests passed.
    const dto = plainToInstance(UpdatePackagingAudioDto, {
      expectedUpdatedAt: '2026-09-24T00:00:00.000Z',
      removedVoices: ['line-1'],
      removedCaptionVoices: ['caption-1'],
      removeMusic: true,
    });

    const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });

    expect(errors).toEqual([]);
    expect(dto.removedVoices).toEqual(['line-1']);
    expect(dto.removedCaptionVoices).toEqual(['caption-1']);
    expect(dto.removeMusic).toBe(true);
  });

  it('rejects a removal id that is not a plain clip key', async () => {
    for (const removedVoices of [['a b'], ['x'.repeat(81)], [7]]) {
      const dto = plainToInstance(UpdatePackagingAudioDto, {
        expectedUpdatedAt: '2026-09-24T00:00:00.000Z',
        removedVoices,
      });
      expect(JSON.stringify(await validate(dto))).toContain('removedVoices');
    }
  });
});

describe('caption narration request DTO', () => {
  it('accepts a caption id the editor can address and the text it is showing', async () => {
    const dto = plainToInstance(CreatePackagingCaptionVoiceDto, {
      captionId: 'caption-1_ab',
      text: '限时五折',
    });

    expect(await validate(dto, { whitelist: true, forbidNonWhitelisted: true })).toEqual([]);
  });

  it('rejects a caption id that is not a plain editor key and text longer than a caption', async () => {
    for (const captionId of ['', 'a b', 'x'.repeat(51)]) {
      const dto = plainToInstance(CreatePackagingCaptionVoiceDto, { captionId, text: '商品' });
      expect(JSON.stringify(await validate(dto))).toContain('captionId');
    }
    const long = plainToInstance(CreatePackagingCaptionVoiceDto, {
      captionId: 'caption-1',
      text: 'x'.repeat(501),
    });
    expect(JSON.stringify(await validate(long))).toContain('text');
  });
});
