import { describe, expect, it } from 'vitest';

import assetDrawerSource from './AssetDrawer.vue?raw';
import assetPreviewSource from './components/AssetPreview.vue?raw';
import projectWorkspaceOverviewSource from './components/ProjectWorkspaceOverview.vue?raw';
import {
  isImageFileAsset,
  isCurrentOnlyEffectImportAsset,
  projectMatchesSpace,
  typeLabel,
  typesForSpace,
  uploadAccept,
  videoConfigFields,
} from './asset-v4';

describe('V4 asset center mapping', () => {
  it('keeps the frozen type order for each workflow space', () => {
    expect(typesForSpace('FISSION_LOCAL_REPLACE').slice(0, 3)).toEqual([
      'SOURCE_VIDEO',
      'REPLACEMENT_CONFIGURATION',
      'ANALYSIS_QUALITY_REPORT',
    ]);
    expect(typesForSpace('CUSTOMIZED_VOICE_LIBRARY')).toEqual(['VOICE_PROFILE']);
  });

  it('restricts a project card to its declared workflow space', () => {
    const project = {
      id: 'project-1',
      name: '项目',
      description: null,
      status: 'ACTIVE' as const,
      createdAt: '',
      updatedAt: '',
      workflowSpaces: {
        effect: true,
        customized: false,
        fission: { clone: true, avatar: false, localReplace: false },
      },
    };
    expect(projectMatchesSpace(project, 'EFFECT')).toBe(true);
    expect(projectMatchesSpace(project, 'FISSION_CLONE')).toBe(true);
    expect(projectMatchesSpace(project, 'CUSTOMIZED_PROJECT')).toBe(false);
  });

  it('maps selected upload types to an appropriate file picker accept value', () => {
    expect(uploadAccept('REFERENCE_VIDEO')).toBe('video/*');
    expect(uploadAccept('VOICE_PROFILE')).toBe('audio/*');
    expect(uploadAccept('SUBTITLE')).toContain('.srt');
  });

  it('always renders a visible label for expanded V4 asset types', () => {
    expect(typeLabel('VIDEO_CONFIG')).toBe('视频配置');
    expect(typeLabel('INSIGHT_RESULT')).toBe('提炼结果');
  });

  it('uses file preview metadata so image source materials render as images', () => {
    expect(isImageFileAsset({ hasFile: true, previewKind: 'IMAGE' })).toBe(true);
    expect(isImageFileAsset({ hasFile: true, previewKind: 'DOWNLOAD' })).toBe(false);
    expect(isImageFileAsset({ hasFile: false, previewKind: 'IMAGE' })).toBe(false);
    expect(assetPreviewSource).toContain('v-if="isImageFile"');
    expect(assetPreviewSource).toContain(':src="asset.contentUrl"');
    expect(assetPreviewSource).toContain('图片暂不可预览');
  });

  it('marks effect source-import assets as current-only and hides version controls', () => {
    expect(
      isCurrentOnlyEffectImportAsset({
        storageWorkflow: 'EFFECT',
        workflowSpace: 'EFFECT',
        sourceNode: 'SOURCE_IMPORT',
      }),
    ).toBe(true);
    expect(
      isCurrentOnlyEffectImportAsset({
        storageWorkflow: 'EFFECT',
        workflowSpace: 'EFFECT',
        sourceNode: 'PROMPT',
      }),
    ).toBe(false);
    expect(assetDrawerSource).toContain(
      "view !== 'current' && !isCurrentOnlyEffectImportAsset(asset)",
    );
    expect(assetDrawerSource).not.toContain('workingArtifactAsAsset');
    expect(assetDrawerSource).toContain(
      'Do not adapt working copies into fake ProjectAsset records',
    );
    expect(projectWorkspaceOverviewSource).toContain('artifact.mainPreviewUrl');
    expect(projectWorkspaceOverviewSource).toContain('artifact.revision');
    expect(projectWorkspaceOverviewSource).toContain("artifact.freshness === 'STALE'");
    expect(assetDrawerSource).toContain('v-else-if="!currentOnlyDetail"');
    expect(assetPreviewSource).toContain('v-if="!isCurrentOnly"');
  });

  it('presents persisted video configuration fields in cards and asset details', () => {
    expect(
      videoConfigFields({
        type: 'VIDEO_CONFIG',
        businessData: null,
        content: {
          durationSeconds: 50,
          aspectRatio: '9:16',
          resolution: '1080P',
          frameRate: 30,
          styleTone: '烟火食欲感',
          deliveryChannel: '抖音',
          subtitleStrategy: '跟随口播',
          voiceoverStrategy: 'AI 女声',
          bgmStrategy: '自动匹配',
          disabledElements: ['世界第一'],
        },
      }),
    ).toEqual([
      { key: 'durationSeconds', label: '视频时长', value: '50 秒' },
      { key: 'aspectRatio', label: '画幅比例', value: '9:16' },
      { key: 'styleTone', label: '风格基调', value: '烟火食欲感' },
      { key: 'deliveryChannel', label: '投放渠道', value: '抖音' },
      { key: 'disabledElements', label: '禁用元素', value: '世界第一' },
    ]);
    expect(assetPreviewSource).toContain('v-else-if="isVideoConfig"');
    expect(assetPreviewSource).toContain('previewConfigFields');
    expect(assetDrawerSource).toContain('视频配置详情');
    expect(assetDrawerSource).toContain('detailVideoConfigFields');
  });

  it('isolates effect source assets by a product-name selector backed by product id', () => {
    expect(assetDrawerSource).toContain('按产品隔离');
    expect(assetDrawerSource).toContain('aria-label="按产品名称筛选资产"');
    expect(assetDrawerSource).toContain(
      '...(productId.value ? { productId: productId.value } : {})',
    );
  });

  it('separates project drafts, working artifacts, archived assets and global publication', () => {
    expect(assetDrawerSource).toContain('v-if="activeProject"');
    expect(assetDrawerSource).toContain(':can-resume="activeProject.id === currentProject?.id"');
    expect(projectWorkspaceOverviewSource).toContain('工作流草稿');
    expect(projectWorkspaceOverviewSource).toContain('工作区产物');
    expect(projectWorkspaceOverviewSource).toContain('已归档资产');
    expect(projectWorkspaceOverviewSource).toContain('全局发布资产');
    expect(projectWorkspaceOverviewSource).toContain('尚未实现“完成工作流并归档”');
    expect(projectWorkspaceOverviewSource).toContain('全局发布能力暂未实现');
    expect(projectWorkspaceOverviewSource).toContain('只有当前绑定项目可以直接返回节点继续编辑');
    expect(projectWorkspaceOverviewSource).toContain('pageSize: 96');
    expect(projectWorkspaceOverviewSource).not.toContain('pageSize: 100');
    expect(projectWorkspaceOverviewSource).not.toContain('保存到项目资产库');
  });

  it('highlights only the workflow node that is currently being edited', () => {
    expect(projectWorkspaceOverviewSource).toContain(
      ':class="{ active: definition.id === activeNodeId }"',
    );
    expect(projectWorkspaceOverviewSource).toContain(
      ':aria-current="definition.id === activeNodeId ? \'step\' : undefined"',
    );
    expect(projectWorkspaceOverviewSource).not.toContain('definition.id === latestState?.nodeId');
    expect(projectWorkspaceOverviewSource).toContain('.draft-list button.active');
  });
});
