import { expect, it } from 'vitest';
import { productionTasksConflict } from './customized-production-concurrency';

it('allows independent clip work while preserving same-clip and whole-plan exclusion', () => {
  for (const operation of ['PROMPT', 'RENDER']) {
    const a = { operation, target: { kind: 'CLIP', id: 'a' } };
    for (const other of ['PROMPT', 'RENDER']) {
      expect(
        productionTasksConflict(a, { operation: other, target: { kind: 'CLIP', id: 'b' } }),
      ).toBe(false);
      expect(
        productionTasksConflict(a, { operation: other, target: { kind: 'CLIP', id: 'a' } }),
      ).toBe(true);
    }
    for (const whole of ['ASSETS', 'IMAGE', 'SHOTS', 'UNKNOWN']) {
      const b = { operation: whole, target: { kind: 'CLIP', id: 'b' } };
      expect(productionTasksConflict(a, b)).toBe(true);
      expect(productionTasksConflict(b, a)).toBe(true);
    }
    expect(productionTasksConflict(a, { operation: 'PROMPT' })).toBe(true);
    expect(
      productionTasksConflict(a, { operation: 'RENDER', target: { kind: 'SHOT', id: 'b' } }),
    ).toBe(true);
    expect(
      productionTasksConflict(a, { operation: 'RENDER', target: { kind: 'CLIP', id: ' ' } }),
    ).toBe(true);
  }
});
