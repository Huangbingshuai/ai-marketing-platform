import type { ExtractionNodeDetail } from '@ai-marketing/contracts';

export type DetailSelection = {
  projectId: string;
  workflowRunId: string;
  taskId: string;
  nodeId: string;
};

/** A single in-flight detail query. Poll updates are coalesced without clearing the panel. */
export function createLiveNodeDetail(options: {
  load: (selection: DetailSelection, signal: AbortSignal) => Promise<ExtractionNodeDetail>;
  reset: () => void;
  loading: (value: boolean) => void;
  publish: (detail: ExtractionNodeDetail) => void;
  error: (error: unknown) => void;
}) {
  let selection: DetailSelection | null = null;
  let controller: AbortController | null = null;
  let pending = false;
  function cancel() {
    selection = null;
    controller?.abort();
    controller = null;
    pending = false;
    options.loading(false);
  }
  async function query(foreground: boolean) {
    if (!selection) return;
    if (controller) {
      pending = true;
      return;
    }
    const selected = selection;
    const current = new AbortController();
    controller = current;
    if (foreground) options.loading(true);
    try {
      const detail = await options.load(selected, current.signal);
      if (controller === current && !current.signal.aborted) options.publish(detail);
    } catch (error) {
      if (controller === current && !current.signal.aborted) options.error(error);
    } finally {
      if (controller === current) {
        controller = null;
        options.loading(false);
        if (pending) {
          pending = false;
          void query(false);
        }
      }
    }
  }
  return {
    cancel,
    select(next: DetailSelection) {
      cancel();
      selection = next;
      options.reset();
      return query(true);
    },
    refresh(taskId: string) {
      if (selection?.taskId !== taskId) return;
      return query(false);
    },
  };
}
