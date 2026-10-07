import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { LocalUpdateFinalOutputDto, SourceUpdateFinalOutputDto } from './effect-final-output.controller';

describe('mix local update frozen-operation DTO', () => {
  const request = {
    operationId: '01795c3c-4726-405b-bbc9-28137f768fff',
    workflowRunId: '01795c3c-4726-405b-bbc9-28137f768fff',
    templateId: '01795c3c-4726-405b-bbc9-28137f768fff',
    expectedDraftRevision: 34, variantIds: [], appendNewMaterials: true,
    expectedSourceSignature: 'confirmed-source-signature', expectedPackageNewVariants: true,
  };
  it('accepts and preserves the complete confirmed local-update payload under production whitelist rules', async () => {
    const value = plainToInstance(SourceUpdateFinalOutputDto, request);
    expect(await validate(value, { whitelist: true, forbidNonWhitelisted: true })).toEqual([]);
    expect(value).toMatchObject(request);
  });
  it('still rejects foreign protocol fields instead of weakening whitelist validation', async () => {
    const value = plainToInstance(SourceUpdateFinalOutputDto, { ...request, materials: [] });
    expect(await validate(value, { whitelist: true, forbidNonWhitelisted: true }))
      .toEqual(expect.arrayContaining([expect.objectContaining({ property: 'materials' })]));
  });
});

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
