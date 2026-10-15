import { describe, expect, it } from 'vitest';
import { retainedRoleMaterials } from './effect-template-mix-retained-role';

const frozen = { id: 'old', fileObjectId: 'old-file', promptId: 'p1', prompt: '原画面' };
const current = {
  id: 'new',
  fileObjectId: 'new-file',
  sourcePromptId: 'p1',
  promptText: '修改后的画面',
};

describe('confirmed material purpose retention', () => {
  it('retains a stable Prompt purpose across changed text and footage', () => {
    expect(retainedRoleMaterials(frozen, [current])).toEqual([current]);
  });
  it('retains an imported clip purpose by its unchanged material identity', () => {
    const imported = { ...current, id: 'old', sourcePromptId: 'new-inferred-prompt' };
    expect(retainedRoleMaterials(frozen, [imported])).toEqual([imported]);
  });
  it('carries an explicit replacement even when the Prompt identity was reminted', () => {
    const replacement = { ...current, sourcePromptId: 'p2', replacesMaterialIds: ['old'] };
    expect(retainedRoleMaterials(frozen, [replacement])).toEqual([replacement]);
  });
  it('does not use matching names or text to classify a genuinely new clip', () => {
    expect(
      retainedRoleMaterials(frozen, [
        { ...current, sourcePromptId: 'p2', promptText: frozen.prompt },
      ]),
    ).toEqual([]);
  });
  it('does not choose arbitrarily between two live heads', () => {
    expect(
      retainedRoleMaterials(frozen, [
        current,
        { ...current, id: 'another', fileObjectId: 'another-file' },
      ]),
    ).toEqual([]);
  });
  it('supports old same-file identities only with the exact original text', () => {
    const legacy = {
      ...current,
      sourcePromptId: '',
      fileObjectId: frozen.fileObjectId,
      promptText: frozen.prompt,
    };
    expect(retainedRoleMaterials(frozen, [legacy])).toEqual([legacy]);
    expect(retainedRoleMaterials(frozen, [{ ...legacy, promptText: 'different' }])).toEqual([]);
  });
});
