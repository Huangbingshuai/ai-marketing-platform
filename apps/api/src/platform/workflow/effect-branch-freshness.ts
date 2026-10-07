import { createHash } from 'node:crypto';
import { EFFECT_WORKFLOW_BRANCH_NODES } from '@ai-marketing/contracts';

type Branch = { id: string; parentWorkflowRunId: string | null; forkNodeId: string | null;
  branchPublishedAt?: Date | string | null };
type Artifact = {
  id: string; workflowRunId: string; nodeId: string; artifactKey: string;
  revision: number; freshness: string; contentHash?: string; payload?: unknown;
  metadata?: unknown;
  updatedAt?: Date | string;
  dependencies?: readonly { sourceType: string; sourceArtifactId?: string | null;
    sourceRevision?: number | null; sourceHash?: string | null }[];
};
const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;

/** A batch revision alone is not a changed clip. Explicit STALE markers (including shared
 * constraints) still win; compare only recorded fields, never invent legacy metadata. */
const matchesConfirmedPrompt = (clip: Artifact, prompt: Artifact): boolean => {
  if (clip.nodeId !== 'SEGMENT_RENDER' || !clip.artifactKey.startsWith('render-clip:') ||
      prompt.nodeId !== 'PROMPT_GENERATION' || !prompt.artifactKey.startsWith('prompt-batch:'))
    return false;
  const payload = record(clip.payload);
  const items = record(prompt.payload)?.items;
  if (!payload || !Array.isArray(items) || typeof payload.promptContentHash !== 'string') return false;
  const item = items.map(record).find((row) => row?.id === payload.promptId);
  if (!item || typeof item.content !== 'string' ||
      createHash('sha256').update(item.content.trim()).digest('hex') !== payload.promptContentHash)
    return false;
  if (payload.primaryPurpose !== undefined && payload.primaryPurpose !== item.primaryPurpose) return false;
  if (Array.isArray(payload.compatiblePurposes) &&
      JSON.stringify([...payload.compatiblePurposes].sort()) !==
        JSON.stringify(Array.isArray(item.compatiblePurposes) ? [...item.compatiblePurposes].sort() : [])) return false;
  if (payload.creativeCore !== undefined && payload.creativeCore !== item.creativeCore) return false;
  const dimensions = record(payload.dimensions);
  return !dimensions || Object.entries(dimensions).every(([key, value]) => record(item.dimensions)?.[key] === value);
};

/** Render copies under mix/output Runs share one render head, including confirmed edits there. */
export function effectRenderSourceOwner(
  branches: readonly Branch[], workflowRunId: string,
  artifacts: readonly Pick<Artifact, 'workflowRunId' | 'nodeId' | 'artifactKey' | 'revision' | 'metadata' | 'payload' | 'updatedAt'>[],
): string {
  const byId = new Map(branches.map((branch) => [branch.id, branch]));
  const head = (id: string): string => {
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
  };
  const root = head(workflowRunId);
  const candidates = branches.filter((branch) => head(branch.id) === root &&
    (branch.id === root || branch.branchPublishedAt !== null));
  const edits = candidates.flatMap((branch) => {
    if (branch.id === root) return [];
    const parentClips = artifacts.filter((row) => row.workflowRunId === branch.parentWorkflowRunId &&
      row.artifactKey.startsWith('render-clip:'));
    return artifacts.filter((row) => row.workflowRunId === branch.id && row.nodeId === 'SEGMENT_RENDER' &&
      row.artifactKey.startsWith('render-clip:') && !record(record(row.metadata)?.branchSource) &&
      parentClips.some((parent) => record(parent.payload)?.promptId === record(row.payload)?.promptId &&
        row.revision > parent.revision)).map((row) => ({ id: branch.id,
          time: new Date(row.updatedAt ?? 0).getTime(), revision: row.revision }));
  });
  edits.sort((a, b) => b.time - a.time || b.revision - a.revision);
  return edits[0]?.id ?? root;
}

/** Copies of upstream stages are snapshots, not new heads. Manual copies are independent. */
export function effectArtifactSourceOwner(
  branches: readonly Branch[], workflowRunId: string, nodeId: string,
  artifacts: readonly Pick<Artifact, 'workflowRunId' | 'nodeId' | 'artifactKey' | 'revision' | 'metadata' | 'payload' | 'updatedAt'>[] = [],
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
    const local = artifacts.filter((item) => item.workflowRunId === cursor!.id && item.nodeId === nodeId);
    const inherited = artifacts.filter((item) => item.workflowRunId === parent.id && item.nodeId === nodeId);
    if (local.some((item) => {
      if (record(record(item.metadata)?.branchSource)) return false;
      const family = item.artifactKey.split(':')[0];
      const promptId = record(item.payload)?.promptId ?? record(item.metadata)?.promptId;
      const sources = inherited.filter((source) => source.artifactKey.split(':')[0] === family &&
        (family !== 'render-clip' || (typeof promptId === 'string' &&
          (record(source.payload)?.promptId ?? record(source.metadata)?.promptId) === promptId)));
      return sources.length > 0 && item.revision > Math.max(...sources.map((source) => source.revision));
    })) break;
    cursor = parent;
  }
  return cursor?.id ?? workflowRunId;
}

/** Read-only compatibility projection. It never rewrites a copied timeline or increments revision. */
export function projectEffectBranchFreshness<T extends Artifact>(
  branches: readonly Branch[], artifacts: readonly T[],
  sourceIdentities: readonly Pick<Artifact, 'workflowRunId' | 'nodeId' | 'artifactKey' | 'revision' | 'metadata' | 'payload' | 'updatedAt'>[] = artifacts,
): T[] {
  const byId = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
  const stages = new Map<string, T[]>();
  for (const artifact of artifacts) {
    const key = `${artifact.workflowRunId}:${artifact.nodeId}`;
    const rows = stages.get(key) ?? [];
    rows.push(artifact);
    stages.set(key, rows);
  }
  const owners = new Map<string, string>();
  const canonicalById = new Map<string, T>();
  const canonical = (artifact: T): T => {
    const provenance = record(record(artifact.metadata)?.branchSource);
    // A locally confirmed mix edit owns its own timeline. Only an explicit clone still consumes
    // its ancestor's mix revision; local-update commits replace that clone provenance.
    if (EFFECT_WORKFLOW_BRANCH_NODES.indexOf(artifact.nodeId as never) >= 4 && !provenance)
      return artifact;
    const key = `${artifact.workflowRunId}:${artifact.nodeId}`;
    let owner = owners.get(key);
    if (!owner) {
      owner = effectArtifactSourceOwner(branches, artifact.workflowRunId, artifact.nodeId, sourceIdentities);
      owners.set(key, owner);
    }
    if (owner === artifact.workflowRunId) return artifact;
    const cached = canonicalById.get(artifact.id);
    if (cached) return cached;
    const resolve = (source: T): T => { canonicalById.set(artifact.id, source); return source; };
    const candidates = stages.get(`${owner}:${artifact.nodeId}`) ?? [];
    const origins = new Set([provenance?.artifactId, ...(Array.isArray(provenance?.ancestorArtifactIds)
      ? provenance.ancestorArtifactIds : [])]);
    const exact = candidates.find((source) => origins.has(source.id) || source.artifactKey === artifact.artifactKey);
    if (exact) return resolve(exact);
    const promptId = record(artifact.payload)?.promptId;
    if (artifact.artifactKey.startsWith('render-clip:') && typeof promptId === 'string') {
      const clips = candidates.filter((source) => source.artifactKey.startsWith('render-clip:') &&
        record(source.payload)?.promptId === promptId);
      // Batch membership identifies the currently adopted task, not task creation order.
      const activeKeys = new Set(candidates.filter((source) => source.artifactKey.startsWith('render-batch:'))
        .flatMap((source) => Array.isArray(record(source.payload)?.clips)
          ? (record(source.payload)!.clips as unknown[]).flatMap((clip) =>
            typeof record(clip)?.taskId === 'string' ? [`render-clip:${record(clip)!.taskId}`] : []) : []));
      const current = clips.filter((source) => activeKeys.has(source.artifactKey));
      if (current.length === 1) return resolve(current[0]!);
      if (clips.length === 1) return resolve(clips[0]!);
    }
    // Legacy single-product aggregate copies reminted product ids. Only a unique pair is resolvable.
    const family = artifact.artifactKey.split(':')[0];
    if (['source-package', 'marketing-insight', 'prompt-batch', 'render-batch'].includes(family!)) {
      const sources = candidates.filter((source) => source.artifactKey.startsWith(`${family}:`));
      const copies = (stages.get(key) ?? []).filter((source) => source.artifactKey.startsWith(`${family}:`));
      if (sources.length === 1 && copies.length === 1) return resolve(sources[0]!);
    }
    return resolve(artifact);
  };
  const states = new Map<string, boolean>();
  const stale = (artifact: T, path = new Set<string>()): boolean => {
    const cached = states.get(artifact.id);
    if (cached !== undefined) return cached;
    if (path.has(artifact.id)) return artifact.freshness === 'STALE';
    const next = new Set(path).add(artifact.id);
    const source = canonical(artifact);
    const file = record(artifact.payload)?.fileObjectId;
    const sourceFile = record(source.payload)?.fileObjectId;
    const changed = source !== artifact && (source.revision !== artifact.revision ||
      (typeof file === 'string' && sourceFile !== file) || stale(source, next));
    const outdated = artifact.freshness === 'STALE' || changed ||
      (artifact.dependencies ?? []).some((dependency) => {
        if (dependency.sourceType !== 'WORKING_ARTIFACT' || !dependency.sourceArtifactId) return false;
        const input = byId.get(dependency.sourceArtifactId);
        // A saved pool deletion invalidates consumers, not the old media file itself.
        // Read only this branch's authoritative render owner; absent membership alone is no proof.
        if (input?.nodeId === 'SEGMENT_RENDER' && input.artifactKey.startsWith('render-clip:')) {
          const owner = effectRenderSourceOwner(branches, artifact.workflowRunId, sourceIdentities);
          const prompt = record(input.payload)?.promptId;
          const pools = sourceIdentities.filter((row) => row.workflowRunId === owner &&
            row.nodeId === 'SEGMENT_RENDER' && row.artifactKey.startsWith('render-batch:'));
          const active = pools.some((pool) => Array.isArray(record(pool.payload)?.clips) &&
            (record(pool.payload)!.clips as unknown[]).some((clip) =>
              record(clip)?.promptId === prompt || `render-clip:${record(clip)?.taskId}` === input.artifactKey));
          const removed = pools.some((pool) => Array.isArray(record(pool.payload)?.removedSources) &&
            (record(pool.payload)!.removedSources as unknown[]).some((row) =>
              (typeof prompt === 'string' && record(row)?.promptId === prompt) ||
              `render-clip:${record(row)?.taskId}` === input.artifactKey));
          if (removed && !active) return true;
        }
        if (input) {
          const confirmed = canonical(input);
          if (matchesConfirmedPrompt(artifact, confirmed) && !stale(confirmed, next)) return false;
        }
        return Boolean(input && (stale(input, next) ||
          (dependency.sourceRevision != null && input.revision !== dependency.sourceRevision) ||
          (dependency.sourceHash && input.contentHash && dependency.sourceHash !== input.contentHash)));
      });
    states.set(artifact.id, outdated);
    return outdated;
  };
  return artifacts.map((artifact) => !artifact.id || !artifact.workflowRunId ? artifact :
    ({ ...artifact, freshness: stale(artifact) ? 'STALE' : artifact.freshness }));
}
