import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { LocalUpdateFinalOutputDto } from './effect-final-output.controller';

describe('final output project synchronization DTO', () => {
  it('allows empty selected IDs for explicit membership sync without stripping the flag', async () => {
    const value = plainToInstance(LocalUpdateFinalOutputDto, { itemIds: [], syncProjects: true });
    expect(await validate(value, { whitelist: true, forbidNonWhitelisted: true })).toEqual([]);
    expect(value.syncProjects).toBe(true);
  });
  it('preserves legacy selected-item requests', async () => {
    const value = plainToInstance(LocalUpdateFinalOutputDto, {
      itemIds: ['01795c3c-4726-405b-bbc9-28137f768fff'],
    });
    expect(await validate(value)).toEqual([]);
    expect(value.syncProjects).toBeUndefined();
  });
  it.each(['true', 1, {}])('rejects non-boolean synchronization flags (%s)', async (syncProjects) => {
    const value = plainToInstance(LocalUpdateFinalOutputDto, { itemIds: [], syncProjects });
    expect(await validate(value)).toEqual(expect.arrayContaining([
      expect.objectContaining({ property: 'syncProjects' }),
    ]));
  });
  it('rejects duplicate IDs', async () => {
    const id = '01795c3c-4726-405b-bbc9-28137f768fff';
    expect(await validate(plainToInstance(LocalUpdateFinalOutputDto, { itemIds: [id, id] })))
      .toEqual(expect.arrayContaining([expect.objectContaining({ property: 'itemIds' })]));
  });
});
