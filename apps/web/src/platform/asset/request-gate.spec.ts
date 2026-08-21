import { describe, expect, it } from 'vitest';

import { createRequestGate } from './request-gate';

describe('request generation gate', () => {
  it('prevents a late project A response from becoming current after project B starts', () => {
    const gate = createRequestGate();
    const projectA = gate.begin();
    const projectB = gate.begin();
    expect(gate.current(projectA)).toBe(false);
    expect(gate.current(projectB)).toBe(true);
  });

  it('invalidates an active request synchronously on project switch', () => {
    const gate = createRequestGate();
    const active = gate.begin();
    gate.invalidate();
    expect(gate.current(active)).toBe(false);
  });
});
