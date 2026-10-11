import { describe, expect, it, vi } from 'vitest';
import type { Prisma } from '../../generated/prisma/client';
import { assertPackagingDraftEditable } from './effect-packaging-lock';

describe('per-film packaging edit fence', () => {
  const draft = { templates: [{ id: 't', workspace: { template: { name: 'T' },
    variants: [{ id: 'a', captions: [] }, { id: 'b', captions: [] }] } }] };
  const client = (active: boolean) => ({ effectPackagingItem: { findMany: vi.fn().mockResolvedValue(active ? [
    { variantId: 'a', snapshot: { operation: 'BATCH_PACKAGE' }, run: { templateId: 't' } },
  ] : []) } }) as unknown as Prisma.TransactionClient;
  it('permits unrelated film edits while protecting active films and shared configuration', async () => {
    const other = structuredClone(draft);
    other.templates[0]!.workspace.variants[1]!.id = 'edited-b';
    await expect(assertPackagingDraftEditable(client(true), 'p', 'w', draft, other)).resolves.toBeUndefined();
    const changed = structuredClone(draft);
    changed.templates[0]!.workspace.variants.shift();
    await expect(assertPackagingDraftEditable(client(true), 'p', 'w', draft, changed)).rejects.toThrow('正在包装');
    const config = structuredClone(draft);
    config.templates[0]!.workspace.template.name = 'changed';
    await expect(assertPackagingDraftEditable(client(true), 'p', 'w', draft, config)).rejects.toThrow('正在包装');
  });
  it('unlocks terminal films without a template-wide lock', async () => {
    await expect(assertPackagingDraftEditable(client(false), 'p', 'w', draft, { templates: [] })).resolves.toBeUndefined();
  });
});
