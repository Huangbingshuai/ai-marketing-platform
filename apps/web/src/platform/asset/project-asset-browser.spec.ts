import type { Asset, WorkingArtifact, WorkingArtifactFile } from '@ai-marketing/contracts';
import { describe, expect, it } from 'vitest';
import {
  assetSourceLabel,
  assetFileFormat,
  groupSourceAssets,
  SOURCE_ASSET_CATEGORIES,
  assetSummary,
  buildBrowserAssets,
  browserAssetNodeId,
  filterBrowserAssetsByNode,
  UNKNOWN_ASSET_NODE,
  EFFECT_ASSET_NODES,
  filterBrowserAssets,
  formatAssetSize,
  formatAssetTime,
} from './project-asset-browser';

const scope = {
  projectId: 'p1',
  workflow: 'EFFECT' as const,
  space: 'EFFECT' as const,
  workflowRunId: 'r1',
};
const file = (
  id: string,
  previewKind: WorkingArtifactFile['previewKind'] = 'VIDEO',
): WorkingArtifactFile => ({
  id,
  fileObjectId: id,
  role: 'SOURCE',
  sortOrder: 0,
  originalFileName: `${id}.mp4`,
  mimeType: 'video/mp4',
  sizeBytes: 1024,
  sha256: id,
  previewKind,
  previewUrl: `/files/${id}`,
  contentUrl: `/files/${id}`,
  downloadUrl: `/files/${id}?download=true`,
});
const working = (overrides: Partial<WorkingArtifact> = {}): WorkingArtifact => ({
  id: 'w1',
  projectId: 'p1',
  workflowRunId: 'r1',
  nodeId: 'SEGMENT_RENDER',
  artifactKey: 'render-clip:c1',
  kind: 'FILE',
  name: '梅子酱素材',
  directory: 'VIDEO_MATERIALS',
  type: 'VIDEO_MATERIAL',
  tags: ['酱汁'],
  payload: null,
  metadata: { durationSeconds: 6.04 },
  originalFileName: null,
  mimeType: 'video/mp4',
  sizeBytes: 1024,
  previewKind: 'VIDEO',
  contentUrl: '/video',
  downloadUrl: '/video/download',
  sourceRunId: null,
  sourceArtifactId: null,
  revision: 2,
  freshness: 'CURRENT',
  availability: 'AVAILABLE',
  dependencies: [],
  files: [file('v1')],
  fileCount: 1,
  mainPreviewUrl: null,
  status: 'WORKING',
  archiveStatus: 'UNARCHIVED',
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-07T00:00:00Z',
  ...overrides,
});
const asset = (overrides: Partial<Asset> = {}): Asset => ({
  id: 'a1',
  projectId: 'p1',
  name: '已保存素材',
  directory: 'VIDEO_MATERIALS',
  type: 'VIDEO_MATERIAL',
  tags: [],
  notes: null,
  originalFileName: 'video.mp4',
  mimeType: 'video/mp4',
  sizeBytes: 1024,
  hasFile: true,
  previewKind: 'VIDEO',
  contentUrl: '/asset/video',
  downloadUrl: '/asset/video/download',
  storageWorkflow: 'EFFECT',
  workflowSpace: 'EFFECT',
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-01T00:00:00Z',
  ...overrides,
});

describe('project asset browser presentation', () => {
  it('isolates source documents from package images and never borrows the package cover', () => {
    const rows = buildBrowserAssets(
      [
        working({
          type: 'SOURCE_MATERIAL',
          nodeId: 'SOURCE_IMPORT',
          artifactKey: 'source-package:p',
          mainPreviewUrl: '/product-photo',
          files: [
            {
              ...file('document', 'DOWNLOAD'),
              originalFileName: '资料包.docx',
              mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            },
            { ...file('picture', 'IMAGE'), originalFileName: '产品.jpg' },
            file('source-video'),
            { ...file('audio', 'AUDIO'), originalFileName: '音频.mp3' },
          ],
        }),
      ],
      [],
      scope,
    );
    expect(rows[0]?.previewUrl).toBeNull();
    expect(rows[0]?.contentUrl).toBe('/files/document');
    expect(rows[0]?.downloadUrl).toBe('/files/document?download=true');
    expect(rows[1]?.previewUrl).toBe('/files/picture');
    expect(rows[2]?.previewUrl).toBeNull();
    expect(rows[3]?.previewUrl).toBeNull();
    expect(assetFileFormat(rows[0]!)).toBe('DOCX');
    const groups = groupSourceAssets(rows);
    expect(groups.map((group) => group.label)).toEqual(['图片', '文档']);
    expect(groups.map((group) => group.items.map((item) => item.name))).toEqual([
      ['产品.jpg'],
      ['资料包.docx'],
    ]);
    expect(groupSourceAssets([])).toEqual([]);
    expect(
      assetFileFormat(
        buildBrowserAssets([working({ files: [], originalFileName: '无扩展名' })], [], scope)[0]!,
      ),
    ).toBe('文件');
  });
  it('matches product-import categories without affecting rendering videos or other-node audio', () => {
    expect(SOURCE_ASSET_CATEGORIES.map((option) => option.value)).toEqual([
      'ALL',
      'IMAGE',
      'DOCUMENT',
    ]);
    const rows = buildBrowserAssets(
      [
        working({
          id: 'source',
          type: 'SOURCE_MATERIAL',
          nodeId: 'SOURCE_IMPORT',
          files: [
            file('image', 'IMAGE'),
            file('document', 'DOWNLOAD'),
            file('video'),
            file('audio', 'AUDIO'),
          ],
        }),
        working({ id: 'render', files: [file('render-video')] }),
        working({
          id: 'output',
          type: 'SOURCE_MATERIAL',
          nodeId: 'FINAL_OUTPUT',
          files: [file('output-audio', 'AUDIO')],
        }),
      ],
      [],
      scope,
    );
    expect(filterBrowserAssetsByNode(rows, 'SOURCE_IMPORT').map((item) => item.category)).toEqual([
      'IMAGE',
      'DOCUMENT',
    ]);
    expect(filterBrowserAssetsByNode(rows, 'SEGMENT_RENDER').map((item) => item.category)).toEqual([
      'VIDEO',
    ]);
    expect(filterBrowserAssetsByNode(rows, 'FINAL_OUTPUT').map((item) => item.previewKind)).toEqual(
      ['AUDIO'],
    );
  });
  it('uses only API-adopted clip heads of the selected rendering version, retaining manual imports but not inherited obsolete clips', () => {
    const rows = buildBrowserAssets(
      [
        working({ id: 'old', metadata: { branchSourceOwner: false } }),
        working({
          id: 'updated',
          workflowRunId: 'mix-child',
          files: [file('updated')],
          metadata: { branchSourceOwner: true },
        }),
        working({
          id: 'imported',
          workflowRunId: 'mix-child',
          files: [file('imported')],
          metadata: { branchSourceOwner: true },
        }),
        working({ id: 'foreign-project', projectId: 'p2', metadata: { branchSourceOwner: true } }),
        working({ id: 'unproven', workflowRunId: 'different-head', metadata: {} }),
      ],
      [],
      { ...scope, strictVersion: true, renderSourceHeads: true },
    );
    expect(rows.map((item) => item.id)).toEqual([
      'working:updated:updated',
      'working:imported:imported',
    ]);
  });
  it('isolates formal records by their exact selected snapshot or Run without guessing legacy ownership', () => {
    const rows = buildBrowserAssets(
      [working()],
      [
        asset({ id: 'linked', sourceArtifactId: 'w1', sourceRunId: 'task-not-workflow-run' }),
        asset({ id: 'local', sourceRunId: 'r1' }),
        asset({ id: 'history', sourceRunId: 'r2' }),
        asset({ id: 'legacy' }),
        asset({ id: 'foreign', projectId: 'p2', sourceArtifactId: 'w1' }),
      ],
      { ...scope, strictVersion: true },
    );
    expect(rows.map((item) => item.id)).toEqual(['project:linked', 'project:local']);
    expect(
      buildBrowserAssets([], [asset({ sourceRunId: 'r1' })], {
        ...scope,
        strictVersion: true,
        workflowRunId: null,
      }),
    ).toEqual([]);
  });
  it('isolates final outputs by stable template keys, resolves formal links and deduplicates them', () => {
    const rows = buildBrowserAssets(
      [
        working({
          id: 'a',
          nodeId: 'FINAL_OUTPUT',
          type: 'FINAL_VIDEO',
          artifactKey: 'final-video:t:v',
          files: [file('a')],
          metadata: { duration: 38 },
        }),
        working({
          id: 'b',
          nodeId: 'FINAL_OUTPUT',
          type: 'FINAL_VIDEO',
          artifactKey: 'final-video:t2:v',
          files: [file('b')],
        }),
        working({
          id: 'manifest',
          type: 'DELIVERY_MANIFEST',
          nodeId: 'FINAL_OUTPUT',
          artifactKey: 'final-delivery:t',
          files: [file('a')],
          payload: { templateId: 't' },
        }),
      ],
      [
        asset({
          id: 'delivered',
          type: 'FINAL_VIDEO',
          sourceNode: 'FINAL_OUTPUT',
          sourceArtifactId: 'a',
          sourceRunId: 'r1',
        }),
        asset({ id: 'wrong-template', sourceArtifactId: 'b', sourceRunId: 'r1' }),
        asset({ id: 'unassigned', sourceRunId: 'r1' }),
      ],
      { ...scope, strictVersion: true, templateId: 't' },
    );
    expect(rows.map((item) => item.id)).toEqual(['project:delivered']);
    expect(rows[0]?.durationSeconds).toBe(38);
    const standalone = buildBrowserAssets(
      [working({ metadata: { duration: 38 }, artifactKey: 'final-video:t:v' })],
      [],
      { ...scope, strictVersion: true, templateId: 't' },
    );
    expect(standalone[0]?.durationSeconds).toBe(38);
  });
  it('keeps project, workflow, space and run isolation', () => {
    const rows = buildBrowserAssets(
      [
        working(),
        working({ id: 'wrong-project', projectId: 'p2' }),
        working({ id: 'wrong-run', workflowRunId: 'r2' }),
      ],
      [
        asset(),
        asset({ id: 'a2', storageWorkflow: 'FISSION' }),
        asset({ id: 'a3', workflowSpace: 'FISSION_CLONE' }),
        asset({ id: 'a4', projectId: 'p2' }),
      ],
      scope,
    );
    expect(rows.map((row) => row.id)).toEqual(['working:w1:v1', 'project:a1']);
    expect(buildBrowserAssets([working()], [], { ...scope, workflowRunId: null })).toEqual([]);
  });
  it('expands actual source files and does not present a batch index as a video', () => {
    const rows = buildBrowserAssets(
      [
        working({
          id: 'package',
          artifactKey: 'source-package:p',
          type: 'SOURCE_MATERIAL',
          files: [file('image', 'IMAGE'), file('video')],
          fileCount: 2,
        }),
        working({ id: 'batch', artifactKey: 'render-batch:p' }),
        working(),
      ],
      [],
      scope,
    );
    expect(rows).toHaveLength(3);
    expect(rows[0]?.name).toBe('image.mp4');
    expect(rows[0]?.category).toBe('IMAGE');
    expect(rows[1]?.category).toBe('VIDEO');
    expect(rows.some((row) => row.id.includes('batch'))).toBe(false);
  });
  it('does not turn working copies into formal project assets', () => {
    const rows = buildBrowserAssets([working()], [asset()], scope);
    expect(rows.map(assetSourceLabel)).toEqual(['工作副本', '项目资产']);
    expect(rows[0]?.source.kind).toBe('working');
  });
  it('prefers actual video over a poster file and keeps precise source duration', () => {
    const row = buildBrowserAssets(
      [working({ files: [file('cover', 'IMAGE'), file('video')], mainPreviewUrl: '/poster' })],
      [],
      scope,
    )[0]!;
    expect(row.contentUrl).toBe('/files/video');
    expect(row.previewUrl).toBe('/poster');
    expect(row.durationSeconds).toBe(6.04);
  });
  it('deduplicates identical file references without masking differing availability', () => {
    const rows = buildBrowserAssets(
      [
        working(),
        working({ id: 'copy' }),
        working({ id: 'removed', availability: 'SOURCE_REMOVED' }),
      ],
      [],
      scope,
    );
    expect(rows).toHaveLength(2);
    expect(rows[1]?.unavailable).toBe(true);
    expect(rows[1]?.status).toBe('来源已删除');
  });
  it('filters tags, categories and names and sorts a copy', () => {
    const rows = buildBrowserAssets(
      [
        working(),
        working({
          id: 'image',
          type: 'SOURCE_MATERIAL',
          files: [file('pic', 'IMAGE')],
          updatedAt: '2026-10-06T00:00:00Z',
        }),
      ],
      [asset()],
      scope,
    );
    expect(filterBrowserAssets(rows, 'VIDEO', '酱汁', 'recent')).toHaveLength(1);
    expect(filterBrowserAssets(rows, 'IMAGE', '', 'recent')).toHaveLength(1);
    expect(filterBrowserAssets(rows, 'ALL', '不存在', 'recent')).toEqual([]);
    expect(filterBrowserAssets(rows, 'ALL', '', 'recent')[0]?.id).toBe('working:w1:v1');
    expect(rows[0]?.id).toBe('working:w1:v1');
  });
  it('does not expose raw structured payloads or invalid metadata', () => {
    const row = buildBrowserAssets(
      [
        working({
          type: 'VIDEO_CONFIG',
          kind: 'STRUCTURED',
          files: [],
          previewKind: 'DOWNLOAD',
          payload: { secretInternalObject: { token: 'hidden' } },
        }),
      ],
      [],
      scope,
    )[0]!;
    expect(assetSummary(row)).not.toContain('secretInternalObject');
    expect(formatAssetSize(null)).toBe('—');
    expect(formatAssetSize(1048576)).toBe('1.0 MB');
    expect(formatAssetTime('bad')).toBe('—');
  });
  it('prioritizes actual media without misclassifying a project with a cover', () => {
    const rows = buildBrowserAssets(
      [
        working({
          id: 'project',
          type: 'VIDEO_CONFIG',
          files: [file('cover', 'IMAGE')],
          previewKind: 'IMAGE',
          updatedAt: '2026-10-08T00:00:00Z',
        }),
        working(),
      ],
      [],
      scope,
    );
    expect(rows[0]?.category).toBe('PROJECT');
    expect(filterBrowserAssets(rows, 'ALL', '', 'media')[0]?.category).toBe('VIDEO');
    expect(filterBrowserAssets(rows, 'ALL', '', 'recent')[0]?.category).toBe('PROJECT');
  });
  it('isolates nodes by authoritative source and normalizes node suffixes and aliases', () => {
    const rows = buildBrowserAssets(
      [
        working({ nodeId: 'SEGMENT_RENDER:product1' }),
        working({
          id: 'settings',
          nodeId: 'SEGMENT_RENDER_SETTINGS',
          type: 'VIDEO_CONFIG',
          files: [],
        }),
        working({
          id: 'source',
          nodeId: 'SOURCE_IMPORT:product1',
          type: 'SOURCE_MATERIAL',
          files: [{ ...file('source', 'DOWNLOAD'), originalFileName: '资料.docx' }],
        }),
      ],
      [asset({ sourceNode: 'FINAL_OUTPUT' }), asset({ id: 'unknown', sourceNode: null })],
      scope,
    );
    expect(EFFECT_ASSET_NODES.map((node) => node.label)).toEqual([
      '产品资料',
      '产品信息',
      '素材提示词',
      '视频素材',
      '最终成片',
    ]);
    expect(EFFECT_ASSET_NODES.some((node) => String(node.value) === 'TEMPLATE_MIX')).toBe(false);
    expect(filterBrowserAssetsByNode(rows, 'SEGMENT_RENDER').map((row) => row.id)).toEqual([
      'working:w1:v1',
      'working:settings',
    ]);
    expect(filterBrowserAssetsByNode(rows, 'SOURCE_IMPORT')).toHaveLength(1);
    expect(filterBrowserAssetsByNode(rows, 'FINAL_OUTPUT')).toHaveLength(1);
    expect(browserAssetNodeId(rows.at(-1)!)).toBe(UNKNOWN_ASSET_NODE);
    expect(filterBrowserAssetsByNode(rows, UNKNOWN_ASSET_NODE)).toHaveLength(1);
    expect(
      filterBrowserAssets(
        filterBrowserAssetsByNode(rows, 'SOURCE_IMPORT'),
        'ALL',
        '已保存素材',
        'recent',
      ),
    ).toEqual([]);
  });
  it('hides all mix assets including templates without changing the inputs or final videos', () => {
    const source = [
      working({
        id: 'timeline',
        type: 'TIMELINE_PROJECT',
        artifactKey: 'timeline-project:t:v',
        nodeId: 'TEMPLATE_MIX',
        files: [],
      }),
      working({
        id: 'package',
        artifactKey: 'timeline-package:t:v',
        nodeId: 'TEMPLATE_MIX',
        files: [],
      }),
      working({
        id: 'template',
        type: 'MIX_TEMPLATE',
        artifactKey: 'mix-template:t',
        nodeId: 'TEMPLATE_MIX',
        files: [],
      }),
      working({
        id: 'output',
        type: 'FINAL_VIDEO',
        nodeId: 'FINAL_OUTPUT',
        files: [file('final')],
      }),
    ];
    const rows = buildBrowserAssets(
      source,
      [
        asset({ type: 'TIMELINE_PROJECT' }),
        asset({ id: 'editor', type: 'EDITING_PROJECT', sourceNode: 'TEMPLATE_MIX' }),
        asset({ id: 'template-asset', type: 'MIX_TEMPLATE', sourceNode: null }),
        asset({ id: 'mix-video', type: 'VIDEO_MATERIAL', sourceNode: 'TEMPLATE_MIX' }),
        asset({ id: 'final-asset', type: 'FINAL_VIDEO', sourceNode: 'FINAL_OUTPUT' }),
      ],
      scope,
    );
    expect(rows.map((row) => row.id)).toEqual(['working:output:final', 'project:final-asset']);
    expect(filterBrowserAssetsByNode(rows, 'TEMPLATE_MIX')).toHaveLength(0);
    expect(filterBrowserAssetsByNode(rows, UNKNOWN_ASSET_NODE)).toHaveLength(0);
    expect(filterBrowserAssetsByNode(rows, 'FINAL_OUTPUT')).toHaveLength(2);
    expect(source).toHaveLength(4);
  });
  it('does not remove editing projects belonging to other workflows', () => {
    const rows = buildBrowserAssets(
      [working({ type: 'EDITING_PROJECT', nodeId: 'SHOT_RENDER' })],
      [],
      { ...scope, workflow: 'CUSTOMIZED', space: 'CUSTOMIZED_PROJECT' },
    );
    expect(rows).toHaveLength(1);
  });
  it('does not deduplicate the same file across different source nodes', () => {
    const rows = buildBrowserAssets(
      [working(), working({ id: 'other-node', nodeId: 'FINAL_OUTPUT' })],
      [],
      scope,
    );
    expect(rows).toHaveLength(2);
    expect(filterBrowserAssetsByNode(rows, 'SEGMENT_RENDER')).toHaveLength(1);
    expect(filterBrowserAssetsByNode(rows, 'FINAL_OUTPUT')).toHaveLength(1);
  });
});
