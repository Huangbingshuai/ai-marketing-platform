import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import {
  effectTemplateBranchTips,
  type ApiResponse,
  type EffectWorkflowBranchTreeData,
  type EffectTemplateMixSourcesData,
  type FinalOutputRun,
  type WorkingArtifact,
} from '@ai-marketing/contracts';
import { requestJson } from '../../../api/http-client';
import {
  getEffectWorkflowBranchTree,
  listWorkingArtifacts,
} from '../../../platform/workflow/api/workflow-working.api';
import { workflowNodeBaseId } from '../../../platform/workflow/workflow-node-id';
import { loadEffectTemplateMixSources } from '../template-mix/api/effect-template-mix.api';

const NODE_IDS = [
  'SOURCE_IMPORT',
  'INFORMATION_EXTRACTION',
  'PROMPT_GENERATION',
  'SEGMENT_RENDER',
  'TEMPLATE_MIX',
  'FINAL_OUTPUT',
] as const;
export type EffectOutputFreshness = {
  projectId: string;
  workflowRunId: string;
  runs: FinalOutputRun[];
};
export type EffectMixFreshness = {
  projectId: string;
  workflowRunId: string;
  pendingProjectCount: number;
};

export function artifactStaleCounts(artifacts: readonly WorkingArtifact[]): number[] {
  return NODE_IDS.map(
    (id) =>
      new Set(
        artifacts
          .filter(
            (a) =>
              workflowNodeBaseId(a.nodeId) === id &&
              a.freshness === 'STALE' &&
              // The template stores the classified input pool, not an individual film's consumed
              // sources. Pool revisions do not require another local update after every film is current;
              // the source projection below checks actual bindings and newly unclassified materials.
              !(
                id === 'TEMPLATE_MIX' &&
                a.artifactKey?.startsWith('mix-template:') &&
                (a.dependencies ?? []).every(
                  (dependency) => workflowNodeBaseId(dependency.sourceNodeId) === 'SEGMENT_RENDER',
                )
              ) &&
              // An obsolete copy is an input warning for its downstream consumer, not this source head.
              !(
                a.metadata &&
                typeof a.metadata === 'object' &&
                (a.metadata as Record<string, unknown>).branchSourceOwner === false &&
                NODE_IDS.indexOf(id) < 4
              ),
          )
          .map((a) => a.id),
      ).size,
  );
}
export function outputStaleCount(runs: readonly FinalOutputRun[]): number {
  const seen = new Set<string>();
  return runs.reduce((count, run) => {
    if (run.backgroundExportSourceRunId || seen.has(run.templateId)) return count;
    seen.add(run.templateId);
    return count + run.counts.stale;
  }, 0);
}
function outputFreshnessKey(runs: readonly FinalOutputRun[]): string {
  const seen = new Set<string>();
  const projection = [];
  for (const run of runs) {
    if (run.backgroundExportSourceRunId || seen.has(run.templateId)) continue;
    seen.add(run.templateId);
    projection.push([
      run.templateId,
      run.id,
      run.status,
      run.counts.stale,
      run.items.map((item) => [item.id, item.status, item.stale]),
      run.projectChanges,
    ]);
  }
  return JSON.stringify(projection);
}

/** The tree projects exact confirmed dependencies across current template paths, not edit copies. */
export function branchStaleCounts(
  tree: EffectWorkflowBranchTreeData,
  contextRunId: string,
): number[] | null {
  const current = tree.branches.find((branch) => branch.workflowRunId === contextRunId);
  if (!current) return null;
  const counts = NODE_IDS.map((nodeId, index) =>
    index < 4
      ? Number(
          current.nodes.some(
            (node) => node.nodeId === nodeId && node.artifactCount > 0 && node.status === 'STALE',
          ),
        )
      : 0,
  );
  for (const [templateId, branch] of effectTemplateBranchTips(tree.branches, contextRunId, {
    current: true,
  })) {
    const template = branch.templates.find((item) => item.templateId === templateId);
    if (!template) continue;
    if (
      (template.timelineVariantCount > 0 && template.fillStatus === 'STALE') ||
      (template.packagingVariantCount > 0 && template.packagingStatus === 'STALE')
    )
      counts[4]! += 1;
    if ((template.deliveryCount ?? 0) > 0 && template.deliveryStatus === 'STALE') counts[5]! += 1;
  }
  return counts;
}

/** Same exact per-template source comparison as the list; old copied templates never contribute. */
export function currentMixSourceCount(
  tree: EffectWorkflowBranchTreeData,
  contextRunId: string,
  pools: ReadonlyMap<string, EffectTemplateMixSourcesData>,
): number | null {
  if (!tree.branches.some((branch) => branch.workflowRunId === contextRunId)) return null;
  let count = 0;
  for (const [templateId, tip] of effectTemplateBranchTips(tree.branches, contextRunId, {
    current: true,
  })) {
    const source = pools.get(tip.workflowRunId);
    const pending = source?.pendingProjectCounts?.[templateId];
    // Missing is different from an authoritative zero (including compatibility with old APIs).
    if (pending === undefined || !Number.isSafeInteger(pending) || pending < 0) return null;
    count += pending + Number(Boolean(source?.pendingAddedMaterialIds?.[templateId]?.length));
  }
  return count;
}

type CanvasScope = {
  projectId: string;
  workflowRunId: string;
  activeStep: number;
  enabled: boolean;
  /** Hidden editing children have no published downstream results; use their confirmed origin. */
  publishedWorkflowRunId?: string | null;
};
const confirmedRunId = (scope: CanvasScope) => scope.publishedWorkflowRunId || scope.workflowRunId;

/** Display projection only. No writes, task starts or independent version state. */
export function useEffectCanvasFreshness(scope: () => CanvasScope) {
  const artifactCounts = ref<number[]>([]),
    outputCount = ref(0),
    mixCount = ref(0);
  const branchCounts = ref<number[] | null>(null);
  const branchTree = shallowRef<EffectWorkflowBranchTreeData | null>(null);
  const directoryMixCount = ref<number | null>(null);
  const currentPathMixCount = ref<number | null>(null);
  const mixProjectionReady = ref(false);
  let directoryGeneration = 0;
  const staleCounts = computed(() =>
    NODE_IDS.map((_, index) =>
      index === 5
        ? Math.max(
            branchCounts.value?.[index] ?? artifactCounts.value[index] ?? 0,
            outputCount.value,
          )
        : index === 4
          ? (directoryMixCount.value ??
            currentPathMixCount.value ??
            (mixProjectionReady.value
              ? Math.max(
                  branchCounts.value?.[index] ?? artifactCounts.value[index] ?? 0,
                  branchCounts.value === null ? mixCount.value : 0,
                )
              : 0))
          : // Generic artifact reads include exact historical dependency closures. They can be stale
            // while the current render workspace has no Prompt delta; only the scoped tree owns heads.
            (branchCounts.value?.[index] ?? 0),
    ),
  );
  let controller: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let sequence = 0;
  let lastScope = '';
  let lastOutputKey: string | null = null;
  let lastMixCount: number | null = null;
  let disposed = false;
  const acceptOutputs = (state: EffectOutputFreshness, fromOutputPage = true) => {
    const current = scope();
    if (
      !disposed &&
      current.enabled &&
      current.projectId === state.projectId &&
      current.workflowRunId === state.workflowRunId
    ) {
      const nextOutputKey = outputFreshnessKey(state.runs);
      const outputChanged = lastOutputKey !== null && nextOutputKey !== lastOutputKey;
      if (fromOutputPage) lastOutputKey = nextOutputKey;
      outputCount.value = outputStaleCount(state.runs);
      // A completed local update can also clear TEMPLATE_MIX artifact freshness. Re-read the
      // branch projection as soon as the output page reports that transition instead of waiting
      // for the canvas's 12-second fallback poll or requiring the user to reload.
      if (fromOutputPage && outputChanged && current.activeStep !== 5) void refresh();
    }
  };
  const acceptMix = (state: EffectMixFreshness) => {
    const current = scope();
    if (
      !disposed &&
      current.enabled &&
      current.projectId === state.projectId &&
      current.workflowRunId === state.workflowRunId
    ) {
      directoryGeneration += 1;
      directoryMixCount.value = state.pendingProjectCount;
      const changed = lastMixCount !== null && lastMixCount !== state.pendingProjectCount;
      lastMixCount = state.pendingProjectCount;
      // This is the complete current-template directory, not just the selected film.
      // Reconcile a completed update immediately, including its confirmed branch metadata.
      if (changed && state.pendingProjectCount === 0) void refresh();
    }
  };
  const refresh = async (outputsOnly = false) => {
    clearTimeout(timer);
    controller?.abort();
    const current = { ...scope() };
    const publishedRunId = confirmedRunId(current);
    const readingDirectoryGeneration = directoryGeneration;
    const generation = ++sequence;
    if (!current.enabled || !current.projectId || !current.workflowRunId || disposed) return;
    controller = new AbortController();
    const signal = controller.signal;
    const isCurrent = () =>
      !disposed &&
      !signal.aborted &&
      generation === sequence &&
      scope().enabled &&
      scope().projectId === current.projectId &&
      scope().workflowRunId === current.workflowRunId &&
      confirmedRunId(scope()) === publishedRunId;
    try {
      const sources = loadEffectTemplateMixSources(current.projectId, publishedRunId, signal);
      await Promise.all([
        getEffectWorkflowBranchTree(current.projectId, signal).then(async (result) => {
          if (!isCurrent() || result.data.projectId !== current.projectId) return;
          const counts = branchStaleCounts(result.data, publishedRunId);
          if (counts) {
            // Upstream status does not depend on slow mix-source or sibling-template reads.
            // Keep the last authoritative status on a transient error, not a copied artifact's.
            branchTree.value = result.data;
            branchCounts.value = [...counts];
          }
          // Do not briefly warn from inherited artifacts while the authoritative path is loading.
          const currentSources = await sources;
          let exactMixCount: number | null = null;
          if (counts) {
            const tips = effectTemplateBranchTips(result.data.branches, publishedRunId, {
              current: true,
            });
            const sourcePools = new Map([[publishedRunId, currentSources]]);
            // Read only lightweight source projections, once per current Run. Old sibling copies
            // must not contribute their pendingProjectCount to another template's current path.
            await Promise.all(
              [...new Set([...tips.values()].map((tip) => tip.workflowRunId))]
                .filter((id) => id !== publishedRunId)
                .map(async (id) => {
                  sourcePools.set(
                    id,
                    await loadEffectTemplateMixSources(current.projectId, id, signal),
                  );
                }),
            );
            for (const [templateId, tip] of tips) {
              if (
                sourcePools.get(tip.workflowRunId)?.data.pendingAddedMaterialIds?.[templateId]
                  ?.length
              )
                counts[4]! += 1;
            }
            exactMixCount = currentMixSourceCount(
              result.data,
              publishedRunId,
              new Map([...sourcePools].map(([id, result]) => [id, result.data])),
            );
          }
          if (isCurrent() && result.data.projectId === current.projectId) {
            branchTree.value = result.data;
            branchCounts.value = counts;
            mixProjectionReady.value = true;
            // A complete current-path server read can clear a previously shown warning. A
            // newer edit-page projection delivered during this read must not be overwritten.
            if (directoryGeneration === readingDirectoryGeneration) {
              currentPathMixCount.value = exactMixCount;
              // A complete read supersedes the page snapshot, but missing old-API fields do not.
              if (exactMixCount !== null) directoryMixCount.value = null;
            }
          }
        }),
        // Exact material dependencies also detect new-id replacements while old clips remain
        // playable. This is a server projection, not another client-side source/version state.
        sources.then((result) => {
          if (isCurrent())
            mixCount.value =
              (result.data.pendingProjectCount ?? 0) +
              Object.values(result.data.pendingAddedMaterialIds ?? {}).filter(
                (ids) => ids.length > 0,
              ).length;
        }),
        outputsOnly
          ? Promise.resolve()
          : listWorkingArtifacts(
              current.projectId,
              { workflowRunId: publishedRunId, workflow: 'EFFECT', space: 'EFFECT' },
              signal,
            ).then((result) => {
              if (isCurrent()) artifactCounts.value = artifactStaleCounts(result.data.items);
            }),
        // The visible output node supplies its existing poll instead of duplicating it.
        current.activeStep === 5
          ? Promise.resolve()
          : requestJson<ApiResponse<FinalOutputRun[]>>(
              `/projects/${current.projectId}/workflows/effect/final-output?workflowRunId=${encodeURIComponent(publishedRunId)}`,
              { operation: '读取节点待更新状态', signal },
            ).then((result) => {
              if (isCurrent()) acceptOutputs({ ...current, runs: result.data }, false);
            }),
      ]);
    } catch {
      // A transient read error must not clear an already-known update warning.
    } finally {
      if (isCurrent())
        timer = setTimeout(() => {
          if (document.visibilityState === 'visible') void refresh();
          else timer = setTimeout(() => void refresh(), 12000);
        }, 12000);
    }
  };
  watch(
    () => [
      scope().projectId,
      scope().workflowRunId,
      scope().publishedWorkflowRunId,
      scope().activeStep,
      scope().enabled,
    ],
    () => {
      const current = scope();
      const key = `${current.projectId}:${confirmedRunId(current)}:${current.enabled}`;
      if (key !== lastScope) {
        artifactCounts.value = [];
        outputCount.value = 0;
        mixCount.value = 0;
        directoryMixCount.value = null;
        currentPathMixCount.value = null;
        mixProjectionReady.value = false;
        lastOutputKey = null;
        lastMixCount = null;
        if (branchTree.value?.projectId !== current.projectId) branchTree.value = null;
        branchCounts.value =
          current.enabled && branchTree.value
            ? branchStaleCounts(branchTree.value, confirmedRunId(current))
            : null;
        lastScope = key;
      }
      void refresh();
    },
    { immediate: true },
  );
  const focus = () => {
    if (document.visibilityState === 'visible') void refresh();
  };
  const outputChanged = (value: unknown) => {
    const changed = value as {
      projectId?: string;
      workflowRunId?: string;
      confirmed?: boolean;
    } | null;
    const current = scope();
    if (
      !disposed &&
      current.enabled &&
      changed?.projectId === current.projectId &&
      // Draft saves need only deltas; completed local updates confirm new artifacts too.
      // Refresh those immediately rather than retaining their old warning until the timer.
      (changed.workflowRunId === current.workflowRunId ||
        changed.workflowRunId === confirmedRunId(current) ||
        branchTree.value?.branches.some((branch) => branch.workflowRunId === changed.workflowRunId))
    )
      void refresh(!changed.confirmed);
  };
  const saved = (event: Event) => outputChanged((event as CustomEvent).detail);
  const channel =
    typeof BroadcastChannel === 'undefined'
      ? null
      : new BroadcastChannel('effect-final-output-sync');
  if (channel) channel.onmessage = (event) => outputChanged(event.data);
  window.addEventListener('effect-final-output-sync', saved);
  window.addEventListener('focus', focus);
  onBeforeUnmount(() => {
    disposed = true;
    sequence += 1;
    controller?.abort();
    clearTimeout(timer);
    window.removeEventListener('focus', focus);
    window.removeEventListener('effect-final-output-sync', saved);
    channel?.close();
  });
  return { staleCounts, branchTree, acceptOutputs, acceptMix };
}
