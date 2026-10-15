import 'reflect-metadata';

import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { describe, expect, it } from 'vitest';

import { PromptResultQueryDto } from './dto/effect-prompt.dto';

describe('Prompt source query validation', () => {
  const workflowRunId = '00000000-0000-4000-8000-000000000001';

  it.each([undefined, 'AI', 'MANUAL'])('accepts source %s', (origin) => {
    const dto = plainToInstance(PromptResultQueryDto, { workflowRunId, origin });
    expect(validateSync(dto)).toEqual([]);
  });

  it.each(['EXTERNAL', '', ['AI', 'MANUAL']])('rejects unknown source %s', (origin) => {
    const dto = plainToInstance(PromptResultQueryDto, { workflowRunId, origin });
    expect(validateSync(dto).some(({ property }) => property === 'origin')).toBe(true);
  });
});
