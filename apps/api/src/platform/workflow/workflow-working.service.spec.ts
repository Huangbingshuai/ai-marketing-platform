import { describe, expect, it } from 'vitest';
import { workflowStateHash } from './workflow-working.service';

describe('workflowStateHash', () => {
  it('normalizes object key order while preserving array order', () => {
    expect(workflowStateHash({ b: 2, a: { y: 2, x: 1 } })).toBe(
      workflowStateHash({ a: { x: 1, y: 2 }, b: 2 }),
    );
    expect(workflowStateHash({ values: [1, 2] })).not.toBe(workflowStateHash({ values: [2, 1] }));
  });
});
