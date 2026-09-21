import { describe, expect, it, vi } from 'vitest';
import type { EffectTemplateMixVariant } from '@ai-marketing/contracts';
import type { StoragePort } from '../../../platform/file/storage.port';
import type { WorkflowWorkingService } from '../../../platform/workflow/workflow-working.service';
import type { EffectTemplateMixService } from './effect-template-mix.service';
import type { EffectPackagingRepository } from './effect-packaging.repository';
import { EffectPackagingService } from './effect-packaging.service';
import { visualHash } from './effect-packaging.domain';

const v = {
  id: 'v',
  slots: [],
  bindings: {},
  bindingRevisions: {},
  offsets: {},
} as unknown as EffectTemplateMixVariant;
function harness() {
  const visual = {
    id: 'visual',
    artifactKey: 'timeline-project:t:v',
    revision: 2,
    availability: 'AVAILABLE',
    freshness: 'CURRENT',
  };
  const packaging = {
    id: 'package',
    artifactKey: 'timeline-package:t:v',
    availability: 'AVAILABLE',
    freshness: 'CURRENT',
    payload: { sourceTimelineHash: visualHash(v), visualArtifactId: 'visual', visualRevision: 2 },
  };
  const mix = {
    workspace: vi
      .fn()
      .mockResolvedValue({
        draftRevision: 1,
        draft: { templates: [{ id: 't', workspace: { variants: [v] } }] },
      }),
  };
  const working = { listArtifacts: vi.fn().mockResolvedValue({ items: [visual, packaging] }) };
  const repo = {
    get: vi.fn(),
    db: { effectPackagingRun: { findUnique: vi.fn().mockResolvedValue(null) } },
  };
  const service = new EffectPackagingService(
    repo as unknown as EffectPackagingRepository,
    mix as unknown as EffectTemplateMixService,
    working as unknown as WorkflowWorkingService,
    {} as StoragePort,
  );
  return { service, mix, working, repo, visual, packaging };
}
describe('packaging service output boundary', () => {
  it('consumes exactly two confirmed copies', async () => {
    const { service, visual, packaging } = harness();
    expect(await service.outputInputs('p', 'w', 't', 'v')).toEqual({ visual, packaging });
  });
  it('refuses changed visual revisions and stale packaging', async () => {
    const { service, visual, packaging } = harness();
    visual.revision++;
    await expect(service.outputInputs('p', 'w', 't', 'v')).rejects.toThrow('过期');
    visual.revision--;
    packaging.freshness = 'STALE';
    await expect(service.outputInputs('p', 'w', 't', 'v')).rejects.toThrow('过期');
  });
  it('refuses unsaved visual edits before downstream encoding', async () => {
    const { service, mix } = harness();
    mix.workspace.mockResolvedValue({
      draft: { templates: [{ id: 't', workspace: { variants: [{ ...v, offsets: { s: 1 } }] } }] },
    });
    await expect(service.outputInputs('p', 'w', 't', 'v')).rejects.toThrow();
  });
  it('isolates task lookups by project and does not return another project run', async () => {
    const { service, repo } = harness();
    repo.get.mockResolvedValue(null);
    await expect(service.get('other-project', 'run')).rejects.toThrow('不存在');
    expect(repo.get).toHaveBeenCalledWith('other-project', 'run');
  });
  it('does not create a packaging task for empty films', async () => {
    const { service } = harness();
    await expect(
      service.create('p', 't', { workflowRunId: 'w', expectedRevision: 1, idempotencyKey: 'key' }),
    ).rejects.toThrow('完整成片');
  });
});
