import { expect, it } from 'vitest';
import type { EffectTemplateMixWorkspaceData, WorkingArtifact } from '@ai-marketing/contracts';
import { packagingSnapshot } from './effect-packaging.domain';

/** Explicit opt-in: GET only, no task creation or paid provider requests. */
it.skipIf(process.env.EFFECT_PACKAGING_SOURCE_READONLY_TEST !== '1')(
  'freezes every real film using only its confirmed render and fact dependencies',
  async () => {
    const projectId = process.env.EFFECT_PACKAGING_SOURCE_PROJECT_ID;
    const runId = process.env.EFFECT_PACKAGING_SOURCE_RUN_ID;
    expect(projectId).toBeTruthy();
    expect(runId).toBeTruthy();
    const base = `${process.env.EFFECT_PACKAGING_SOURCE_API_URL ?? 'http://localhost:3100/api'}/projects/${projectId}`;
    const get = async <T>(path: string): Promise<T> => {
      const response = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(30_000) });
      expect(response.ok).toBe(true);
      const body = (await response.json()) as { data: T };
      return body.data;
    };
    const [workspace, artifacts] = await Promise.all([
      get<EffectTemplateMixWorkspaceData>(`/workflows/effect/template-mix?workflowRunId=${runId}`),
      get<{ items: WorkingArtifact[] }>(
        `/working-artifacts?workflowRunId=${runId}&workflow=EFFECT&space=EFFECT`,
      ),
    ]);
    const variants = workspace.draft.templates
      .flatMap(({ workspace }) => workspace.variants)
      .filter((variant) => variant.slots.some(({ id }) => variant.bindings[id]));
    expect(variants.length).toBeGreaterThan(0);
    const before = structuredClone({ workspace, artifacts });
    for (const variant of variants) {
      const frozen = packagingSnapshot(variant, workspace.materials, artifacts.items);
      expect(frozen.clips.length).toBeGreaterThan(0);
      expect(frozen.facts.length).toBeGreaterThan(0);
      expect(
        frozen.dependencies.every(({ artifactId }) =>
          artifacts.items.some(
            (artifact) => artifact.id === artifactId && artifact.availability === 'AVAILABLE',
          ),
        ),
      ).toBe(true);
    }
    expect({ workspace, artifacts }).toEqual(before);
  },
  60_000,
);
