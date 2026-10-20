import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { isProductionPromptMechanicalRecovery } from './customized-prompt-recovery';

const cases = JSON.parse(
  readFileSync(
    resolve(__dirname, '../fixtures/customized-prompt-mechanical-recovery.json'),
    'utf8',
  ),
) as { name: string; value: unknown; valid: boolean }[];
for (const item of cases)
  it(`mechanical recovery cross-runtime metadata: ${item.name}`, () => {
    expect(isProductionPromptMechanicalRecovery(item.value)).toBe(item.valid);
  });
