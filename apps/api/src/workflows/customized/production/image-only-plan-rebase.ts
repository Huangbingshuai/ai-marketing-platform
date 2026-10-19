import {
  isProductionDocument,
  isVideoDocument,
  isProductionClipPrompt,
  validateClipPromptReferences,
  videoClipAssetIds,
  type ProductionDocument,
  type ProductionVideoDocument,
} from '@ai-marketing/contracts';
import type {
  WorkingArtifact,
  WorkingArtifactDependency,
  Prisma,
} from '../../../generated/prisma/client';
import {
  workingArtifactContentHash,
  type WorkflowWorkingRepository,
} from '../../../platform/workflow/workflow-working.repository';
import { workflowStateHash } from '../../../platform/workflow/workflow-state-hash';
import { clipPayload } from './video-production.domain';

const equal = (a: unknown, b: unknown) => workflowStateHash(a) === workflowStateHash(b);
const withoutImages = (assets: ProductionDocument['assets']) =>
  assets.map(({ image: _image, ...a }) => a);
const dependency = (a: WorkingArtifact) => ({
  sourceType: 'WORKING_ARTIFACT' as const,
  sourceArtifactId: a.id,
  sourceNodeId: a.nodeId,
  sourceKey: a.artifactKey,
  sourceRevision: a.revision,
  sourceHash: a.contentHash,
});
const input = (
  a: WorkingArtifact,
  payload: unknown,
  dependencies: ReturnType<typeof dependency>[],
) => ({
  kind: a.kind,
  name: a.name,
  directory: a.directory,
  type: a.type,
  tags: a.tags,
  metadata: a.metadata as Prisma.InputJsonValue,
  payload: payload as Prisma.InputJsonValue,
  dependencies,
});
type Step = { artifact: WorkingArtifact; payload: unknown; sourceKeys: string[] };

/** A proof, not a freshness override. Only exact, image-only lineage may be rebased. */
export function imageOnlyPlanRebase(
  p: string,
  r: string,
  document: ProductionDocument,
  artifacts: WorkingArtifact[],
  deps: WorkingArtifactDependency[],
): { document: ProductionVideoDocument; steps: Step[] } | null {
  if (!isVideoDocument(document)) return null;
  const rows = artifacts.filter((a) => a.artifactKey.startsWith('customized-'));
  if (
    rows.some((a) => a.projectId !== p || a.workflowRunId !== r) ||
    new Set(rows.map((a) => a.artifactKey)).size !== rows.length
  )
    return null;
  const byKey = new Map(rows.map((a) => [a.artifactKey, a]));
  const catalog = byKey.get('customized-asset-catalog'),
    plan = byKey.get('customized-video-plan');
  if (
    !catalog ||
    !plan ||
    catalog.nodeId !== 'SHOT_PROMPT' ||
    plan.nodeId !== 'SHOT_RENDER' ||
    catalog.freshness !== 'CURRENT' ||
    plan.freshness !== 'CURRENT' ||
    !isProductionDocument(plan.payload) ||
    !isVideoDocument(plan.payload)
  )
    return null;
  const baseline = plan.payload;
  if (
    !equal(baseline.videoPlan, document.videoPlan) ||
    !equal(withoutImages(baseline.assets), withoutImages(document.assets)) ||
    !equal(catalog.payload, { assets: document.assets })
  )
    return null;
  const frozen = document.videoPlan.sources;
  if (frozen.length !== 3 || new Set(frozen.map((s) => s.id)).size !== 3) return null;
  const oldCatalog = frozen.find((s) => s.id === catalog.id);
  if (
    !oldCatalog ||
    oldCatalog.revision > catalog.revision ||
    (oldCatalog.revision === catalog.revision && oldCatalog.hash === catalog.contentHash)
  )
    return null;
  const upstream = frozen
    .filter((s) => s.id !== catalog.id)
    .map((s) =>
      rows.find(
        (a) =>
          a.id === s.id &&
          a.revision === s.revision &&
          a.contentHash === s.hash &&
          a.freshness === 'CURRENT',
      ),
    );
  if (upstream.some((a) => !a)) return null;
  const sources = upstream.filter((a): a is WorkingArtifact => !!a);
  const story = sources.find((a) => a.artifactKey.startsWith('customized-script:'));
  const brief = sources.find((a) => a.artifactKey === 'customized-brief');
  if (
    !story ||
    !brief ||
    story.nodeId !== 'STORYBOARD' ||
    brief.nodeId !== 'INFORMATION_EXTRACTION' ||
    sources.length !== 2
  )
    return null;
  const belongs = (d: WorkingArtifactDependency) =>
    d.projectId === p && d.workflowRunId === r && d.sourceType === 'WORKING_ARTIFACT';
  const ownDeps = (a: WorkingArtifact) => deps.filter((d) => d.dependentArtifactId === a.id);
  const matches = (a: WorkingArtifact, expected: ReturnType<typeof dependency>[]) => {
    const actual = ownDeps(a);
    return (
      actual.length === expected.length &&
      new Set(actual.map((d) => d.sourceKey)).size === actual.length &&
      actual.every(
        (d) =>
          belongs(d) &&
          expected.some(
            (e) =>
              e.sourceArtifactId === d.sourceArtifactId &&
              e.sourceKey === d.sourceKey &&
              e.sourceNodeId === d.sourceNodeId &&
              e.sourceRevision === d.sourceRevision &&
              e.sourceHash === d.sourceHash,
          ),
      )
    );
  };
  const upstreamDeps = sources.map(dependency);
  if (!matches(catalog, upstreamDeps) || !matches(plan, [dependency(story)])) return null;
  const historicalHash = (a: WorkingArtifact, payload: unknown, hash: string) =>
    hash === workingArtifactContentHash(input(a, payload, upstreamDeps)) ||
    hash === workflowStateHash(payload);
  if (!historicalHash(catalog, { assets: baseline.assets }, oldCatalog.hash)) return null;
  const oldObjects = new Map(baseline.assets.map((a) => [`customized-object:${a.id}`, a]));
  const objects = document.assets.map((a) => byKey.get(`customized-object:${a.id}`));
  if (
    objects.some(
      (a, i) =>
        !a ||
        a.nodeId !== 'SHOT_PROMPT' ||
        a.freshness !== 'CURRENT' ||
        !equal(a.payload, document.assets[i]) ||
        !matches(a, upstreamDeps),
    )
  )
    return null;
  const objectDependency = (d: WorkingArtifactDependency) => {
    const a = byKey.get(d.sourceKey),
      old = oldObjects.get(d.sourceKey);
    return (
      !!a &&
      !!old &&
      belongs(d) &&
      d.sourceArtifactId === a.id &&
      d.sourceNodeId === a.nodeId &&
      d.sourceRevision !== null &&
      d.sourceRevision >= 1 &&
      d.sourceRevision <= a.revision &&
      !!d.sourceHash &&
      historicalHash(a, old, d.sourceHash)
    );
  };
  const originalMatches = (
    a: WorkingArtifact,
    expected: WorkingArtifact[],
    objectKeys: string[],
  ) => {
    const actual = ownDeps(a);
    return (
      actual.length === expected.length + objectKeys.length &&
      new Set(actual.map((d) => d.sourceKey)).size === actual.length &&
      actual.every((d) =>
        objectKeys.includes(d.sourceKey)
          ? objectDependency(d)
          : belongs(d) &&
            expected.some(
              (s) =>
                s.id === d.sourceArtifactId &&
                s.artifactKey === d.sourceKey &&
                s.nodeId === d.sourceNodeId &&
                s.revision === d.sourceRevision &&
                s.contentHash === d.sourceHash,
            ),
      )
    );
  };
  const steps: Step[] = [];
  const next = new Map(byKey);
  const add = (a: WorkingArtifact, payload: unknown, sourceKeys: string[]) => {
    const selected = sourceKeys.map((k) => next.get(k));
    if (selected.some((v) => !v || v.freshness !== 'CURRENT')) return false;
    const hash = workingArtifactContentHash(
      input(
        a,
        payload,
        selected.map((v) => dependency(v!)),
      ),
    );
    if (hash === a.contentHash && a.freshness !== 'CURRENT') return false;
    next.set(a.artifactKey, {
      ...a,
      payload: payload as Prisma.JsonValue,
      contentHash: hash,
      revision: a.revision + (hash === a.contentHash ? 0 : 1),
      freshness: 'CURRENT',
    });
    steps.push({ artifact: a, payload, sourceKeys });
    return true;
  };
  for (const shot of document.videoPlan.shots) {
    const a = byKey.get(`customized-shot:${shot.id}`),
      objectKeys = shot.bindings.map((b) => `customized-object:${b.assetId}`);
    if (
      !a ||
      a.nodeId !== 'SHOT_RENDER' ||
      !equal(a.payload, shot) ||
      !originalMatches(a, sources, objectKeys) ||
      !add(a, shot, [...sources.map((s) => s.artifactKey), ...objectKeys])
    )
      return null;
  }
  for (const clip of document.videoPlan.clips) {
    const a = byKey.get(`customized-video-clip:${clip.id}`);
    const shots = clip.shotIds.map((id) => byKey.get(`customized-shot:${id}`)!);
    const objectKeys = videoClipAssetIds(document.videoPlan, clip).map(
      (id) => `customized-object:${id}`,
    );
    const payload = clipPayload(document, clip.id);
    if (
      !a ||
      a.nodeId !== 'SHOT_RENDER' ||
      !equal(a.payload, payload) ||
      !originalMatches(a, [...sources, ...shots], objectKeys) ||
      !add(a, payload, [
        ...sources.map((s) => s.artifactKey),
        ...shots.map((s) => s.artifactKey),
        ...objectKeys,
      ])
    )
      return null;
    const prompt = byKey.get(`customized-clip-prompt:${clip.id}`);
    // A genuinely older prompt is left stale, not silently adopted after a shot edit.
    if (
      prompt &&
      prompt.nodeId === 'SHOT_RENDER' &&
      isProductionClipPrompt(prompt.payload, document.videoPlan) &&
      prompt.payload.target.id === clip.id &&
      !validateClipPromptReferences(prompt.payload, document) &&
      matches(prompt, [dependency(a)])
    )
      if (!add(prompt, prompt.payload, [a.artifactKey])) return null;
  }
  const updated = {
    ...document,
    videoPlan: {
      ...document.videoPlan,
      sources: frozen.map((s) =>
        s.id === catalog.id
          ? { id: catalog.id, revision: catalog.revision, hash: catalog.contentHash }
          : s,
      ),
    },
  };
  if (!add(plan, updated, [story.artifactKey])) return null;
  return { document: updated, steps };
}

export async function applyImageOnlyPlanRebase(
  tx: Prisma.TransactionClient,
  working: WorkflowWorkingRepository,
  p: string,
  r: string,
  document: ProductionDocument,
): Promise<ProductionVideoDocument | null> {
  if (!isVideoDocument(document)) return null;
  const rows = await tx.workingArtifact.findMany({
    where: { projectId: p, workflowRunId: r, availability: 'AVAILABLE' },
  });
  const catalog = rows.find((a) => a.artifactKey === 'customized-asset-catalog');
  if (
    catalog &&
    document.videoPlan.sources.some(
      (s) =>
        s.id === catalog.id && s.revision === catalog.revision && s.hash === catalog.contentHash,
    )
  )
    return null;
  const deps = await tx.workingArtifactDependency.findMany({
    where: { projectId: p, workflowRunId: r, dependentArtifactId: { in: rows.map((a) => a.id) } },
  });
  const proof = imageOnlyPlanRebase(p, r, document, rows, deps);
  if (!proof) return null;
  for (const a of document.assets)
    if (a.image) {
      const version = await tx.assetVersion.findFirst({
        where: {
          projectId: p,
          assetId: a.image.assetId,
          version: a.image.version,
          status: { not: 'UNAVAILABLE' },
          mimeType: { in: ['image/png', 'image/jpeg', 'image/webp'] },
          asset: {
            storageWorkflow: 'CUSTOMIZED',
            workflowSpace: 'CUSTOMIZED_PROJECT',
            archivedAt: null,
          },
        },
      });
      if (!version?.storageKey || version.sizeBytes <= 0) return null;
      const file = await tx.fileObject.findFirst({
        where: { projectId: p, storageKey: version.storageKey, status: 'AVAILABLE' },
      });
      if (!file || file.sizeBytes !== version.sizeBytes || !/^[a-f0-9]{64}$/i.test(file.sha256))
        return null;
    }
  const current = new Map(rows.map((a) => [a.artifactKey, a]));
  for (const step of proof.steps) {
    const result = await working.commitValidatedArtifactsInTransaction(
      tx,
      p,
      r,
      step.artifact.nodeId,
      [
        {
          artifactKey: step.artifact.artifactKey,
          invalidateDependents: false,
          input: {
            ...input(
              step.artifact,
              step.payload,
              step.sourceKeys.map((k) => dependency(current.get(k)!)),
            ),
            expectedRevision: step.artifact.revision,
          },
        },
      ],
    );
    current.set(step.artifact.artifactKey, result[0]!.record);
  }
  return proof.document;
}
