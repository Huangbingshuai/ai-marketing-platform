import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../database/prisma.service';
import {
  CUSTOMIZED_CACHE_TABLES,
  EFFECT_CACHE_TABLES,
  EffectCacheRevisionService,
} from './effect-cache-revision.service';

const rowsFor = (resource: keyof typeof EFFECT_CACHE_TABLES) =>
  EFFECT_CACHE_TABLES[resource].map((name) => ({
    workflowRunId: 'run',
    name,
    version: `${name}-v1`,
    active: false,
  }));

describe('Effect cache dependency stamps', () => {
  it.each(Object.keys(CUSTOMIZED_CACHE_TABLES) as Array<keyof typeof CUSTOMIZED_CACHE_TABLES>)(
    '%s validates custom scope and hashes physical versions without importing Effect tables',
    async (resource) => {
      const rows = CUSTOMIZED_CACHE_TABLES[resource].map((name) => ({
        workflowRunId: 'custom-run',
        name,
        version: 'v1',
        active: false,
      }));
      const db = {
        $queryRaw: vi
          .fn<(query: unknown) => Promise<typeof rows>>()
          .mockImplementation(async () => rows),
      };
      const service = new EffectCacheRevisionService(db as unknown as PrismaService);
      const scope = {
        projectId: 'p',
        workflow: 'CUSTOMIZED' as const,
        workflowRunId: 'custom-run',
      };
      expect((await service.read(scope, resource))?.version).toHaveLength(64);
      const query = db.$queryRaw.mock.calls[0]![0] as { text: string; values: unknown[] };
      expect(query.values).toEqual(
        expect.arrayContaining(['CUSTOMIZED', 'CUSTOMIZED_PROJECT', 'p', 'custom-run']),
      );
      expect(query.text).toContain('t.xmin::text');
      expect(query.text).not.toContain('effect_import');
      expect(query.text).not.toContain('to_jsonb');
      expect(await service.read({ projectId: 'p' }, resource)).toBeNull();
      expect(await service.read(scope, 'tree')).toBeNull();
      expect(await service.read({ ...scope, draftId: 'd' }, resource)).toBeNull();
      rows.pop();
      expect(await service.read(scope, resource)).toBeNull();
    },
  );
  it('hashes independent of UNION order and rejects incomplete, duplicated or mixed-scope vectors', async () => {
    const rows = rowsFor('mix');
    const db = { $queryRaw: vi.fn(async () => rows) };
    const service = new EffectCacheRevisionService(db as unknown as PrismaService);
    const scope = { projectId: 'project', workflowRunId: 'run' };
    const first = await service.read(scope, 'mix');
    expect(first?.version).toHaveLength(64);
    rows.reverse();
    expect(await service.read(scope, 'mix')).toEqual(first);
    const original = rows[0]!;
    rows[0] = rows[1]!;
    expect(await service.read(scope, 'mix')).toBeNull();
    rows[0] = { ...original, workflowRunId: 'other-run' };
    expect(await service.read(scope, 'mix')).toBeNull();
    rows[0] = original;
    rows.pop();
    expect(await service.read(scope, 'mix')).toBeNull();
  });

  it('uses one statement for scope and dependency versions, including draft and explicit Run constraints', async () => {
    const rows = rowsFor('extraction');
    rows.find((row) => row.name === 'effect_extraction_runs')!.active = true;
    const db = {
      $queryRaw: vi
        .fn<(query: { values: unknown[] }) => Promise<typeof rows>>()
        .mockResolvedValue(rows),
    };
    const service = new EffectCacheRevisionService(db as unknown as PrismaService);
    expect(
      await service.read(
        { projectId: 'project', draftId: 'draft', workflowRunId: 'run' },
        'extraction',
      ),
    ).toMatchObject({ workflowRunId: 'run', active: true });
    expect(db.$queryRaw).toHaveBeenCalledTimes(1);
    expect(db.$queryRaw.mock.calls[0]![0].values).toEqual(
      expect.arrayContaining(['project', 'draft', 'run']),
    );
    db.$queryRaw.mockResolvedValueOnce([]);
    expect(
      await service.read({ projectId: 'project', workflowRunId: 'unrelated' }, 'mix'),
    ).toBeNull();
  });
});
