import { createHash } from 'node:crypto';
import {
  EFFECT_WORKFLOW_BRANCH_NODES,
  effectTemplateMixSourceChanges,
  effectTemplateMixPendingAddedMaterials,
  effectSegmentRenderPromptDifference,
} from '@ai-marketing/contracts';
import type { EffectSegmentRenderPromptBaseline } from '@ai-marketing/contracts';
import type {
  EffectTemplateMixMaterial,
  EffectTemplateMixVariant,
  EffectTemplateMixTemplate,
  EffectTemplateMixAiSnapshot,
} from '@ai-marketing/contracts';
import { workflowStateHash } from './workflow-state-hash';

/**
 * Evaluate saved engineering against the existing source graph without confirming it.
 * These ephemeral graph inputs never enter storage, counts or business revisions.
 */
export function effectSavedMixSourcesStale(
  branches: readonly Branch[],
  artifacts: readonly Artifact[],
  workflowRunId: string,
  templateId: string,
  variants: readonly EffectTemplateMixVariant[],
): Set<string> {
  const prefix = `saved-output-source:${workflowRunId}:${templateId}:`;
  const inputs = variants.map((variant): Artifact => ({
    id: `${prefix}${variant.id}`,
    workflowRunId,
    nodeId: 'TEMPLATE_MIX',
    artifactKey: `timeline-project:${templateId}:${variant.id}`,
    revision: 0,
    freshness: 'CURRENT',
    availability: 'AVAILABLE',
    payload: { variant },
    dependencies: [],
  }));
  return new Set(
    projectEffectBranchFreshness(branches, [...artifacts, ...inputs])
      .filter((row) => row.id.startsWith(prefix) && row.freshness === 'STALE')
      .map((row) => row.id.slice(prefix.length)),
  );
}

type Branch = {
  id: string;
  parentWorkflowRunId: string | null;
  forkNodeId: string | null;
  editSessionNodeId?: string | null;
  branchPublishedAt?: Date | string | null;
  createdAt?: Date | string;
  effectTemplateMixAiRuns?: readonly {
    templateId: string;
    status?: string;
    inputSnapshot?: unknown;
    selectionResult?: unknown;
    completedAt?: Date | string | null;
  }[];
};
type Artifact = {
  id: string;
  workflowRunId: string;
  nodeId: string;
  artifactKey: string;
  revision: number;
  freshness: string;
  contentHash?: string;
  payload?: unknown;
  availability?: string;
  metadata?: unknown;
  updatedAt?: Date | string;
  dependencies?: readonly {
    sourceType: string;
    sourceArtifactId?: string | null;
    sourceNodeId?: string | null;
    sourceRevision?: number | null;
    sourceHash?: string | null;
  }[];
};
const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/** An explicitly adopted Prompt is not replaced by an older navigation snapshot.
 * Revisions from reminted artifacts are not comparable. A later confirmed edit in the
 * viewing scope still wins, even if its revision number is smaller. Missing evidence
 * leaves the legacy selection unchanged; it never invents a new global source head.
 */
export function effectRenderPromptSource<T extends Artifact>(
  branches: readonly Branch[],
  render: Artifact,
  viewing: T | undefined,
  sources: readonly T[],
): T | undefined {
  const source = record(record(render.payload)?.sourcePrompt);
  const dependency = render.dependencies?.find((row) => row.sourceNodeId === 'PROMPT_GENERATION');
  const id =
    typeof source?.artifactId === 'string' ? source.artifactId : dependency?.sourceArtifactId;
  const adopted = sources.find(
    (row) =>
      row.id === id &&
      row.nodeId === 'PROMPT_GENERATION' &&
      row.artifactKey.startsWith('prompt-batch:'),
  );
  if (!adopted || adopted.id === viewing?.id) return viewing ?? adopted;
  const revision = source?.revision ?? dependency?.sourceRevision;
  const hash = source?.contentHash ?? dependency?.sourceHash;
  if (
    (typeof revision === 'number' && adopted.revision < revision) ||
    (adopted.revision === revision && typeof hash === 'string' && adopted.contentHash !== hash)
  )
    return viewing;
  if (
    effectRenderHead(branches, adopted.workflowRunId) !==
    effectRenderHead(branches, render.workflowRunId)
  )
    return viewing;
  const sourceRun = branches.find((row) => row.id === adopted.workflowRunId);
  if (
    sourceRun?.editSessionNodeId ||
    (sourceRun?.parentWorkflowRunId && sourceRun.branchPublishedAt === null)
  )
    return viewing;
  if (!viewing) return adopted;
  if (viewing.availability === 'UNAVAILABLE' || viewing.freshness !== 'CURRENT') return viewing;
  if (record(record(viewing.metadata)?.branchSource)) return adopted;
  const adoptedTime = new Date(adopted.updatedAt ?? '').getTime();
  const viewingTime = new Date(viewing.updatedAt ?? '').getTime();
  if (!Number.isFinite(adoptedTime) || !Number.isFinite(viewingTime)) return viewing;
  return viewingTime > adoptedTime ? viewing : adopted;
}

/** Revision-only edits may cancel. A reliable adopted baseline owns Prompt freshness. */
const matchesConfirmedPrompt = (clip: Artifact, prompt: Artifact): boolean => {
  if (
    clip.nodeId !== 'SEGMENT_RENDER' ||
    !clip.artifactKey.startsWith('render-clip:') ||
    prompt.nodeId !== 'PROMPT_GENERATION' ||
    !prompt.artifactKey.startsWith('prompt-batch:')
  )
    return false;
  const payload = record(clip.payload);
  const items = record(prompt.payload)?.items;
  if (!payload || !Array.isArray(items) || typeof payload.promptContentHash !== 'string')
    return false;
  const item = items.map(record).find((row) => row?.id === payload.promptId);
  if (
    !item ||
    typeof item.content !== 'string' ||
    createHash('sha256').update(item.content.trim()).digest('hex') !== payload.promptContentHash
  )
    return false;
  const adopted = record(payload.adoptedPrompt);
  if (adopted) {
    const shared =
      record(record(prompt.payload)?.sharedPrompt)?.contentHash ??
      record(record(record(prompt.payload)?.renderProfile)?.sharedConstraints)?.contentHash;
    if (
      typeof shared !== 'string' ||
      typeof item.targetDurationSeconds !== 'number' ||
      !Array.isArray(item.compatiblePurposes)
    )
      return false;
    return !effectSegmentRenderPromptDifference(adopted as EffectSegmentRenderPromptBaseline, {
      promptContentHash: createHash('sha256').update(item.content.trim()).digest('hex'),
      sharedPromptHash: shared,
      targetDurationSeconds: item.targetDurationSeconds,
      primaryPurpose: item.primaryPurpose as EffectSegmentRenderPromptBaseline['primaryPurpose'],
      compatiblePurposes:
        item.compatiblePurposes as EffectSegmentRenderPromptBaseline['compatiblePurposes'],
      ...(typeof item.creativeCore === 'string' ? { creativeCore: item.creativeCore } : {}),
      ...(record(item.dimensions)
        ? {
            dimensions: item.dimensions as NonNullable<
              EffectSegmentRenderPromptBaseline['dimensions']
            >,
          }
        : {}),
    });
  }
  if (payload.primaryPurpose !== undefined && payload.primaryPurpose !== item.primaryPurpose)
    return false;
  if (
    Array.isArray(payload.compatiblePurposes) &&
    JSON.stringify([...payload.compatiblePurposes].sort()) !==
      JSON.stringify(
        Array.isArray(item.compatiblePurposes) ? [...item.compatiblePurposes].sort() : [],
      )
  )
    return false;
  if (payload.creativeCore !== undefined && payload.creativeCore !== item.creativeCore)
    return false;
  const dimensions = record(payload.dimensions);
  return (
    !dimensions ||
    Object.entries(dimensions).every(([key, value]) => record(item.dimensions)?.[key] === value)
  );
};

/** Only mix/output forks share a render pool; render forks and manual copies are independent. */
export function effectRenderHead(branches: readonly Branch[], id: string): string {
  const byId = new Map(branches.map((branch) => [branch.id, branch]));
  let cursor = byId.get(id);
  const seen = new Set<string>();
  while (cursor?.parentWorkflowRunId && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    const fork = EFFECT_WORKFLOW_BRANCH_NODES.indexOf(cursor.forkNodeId as never);
    if (fork < 0 || fork <= 3) break;
    const parent = byId.get(cursor.parentWorkflowRunId);
    if (!parent) break;
    cursor = parent;
  }
  return cursor?.id ?? id;
}

/** Pool membership and clip revisions are independent: an addition must not undo a sibling repair. */
export function effectRenderClipHeads<
  T extends Pick<
    Artifact,
    | 'id'
    | 'workflowRunId'
    | 'nodeId'
    | 'artifactKey'
    | 'revision'
    | 'metadata'
    | 'payload'
    | 'updatedAt'
  >,
>(branches: readonly Branch[], workflowRunId: string, artifacts: readonly T[]): Map<string, T> {
  const root = effectRenderHead(branches, workflowRunId);
  const eligibleRuns = new Set(
    branches
      .filter(
        (branch) =>
          effectRenderHead(branches, branch.id) === root &&
          (branch.id === root || branch.branchPublishedAt !== null),
      )
      .map((branch) => branch.id),
  );
  const owner = effectRenderSourceOwner(branches, workflowRunId, artifacts);
  const ownerClips = artifacts.filter(
    (row) =>
      row.workflowRunId === owner &&
      row.nodeId === 'SEGMENT_RENDER' &&
      row.artifactKey.startsWith('render-clip:'),
  );
  const keys = new Set(
    artifacts
      .filter((row) => row.workflowRunId === owner && row.artifactKey.startsWith('render-batch:'))
      .flatMap((row) =>
        Array.isArray(record(row.payload)?.clips)
          ? (record(row.payload)!.clips as unknown[]).flatMap((clip) =>
              typeof record(clip)?.taskId === 'string'
                ? [`render-clip:${record(clip)!.taskId}`]
                : [],
            )
          : [],
      ),
  );
  const heads = new Map<string, T>();
  for (const row of ownerClips) {
    const prompt = record(row.payload)?.promptId;
    if (keys.has(row.artifactKey) && typeof prompt === 'string') heads.set(prompt, row);
  }
  const version = (row: T) => Math.max(row.revision, Number(record(row.payload)?.version) || 0);
  for (const row of artifacts) {
    if (
      row.nodeId !== 'SEGMENT_RENDER' ||
      !row.artifactKey.startsWith('render-clip:') ||
      !eligibleRuns.has(row.workflowRunId) ||
      record(record(row.metadata)?.branchSource)
    )
      continue;
    const prompt = record(row.payload)?.promptId;
    const baseline = typeof prompt === 'string' ? heads.get(prompt) : undefined;
    // Only merge a confirmed member's versions. Deleted members cannot be resurrected here.
    if (!baseline) continue;
    if (
      version(row) > version(baseline) ||
      (version(row) === version(baseline) &&
        new Date(row.updatedAt ?? 0).getTime() > new Date(baseline.updatedAt ?? 0).getTime())
    )
      heads.set(prompt as string, row);
  }
  return heads;
}

/** Render copies under mix/output Runs share one render head, including confirmed edits there. */
export function effectRenderSourceOwner(
  branches: readonly Branch[],
  workflowRunId: string,
  artifacts: readonly Pick<
    Artifact,
    'workflowRunId' | 'nodeId' | 'artifactKey' | 'revision' | 'metadata' | 'payload' | 'updatedAt'
  >[],
): string {
  const head = (id: string) => effectRenderHead(branches, id);
  const root = head(workflowRunId);
  const candidates = branches.filter(
    (branch) =>
      head(branch.id) === root && (branch.id === root || branch.branchPublishedAt !== null),
  );
  const edits = candidates.flatMap((branch) => {
    const parentClips = artifacts.filter(
      (row) =>
        row.workflowRunId === branch.parentWorkflowRunId &&
        row.artifactKey.startsWith('render-clip:'),
    );
    const parentBatches = artifacts.filter(
      (row) =>
        row.workflowRunId === branch.parentWorkflowRunId &&
        row.nodeId === 'SEGMENT_RENDER' &&
        row.artifactKey.startsWith('render-batch:'),
    );
    const batches = artifacts.filter(
      (row) =>
        row.workflowRunId === branch.id &&
        row.nodeId === 'SEGMENT_RENDER' &&
        row.artifactKey.startsWith('render-batch:') &&
        !record(record(row.metadata)?.branchSource) &&
        Array.isArray(record(row.payload)?.clips) &&
        (branch.id === root ||
          (parentBatches.length > 0 &&
            row.revision > Math.max(...parentBatches.map((parent) => parent.revision)))),
    );
    // New/imported clips start at revision 1, and deleted clips leave no changed clip row.
    // Their confirmed pool revision, not a per-clip revision increase, publishes the source edit.
    const clips =
      branch.id === root
        ? []
        : artifacts.filter(
            (row) =>
              row.workflowRunId === branch.id &&
              row.nodeId === 'SEGMENT_RENDER' &&
              row.artifactKey.startsWith('render-clip:') &&
              !record(record(row.metadata)?.branchSource) &&
              parentClips.some(
                (parent) =>
                  record(parent.payload)?.promptId === record(row.payload)?.promptId &&
                  row.revision > parent.revision,
              ),
          );
    return [...batches, ...clips].map((row) => ({
      id: branch.id,
      time: new Date(row.updatedAt ?? 0).getTime(),
      revision: row.revision,
    }));
  });
  edits.sort((a, b) => b.time - a.time || b.revision - a.revision);
  return edits[0]?.id ?? root;
}

/** Copies of upstream stages are snapshots, not new heads. Manual copies are independent. */
export function effectArtifactSourceOwner(
  branches: readonly Branch[],
  workflowRunId: string,
  nodeId: string,
  artifacts: readonly Pick<
    Artifact,
    'workflowRunId' | 'nodeId' | 'artifactKey' | 'revision' | 'metadata' | 'payload' | 'updatedAt'
  >[] = [],
): string {
  if (nodeId === 'SEGMENT_RENDER' && artifacts.length)
    return effectRenderSourceOwner(branches, workflowRunId, artifacts);
  const byId = new Map(branches.map((branch) => [branch.id, branch]));
  const stage = EFFECT_WORKFLOW_BRANCH_NODES.indexOf(nodeId as never);
  let cursor = byId.get(workflowRunId);
  const seen = new Set<string>();
  while (cursor?.parentWorkflowRunId && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    const fork = EFFECT_WORKFLOW_BRANCH_NODES.indexOf(cursor.forkNodeId as never);
    if (stage < 0 || fork < 0 || stage >= fork) break;
    const parent = byId.get(cursor.parentWorkflowRunId);
    if (!parent) break;
    // Saving an upstream edit covers the current Run, even when that Run originally forked at
    // a later stage. Its forkNodeId describes creation, not every subsequent confirmed edit.
    // Legacy clones preserve the parent's revision; a newer local revision without clone
    // provenance is a confirmed local source head, not an inherited snapshot.
    const local = artifacts.filter(
      (item) => item.workflowRunId === cursor!.id && item.nodeId === nodeId,
    );
    const inherited = artifacts.filter(
      (item) => item.workflowRunId === parent.id && item.nodeId === nodeId,
    );
    if (
      local.some((item) => {
        if (record(record(item.metadata)?.branchSource)) return false;
        const family = item.artifactKey.split(':')[0];
        const promptId = record(item.payload)?.promptId ?? record(item.metadata)?.promptId;
        const sources = inherited.filter(
          (source) =>
            source.artifactKey.split(':')[0] === family &&
            (family !== 'render-clip' ||
              (typeof promptId === 'string' &&
                (record(source.payload)?.promptId ?? record(source.metadata)?.promptId) ===
                  promptId)),
        );
        return (
          sources.length > 0 &&
          item.revision > Math.max(...sources.map((source) => source.revision))
        );
      })
    )
      break;
    cursor = parent;
  }
  return cursor?.id ?? workflowRunId;
}

/** Read-only compatibility projection. It never rewrites a copied timeline or increments revision. */
export function projectEffectBranchFreshness<T extends Artifact>(
  branches: readonly Branch[],
  artifacts: readonly T[],
  sourceIdentities: readonly Pick<
    Artifact,
    | 'id'
    | 'workflowRunId'
    | 'nodeId'
    | 'artifactKey'
    | 'revision'
    | 'metadata'
    | 'payload'
    | 'updatedAt'
  >[] = artifacts,
  promptContextRunId?: string,
): T[] {
  const byId = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
  const independentVisualDependency = (
    artifact: T,
    dependency: NonNullable<T['dependencies']>[number],
  ) => {
    const packageKey = /^timeline-package:([^:]+):(.+)$/.exec(artifact.artifactKey);
    const payload = record(artifact.payload);
    // Only already-confirmed, structured audio packages qualify. Their visual provenance is
    // retained for traceability, not an instruction to regenerate independent audio tracks.
    if (
      artifact.nodeId !== 'TEMPLATE_MIX' ||
      !packageKey ||
      payload?.schemaVersion !== 1 ||
      !record(payload.voices) ||
      !Array.isArray(payload.captions) ||
      dependency.sourceType !== 'WORKING_ARTIFACT' ||
      !dependency.sourceArtifactId
    )
      return false;
    const source = byId.get(dependency.sourceArtifactId);
    return (
      source?.nodeId === 'TEMPLATE_MIX' &&
      source.artifactKey === `timeline-project:${packageKey[1]}:${packageKey[2]}`
    );
  };
  const hasIndependentVisualSource = (artifact: T) =>
    (artifact.dependencies ?? []).some((dependency) =>
      independentVisualDependency(artifact, dependency),
    );
  const stages = new Map<string, T[]>();
  for (const artifact of artifacts) {
    const key = `${artifact.workflowRunId}:${artifact.nodeId}`;
    const rows = stages.get(key) ?? [];
    rows.push(artifact);
    stages.set(key, rows);
  }
  const owners = new Map<string, string>();
  const renderHeads = new Map<string, Map<string, T>>();
  const canonicalById = new Map<string, T>();
  const canonical = (artifact: T): T => {
    const provenance = record(record(artifact.metadata)?.branchSource);
    // A locally confirmed mix edit owns its own timeline. Only an explicit clone still consumes
    // its ancestor's mix revision; local-update commits replace that clone provenance.
    if (EFFECT_WORKFLOW_BRANCH_NODES.indexOf(artifact.nodeId as never) >= 4 && !provenance)
      return artifact;
    if (artifact.nodeId === 'SEGMENT_RENDER' && artifact.artifactKey.startsWith('render-clip:')) {
      const head = effectRenderHead(branches, artifact.workflowRunId);
      let clips = renderHeads.get(head);
      if (!clips) {
        const identities = effectRenderClipHeads(
          branches,
          artifact.workflowRunId,
          sourceIdentities,
        );
        clips = new Map(
          [...identities].flatMap(([prompt, row]) =>
            byId.has(row.id) ? [[prompt, byId.get(row.id)!] as const] : [],
          ),
        );
        renderHeads.set(head, clips);
      }
      const prompt = record(artifact.payload)?.promptId;
      if (typeof prompt === 'string' && clips.has(prompt)) return clips.get(prompt)!;
    }
    const key = `${artifact.workflowRunId}:${artifact.nodeId}`;
    let owner = owners.get(key);
    if (!owner) {
      owner = effectArtifactSourceOwner(
        branches,
        artifact.workflowRunId,
        artifact.nodeId,
        sourceIdentities,
      );
      owners.set(key, owner);
    }
    if (owner === artifact.workflowRunId) return artifact;
    const cached = canonicalById.get(artifact.id);
    if (cached) return cached;
    const resolve = (source: T): T => {
      canonicalById.set(artifact.id, source);
      return source;
    };
    const candidates = stages.get(`${owner}:${artifact.nodeId}`) ?? [];
    const origins = new Set([
      provenance?.artifactId,
      ...(Array.isArray(provenance?.ancestorArtifactIds) ? provenance.ancestorArtifactIds : []),
    ]);
    const exact = candidates.find(
      (source) => origins.has(source.id) || source.artifactKey === artifact.artifactKey,
    );
    if (exact) return resolve(exact);
    const promptId = record(artifact.payload)?.promptId;
    if (artifact.artifactKey.startsWith('render-clip:') && typeof promptId === 'string') {
      const clips = candidates.filter(
        (source) =>
          source.artifactKey.startsWith('render-clip:') &&
          record(source.payload)?.promptId === promptId,
      );
      // Batch membership identifies the currently adopted task, not task creation order.
      const activeKeys = new Set(
        candidates
          .filter((source) => source.artifactKey.startsWith('render-batch:'))
          .flatMap((source) =>
            Array.isArray(record(source.payload)?.clips)
              ? (record(source.payload)!.clips as unknown[]).flatMap((clip) =>
                  typeof record(clip)?.taskId === 'string'
                    ? [`render-clip:${record(clip)!.taskId}`]
                    : [],
                )
              : [],
          ),
      );
      const current = clips.filter((source) => activeKeys.has(source.artifactKey));
      if (current.length === 1) return resolve(current[0]!);
      if (clips.length === 1) return resolve(clips[0]!);
    }
    // Legacy single-product aggregate copies reminted product ids. Only a unique pair is resolvable.
    const family = artifact.artifactKey.split(':')[0];
    if (['source-package', 'marketing-insight', 'prompt-batch', 'render-batch'].includes(family!)) {
      const sources = candidates.filter((source) => source.artifactKey.startsWith(`${family}:`));
      const copies = (stages.get(key) ?? []).filter((source) =>
        source.artifactKey.startsWith(`${family}:`),
      );
      if (sources.length === 1 && copies.length === 1) return resolve(sources[0]!);
    }
    return resolve(artifact);
  };
  const states = new Map<string, boolean>();
  const promptOnlyPending = new Set<string>();
  const promptDifference = (artifact: T): boolean | null => {
    if (artifact.nodeId !== 'SEGMENT_RENDER' || artifact.availability === 'UNAVAILABLE')
      return null;
    const promptDependency = artifact.dependencies?.find(
      (dep) =>
        dep.sourceNodeId === 'PROMPT_GENERATION' ||
        (dep.sourceType === 'WORKING_ARTIFACT' &&
          dep.sourceArtifactId &&
          byId.get(dep.sourceArtifactId)?.nodeId === 'PROMPT_GENERATION'),
    );
    const source = promptDependency?.sourceArtifactId
      ? byId.get(promptDependency.sourceArtifactId)
      : undefined;
    let prompt = source ? canonical(source) : undefined;
    if (promptContextRunId && prompt) {
      const owner = effectArtifactSourceOwner(
        branches,
        promptContextRunId,
        'PROMPT_GENERATION',
        sourceIdentities,
      );
      const candidates = (stages.get(`${owner}:PROMPT_GENERATION`) ?? []).filter((row) =>
        row.artifactKey.startsWith('prompt-batch:'),
      );
      // Clone products may have new IDs; only a unique product pair is safe to project.
      const viewing =
        candidates.find((row) => row.artifactKey === prompt!.artifactKey) ??
        (candidates.length === 1 ? candidates[0] : prompt);
      prompt = effectRenderPromptSource(branches, artifact, viewing, [prompt]);
    }
    if (
      !prompt ||
      prompt.availability === 'UNAVAILABLE' ||
      prompt.freshness !== 'CURRENT' ||
      !Array.isArray(record(prompt.payload)?.items)
    )
      return null;
    const payload = record(artifact.payload);
    if (!payload) return null;
    if (artifact.artifactKey.startsWith('render-clip:')) {
      if (payload.importedMaterial) return false;
      if (typeof payload.promptContentHash !== 'string' || !record(payload.adoptedPrompt))
        return null;
      return !matchesConfirmedPrompt(artifact, prompt);
    }
    if (!artifact.artifactKey.startsWith('render-batch:') || !Array.isArray(payload.clips))
      return null;
    const clips = payload.clips
      .map(record)
      .filter((row): row is Record<string, unknown> => Boolean(row));
    if (clips.some((clip) => !clip.importedMaterial && !record(clip.adoptedPrompt))) return null;
    if (
      clips.some(
        (clip) =>
          !clip.importedMaterial &&
          !matchesConfirmedPrompt(
            {
              ...artifact,
              artifactKey: `render-clip:${clip.taskId}`,
              payload: clip,
            },
            prompt,
          ),
      )
    )
      return true;
    const represented = new Set([
      ...clips.map((clip) => clip.promptId),
      ...(Array.isArray(payload.removedSources)
        ? payload.removedSources
            .map(record)
            .filter((row) => row?.removedBy !== 'PROMPT')
            .map((row) => row?.promptId)
        : []),
    ]);
    return (record(prompt.payload)!.items as unknown[]).some(
      (item) => !represented.has(record(item)?.id),
    );
  };
  const adoptedDifference = (artifact: T): boolean | null => {
    if (artifact.nodeId !== 'TEMPLATE_MIX') return null;
    const direct = record(artifact.payload)?.variant as EffectTemplateMixVariant | undefined;
    const projects = artifact.artifactKey.startsWith('timeline-project:')
      ? [direct]
      : artifact.artifactKey.startsWith('mix-template:')
        ? artifacts
            .filter(
              (row) =>
                row.workflowRunId === artifact.workflowRunId &&
                row.artifactKey.startsWith(
                  `timeline-project:${artifact.artifactKey.slice('mix-template:'.length)}:`,
                ),
            )
            .map((row) => record(row.payload)?.variant as EffectTemplateMixVariant | undefined)
        : [];
    if (!projects.length || projects.some((variant) => !variant?.slots || !variant.bindings))
      return null;
    const templateId = artifact.artifactKey.split(':')[1]!;
    const history: {
      templateId: string;
      status: string;
      inputSnapshot: unknown;
      selectionResult?: unknown;
    }[] = [];
    const visited = new Set<string>();
    let cursor = branches.find((branch) => branch.id === artifact.workflowRunId);
    let cutoff = Infinity;
    while (cursor && !visited.has(cursor.id)) {
      visited.add(cursor.id);
      history.push(
        ...(cursor.effectTemplateMixAiRuns ?? [])
          .filter(
            (run) =>
              cutoff === Infinity ||
              (run.completedAt && new Date(run.completedAt).getTime() <= cutoff),
          )
          .map((run) => ({
            ...run,
            status: run.status ?? 'COMPLETED',
            inputSnapshot: run.inputSnapshot,
          })),
      );
      cutoff = Math.min(
        cutoff,
        cursor.createdAt ? new Date(cursor.createdAt).getTime() : -Infinity,
      );
      cursor = branches.find((branch) => branch.id === cursor!.parentWorkflowRunId);
    }
    const template = record(
      artifacts.find(
        (row) =>
          row.workflowRunId === artifact.workflowRunId &&
          row.artifactKey === `mix-template:${templateId}`,
      )?.payload,
    )?.template as EffectTemplateMixTemplate | undefined;
    if (
      template?.slots &&
      projects.some(
        (variant) =>
          variant!.appliedTemplateHash &&
          variant!.appliedTemplateHash !==
            workflowStateHash({
              name: template.name.trim(),
              slots: template.slots.map((slot) => ({
                id: slot.id,
                role: slot.role,
                label: slot.label,
                duration: slot.duration,
                transition: slot.transition,
                transitionDuration: slot.transitionDuration ?? null,
              })),
            }),
      )
    )
      return true;
    const owner = effectRenderSourceOwner(branches, artifact.workflowRunId, sourceIdentities);
    const heads = effectRenderClipHeads(branches, artifact.workflowRunId, sourceIdentities);
    const batches = sourceIdentities.filter(
      (row) => row.workflowRunId === owner && row.artifactKey.startsWith('render-batch:'),
    );
    const removed = batches.flatMap((row) =>
      Array.isArray(record(row.payload)?.removedSources)
        ? (record(row.payload)!.removedSources as unknown[])
        : [],
    );
    const live = [...heads.values()].map((row): EffectTemplateMixMaterial => ({
      id: row.id,
      artifactId: row.id,
      artifactKey: row.artifactKey,
      artifactRevision: row.revision,
      sourcePromptId: String(record(row.payload)?.promptId ?? ''),
      fileObjectId: String(record(row.payload)?.fileObjectId ?? ''),
      contentHash: String(record(row.payload)?.contentHash ?? ''),
      duration: Number(record(row.payload)?.durationSeconds ?? 0),
      available:
        (!byId.get(row.id) || !stale(byId.get(row.id)!) || promptOnlyPending.has(row.id)) &&
        !['MISSING', 'UNAVAILABLE'].includes(
          byId.get(row.id)?.availability ?? (row as Partial<Artifact>).availability ?? 'AVAILABLE',
        ),
      activeSource: true,
      contentUrl: '',
      code: '',
      name: '',
      ratio: '',
      resolution: '',
      purpose: 'PRODUCT_DISPLAY',
      compatiblePurposes: [],
    }));
    const recovered = projects.map((variant) => {
      const sources = { ...variant!.bindingSources };
      for (const [slot, id] of Object.entries(variant!.bindings)) {
        if (sources[slot]?.id === id) continue;
        const current = live.find(
          (source) =>
            source.id === id && source.artifactRevision === variant!.bindingRevisions[slot],
        );
        if (current) {
          sources[slot] = current;
          continue;
        }
        const candidates = history
          .filter((run) => run.templateId === templateId)
          .flatMap((run) => {
            const snapshot = run.inputSnapshot as Partial<EffectTemplateMixAiSnapshot> | null;
            return Array.isArray(snapshot?.materials)
              ? snapshot.materials.filter(
                  (source) =>
                    source.id === id && source.artifactRevision === variant!.bindingRevisions[slot],
                )
              : [];
          });
        if (new Set(candidates.map((row) => row.fileObjectId)).size !== 1) continue;
        const saved = candidates[0]!;
        sources[slot] = {
          ...live[0],
          ...saved.adoptedSource,
          id,
          artifactId: saved.artifactId,
          artifactKey: saved.artifactKey,
          artifactRevision: saved.artifactRevision,
          fileObjectId: saved.fileObjectId,
          contentHash: saved.adoptedSource?.contentHash ?? '',
          sourcePromptId: saved.promptId,
          duration: saved.duration,
        } as EffectTemplateMixMaterial;
      }
      return { ...variant!, bindingSources: sources };
    });
    if (
      recovered.some((variant) =>
        Object.entries(variant.bindings).some(
          ([slot, id]) => variant.bindingSources[slot]?.id !== id,
        ),
      )
    )
      return null;
    const adopted = recovered.flatMap((variant) => Object.values(variant.bindingSources));
    const materials = [
      ...live,
      ...adopted
        .filter((source) => !live.some((row) => row.id === source.id))
        .map((source) => ({
          ...source,
          activeSource: false,
          sourceRemoved: removed.some(
            (row) =>
              (source.sourcePromptId && record(row)?.promptId === source.sourcePromptId) ||
              `render-clip:${record(row)?.taskId}` === source.artifactKey,
          ),
        })),
    ];
    if (recovered.some((variant) => effectTemplateMixSourceChanges(variant, materials).length > 0))
      return true;
    // Additions affect the template, not every existing film. Inherit only successful fills
    // already completed at the child fork boundary, never a sibling's later adoption.
    if (artifact.artifactKey.startsWith('mix-template:')) {
      if (effectTemplateMixPendingAddedMaterials(templateId, live, history, template?.slots).length)
        return true;
    }
    return false;
  };
  const stale = (artifact: T, path = new Set<string>()): boolean => {
    const cached = states.get(artifact.id);
    if (cached !== undefined) return cached;
    if (path.has(artifact.id)) return artifact.freshness === 'STALE';
    const next = new Set(path).add(artifact.id);
    const source = canonical(artifact);
    const file = record(artifact.payload)?.fileObjectId;
    const sourceFile = record(source.payload)?.fileObjectId;
    const changed =
      source !== artifact &&
      (source.revision !== artifact.revision ||
        (typeof file === 'string' && sourceFile !== file) ||
        stale(source, next));
    const promptDelta = promptDifference(artifact);
    const difference = promptDelta ?? adoptedDifference(artifact);
    const outdated =
      (artifact.freshness === 'STALE' &&
        !hasIndependentVisualSource(artifact) &&
        difference === null) ||
      changed ||
      difference === true ||
      (artifact.dependencies ?? []).some((dependency) => {
        if (independentVisualDependency(artifact, dependency)) return false;
        if (dependency.sourceType !== 'WORKING_ARTIFACT' || !dependency.sourceArtifactId)
          return false;
        const input = byId.get(dependency.sourceArtifactId);
        if (promptDelta !== null && input?.nodeId === 'PROMPT_GENERATION') return false;
        if (difference !== null && input?.nodeId === 'SEGMENT_RENDER') return false;
        // A saved pool deletion invalidates consumers, not the old media file itself.
        // Read only this branch's authoritative render owner; absent membership alone is no proof.
        if (input?.nodeId === 'SEGMENT_RENDER' && input.artifactKey.startsWith('render-clip:')) {
          const owner = effectRenderSourceOwner(branches, artifact.workflowRunId, sourceIdentities);
          const prompt = record(input.payload)?.promptId;
          const pools = sourceIdentities.filter(
            (row) =>
              row.workflowRunId === owner &&
              row.nodeId === 'SEGMENT_RENDER' &&
              row.artifactKey.startsWith('render-batch:'),
          );
          const active = pools.some(
            (pool) =>
              Array.isArray(record(pool.payload)?.clips) &&
              (record(pool.payload)!.clips as unknown[]).some(
                (clip) =>
                  record(clip)?.promptId === prompt ||
                  `render-clip:${record(clip)?.taskId}` === input.artifactKey,
              ),
          );
          const removed = pools.some(
            (pool) =>
              Array.isArray(record(pool.payload)?.removedSources) &&
              (record(pool.payload)!.removedSources as unknown[]).some(
                (row) =>
                  (typeof prompt === 'string' && record(row)?.promptId === prompt) ||
                  `render-clip:${record(row)?.taskId}` === input.artifactKey,
              ),
          );
          if (removed && !active) return true;
        }
        if (input) {
          const confirmed = canonical(input);
          if (matchesConfirmedPrompt(artifact, confirmed) && !stale(confirmed, next)) return false;
        }
        return Boolean(
          input &&
          ((stale(input, next) && !promptOnlyPending.has(input.id)) ||
            (dependency.sourceRevision != null && input.revision !== dependency.sourceRevision) ||
            (dependency.sourceHash &&
              input.contentHash &&
              dependency.sourceHash !== input.contentHash)),
        );
      });
    if (
      promptDelta === true &&
      !changed &&
      (artifact.dependencies ?? []).every((dependency) => {
        if (dependency.sourceType !== 'WORKING_ARTIFACT' || !dependency.sourceArtifactId)
          return true;
        const input = byId.get(dependency.sourceArtifactId);
        if (input?.nodeId === 'PROMPT_GENERATION') return true;
        return Boolean(
          input &&
          !stale(input, next) &&
          (dependency.sourceRevision == null || input.revision === dependency.sourceRevision) &&
          (!dependency.sourceHash ||
            !input.contentHash ||
            input.contentHash === dependency.sourceHash),
        );
      })
    )
      promptOnlyPending.add(artifact.id);
    states.set(artifact.id, outdated);
    return outdated;
  };
  return artifacts.map((artifact) => {
    if (!artifact.id || !artifact.workflowRunId) return artifact;
    const freshness = stale(artifact)
      ? 'STALE'
      : hasIndependentVisualSource(artifact) ||
          promptDifference(artifact) !== null ||
          adoptedDifference(artifact) !== null
        ? 'CURRENT'
        : artifact.freshness;
    return {
      ...artifact,
      freshness,
      ...(promptOnlyPending.has(artifact.id) || record(artifact.metadata)?.promptSourcePending
        ? {
            metadata: {
              ...record(artifact.metadata),
              promptSourcePending: promptOnlyPending.has(artifact.id),
            },
          }
        : {}),
    };
  });
}
