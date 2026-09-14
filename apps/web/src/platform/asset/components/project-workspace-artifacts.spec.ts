import type { WorkingArtifact } from '@ai-marketing/contracts';
import { describe, expect, it } from 'vitest';

import { aggregateWorkspaceArtifacts, renderBatchClipCount } from './project-workspace-artifacts';

const artifact = (
  artifactKey: string,
  metadata: Record<string, unknown>,
  overrides: Partial<WorkingArtifact> = {},
): WorkingArtifact => ({
  id: artifactKey,
  projectId: 'project-1',
  workflowRunId: 'run-1',
  nodeId: 'SEGMENT_RENDER',
  artifactKey,
  kind: 'STRUCTURED',
  name: artifactKey,
  directory: 'VIDEO_MATERIALS',
  type: 'VIDEO_MATERIAL',
  tags: [],
  payload: null,
  metadata,
  originalFileName: null,
  mimeType: null,
  sizeBytes: null,
  previewKind: 'DOWNLOAD',
  contentUrl: null,
  downloadUrl: null,
  sourceRunId: null,
  sourceArtifactId: null,
  revision: 1,
  freshness: 'CURRENT',
  availability: 'AVAILABLE',
  dependencies: [],
  files: [],
  fileCount: 0,
  mainPreviewUrl: null,
  status: 'WORKING',
  archiveStatus: 'UNARCHIVED',
  createdAt: '2026-09-12T00:00:00.000Z',
  updatedAt: '2026-09-12T00:00:00.000Z',
  ...overrides,
});

describe('project workspace artifact aggregation', () => {
  it('collapses clip artifacts only when their product has a batch pool', () => {
    const source = artifact('source-package:product-1', { productId: 'product-1' });
    const pool = artifact('render-batch:product-1', { productId: 'product-1' });
    const pooledClip = artifact('render-clip:task-1', { productId: 'product-1' });
    const standaloneClip = artifact('render-clip:task-2', { productId: 'product-2' });

    expect(aggregateWorkspaceArtifacts([source, pool, pooledClip, standaloneClip])).toEqual([
      source,
      pool,
      standaloneClip,
    ]);
  });

  it('reads the material count from batch metadata with safe fallbacks', () => {
    expect(renderBatchClipCount(artifact('render-batch:product-1', { completedCount: 100 }))).toBe(
      100,
    );
    expect(
      renderBatchClipCount(
        artifact(
          'render-batch:product-1',
          {},
          { payload: { clips: [{ taskId: 'one' }, { taskId: 'two' }] }, fileCount: 8 },
        ),
      ),
    ).toBe(2);
  });
});
