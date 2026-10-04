import { computed, onBeforeUnmount, ref, watch } from 'vue';
import type { ApiResponse, FinalOutputRun, WorkingArtifact } from '@ai-marketing/contracts';
import { requestJson } from '../../../api/http-client';
import { listWorkingArtifacts } from '../../../platform/workflow/api/workflow-working.api';
import { workflowNodeBaseId } from '../../../platform/workflow/workflow-node-id';
import { loadEffectTemplateMixSources } from '../template-mix/api/effect-template-mix.api';

const NODE_IDS = ['SOURCE_IMPORT', 'INFORMATION_EXTRACTION', 'PROMPT_GENERATION',
  'SEGMENT_RENDER', 'TEMPLATE_MIX', 'FINAL_OUTPUT'] as const;
export type EffectOutputFreshness = { projectId: string; workflowRunId: string; runs: FinalOutputRun[] };

export function artifactStaleCounts(artifacts: readonly WorkingArtifact[]): number[] {
  return NODE_IDS.map((id) => new Set(artifacts
    .filter((a) => workflowNodeBaseId(a.nodeId) === id && a.freshness === 'STALE')
    .map((a) => a.id)).size);
}
export function outputStaleCount(runs: readonly FinalOutputRun[]): number {
  const seen = new Set<string>();
  return runs.reduce((count, run) => {
    if (run.backgroundExportSourceRunId || seen.has(run.templateId)) return count;
    seen.add(run.templateId);
    return count + run.counts.stale;
  }, 0);
}

/** Display projection only. No writes, task starts or independent version state. */
export function useEffectCanvasFreshness(scope: () => {
  projectId: string; workflowRunId: string; activeStep: number; enabled: boolean;
}) {
  const artifactCounts = ref<number[]>([]), outputCount = ref(0), mixCount = ref(0);
  const staleCounts = computed(() => NODE_IDS.map((_, index) => index === 5
    ? Math.max(artifactCounts.value[index] ?? 0, outputCount.value)
    : index === 4 ? Math.max(artifactCounts.value[index] ?? 0, mixCount.value)
    : artifactCounts.value[index] ?? 0));
  let controller: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let sequence = 0;
  let lastScope = '';
  let disposed = false;
  const acceptOutputs = (state: EffectOutputFreshness) => {
    const current = scope();
    if (!disposed && current.enabled && current.projectId === state.projectId &&
      current.workflowRunId === state.workflowRunId) outputCount.value = outputStaleCount(state.runs);
  };
  const refresh = async (outputsOnly = false) => {
    clearTimeout(timer);
    controller?.abort();
    const current = scope();
    const generation = ++sequence;
    if (!current.enabled || !current.projectId || !current.workflowRunId || disposed) return;
    controller = new AbortController();
    const signal = controller.signal;
    const isCurrent = () => !disposed && !signal.aborted && generation === sequence &&
      scope().projectId === current.projectId && scope().workflowRunId === current.workflowRunId;
    try {
      await Promise.all([
        // Exact material dependencies also detect new-id replacements while old clips remain
        // playable. This is a server projection, not another client-side source/version state.
        loadEffectTemplateMixSources(current.projectId, current.workflowRunId, signal).then((result) => {
          if (isCurrent()) mixCount.value = (result.data.pendingProjectCount ?? 0) +
            Object.values(result.data.pendingAddedMaterialIds ?? {}).filter((ids) => ids.length > 0).length;
        }),
        outputsOnly ? Promise.resolve() : listWorkingArtifacts(current.projectId, { workflowRunId: current.workflowRunId,
          workflow: 'EFFECT', space: 'EFFECT' }, signal).then((result) => {
          if (isCurrent()) artifactCounts.value = artifactStaleCounts(result.data.items);
        }),
        // The visible output node supplies its existing poll instead of duplicating it.
        current.activeStep === 5 ? Promise.resolve() : requestJson<ApiResponse<FinalOutputRun[]>>(
          `/projects/${current.projectId}/workflows/effect/final-output?workflowRunId=${encodeURIComponent(current.workflowRunId)}`,
          { operation: '读取节点待更新状态', signal },
        ).then((result) => { if (isCurrent()) acceptOutputs({ ...current, runs: result.data }); }),
      ]);
    } catch {
      // A transient read error must not clear an already-known update warning.
    } finally {
      if (isCurrent()) timer = setTimeout(() => {
        if (document.visibilityState === 'visible') void refresh();
        else timer = setTimeout(() => void refresh(), 12000);
      }, 12000);
    }
  };
  watch(() => [scope().projectId, scope().workflowRunId, scope().activeStep, scope().enabled], () => {
    const current = scope();
    const key = `${current.projectId}:${current.workflowRunId}:${current.enabled}`;
    if (key !== lastScope) { artifactCounts.value = []; outputCount.value = 0; mixCount.value = 0; lastScope = key; }
    void refresh();
  }, { immediate: true });
  const focus = () => { if (document.visibilityState === 'visible') void refresh(); };
  const outputChanged = (value: unknown) => {
    const changed = value as { projectId?: string; workflowRunId?: string } | null;
    const current = scope();
    if (!disposed && current.enabled && changed?.projectId === current.projectId &&
      // A draft/audio save does not publish working-artifact revisions. Read the output delta
      // first; the regular artifact poll still covers confirmed upstream changes.
      changed.workflowRunId === current.workflowRunId) void refresh(true);
  };
  const saved = (event: Event) => outputChanged((event as CustomEvent).detail);
  const channel = typeof BroadcastChannel === 'undefined' ? null :
    new BroadcastChannel('effect-final-output-sync');
  if (channel) channel.onmessage = (event) => outputChanged(event.data);
  window.addEventListener('effect-final-output-sync', saved);
  window.addEventListener('focus', focus);
  onBeforeUnmount(() => {
    disposed = true; sequence += 1; controller?.abort(); clearTimeout(timer);
    window.removeEventListener('focus', focus);
    window.removeEventListener('effect-final-output-sync', saved);
    channel?.close();
  });
  return { staleCounts, acceptOutputs };
}
