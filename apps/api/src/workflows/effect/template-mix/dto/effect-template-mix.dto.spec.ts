import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { SaveEffectTemplateMixDraftDto } from './effect-template-mix.dto';

const input = {
  workflowRunId: '01795c3c-4726-405b-bbc9-28137f768fff',
  expectedRevision: 7,
  draft: { schemaVersion: 1, templates: [] },
};

describe('compact mix autosave DTO', () => {
  it.each([undefined, false, true])(
    'accepts optional boolean %s through the HTTP whitelist',
    async (value) => {
      const dto = plainToInstance(SaveEffectTemplateMixDraftDto, {
        ...input,
        ...(value === undefined ? {} : { compactResponse: value }),
      });
      expect(await validate(dto, { whitelist: true, forbidNonWhitelisted: true })).toEqual([]);
      expect(dto.compactResponse).toBe(value);
    },
  );

  it.each(['true', 1, {}])('rejects non-boolean compactResponse %s', async (value) => {
    const dto = plainToInstance(SaveEffectTemplateMixDraftDto, {
      ...input,
      compactResponse: value,
    });
    expect(await validate(dto, { whitelist: true, forbidNonWhitelisted: true })).toEqual(
      expect.arrayContaining([expect.objectContaining({ property: 'compactResponse' })]),
    );
  });
});
