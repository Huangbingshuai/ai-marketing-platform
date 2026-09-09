import type { GetEffectSegmentRenderWorkspaceData } from '@ai-marketing/contracts';

import {
  loadEffectWorkspaceSnapshot,
  prefetchEffectWorkspace,
  type EffectWorkspaceSnapshot,
} from '../../shared/effect-workspace-prefetch';
import { getEffectSegmentRenderWorkspace } from '../api/effect-segment-render.api';

export type EffectSegmentRenderWorkspaceContext = {
  projectId: string;
  workflowRunId: string;
  productId: string;
};

const renderWorkspacePrefetchKey = (context: EffectSegmentRenderWorkspaceContext): string =>
  [
    'effect-render',
    encodeURIComponent(context.projectId),
    encodeURIComponent(context.workflowRunId),
    encodeURIComponent(context.productId),
  ].join(':');

const loadEffectSegmentRenderWorkspace = async (
  context: EffectSegmentRenderWorkspaceContext,
  signal?: AbortSignal,
): Promise<GetEffectSegmentRenderWorkspaceData> =>
  (
    await getEffectSegmentRenderWorkspace(
      context.projectId,
      context.workflowRunId,
      context.productId,
      signal,
    )
  ).data;

export const prefetchEffectSegmentRenderWorkspace = (
  context: EffectSegmentRenderWorkspaceContext,
): Promise<GetEffectSegmentRenderWorkspaceData> =>
  prefetchEffectWorkspace(renderWorkspacePrefetchKey(context), () =>
    loadEffectSegmentRenderWorkspace(context),
  );

export const loadEffectSegmentRenderWorkspaceSnapshot = (
  context: EffectSegmentRenderWorkspaceContext,
  signal?: AbortSignal,
): Promise<EffectWorkspaceSnapshot<GetEffectSegmentRenderWorkspaceData>> =>
  loadEffectWorkspaceSnapshot(
    renderWorkspacePrefetchKey(context),
    (requestSignal) => loadEffectSegmentRenderWorkspace(context, requestSignal),
    signal,
  );
