import { describe, expect, it } from 'vitest';

import assetDrawerSource from './AssetDrawer.vue?raw';
import assetPreviewSource from './components/AssetPreview.vue?raw';
import projectWorkspaceOverviewSource from './components/ProjectWorkspaceOverview.vue?raw';
import projectAssetBrowserSource from './components/ProjectAssetBrowser.vue?raw';
import {
  isImageFileAsset,
  isCurrentOnlyEffectImportAsset,
  projectMatchesSpace,
  projectMatchesWorkflow,
  typeLabel,
  typesForSpace,
  uploadAccept,
  videoConfigFields,
} from './asset-v4';

describe('V4 asset center mapping', () => {
  it('matches the system blue-white palette without changing the library layout', () => {
    expect(assetDrawerSource).toContain('background: #f8faff;');
    expect(assetDrawerSource).toContain('background: #eaf1ff;');
    expect(assetDrawerSource).toContain('color: #17263f;');
    expect(assetDrawerSource).not.toContain('background: #f7f7f6;');
    expect(projectAssetBrowserSource).toContain('border-bottom-color: #2563eb;');
    expect(projectAssetBrowserSource).toContain('.asset-tile:hover:not(.selected)');
    expect(projectAssetBrowserSource).toContain('.asset-search:focus-within');
    expect(projectAssetBrowserSource).not.toContain('background: #fafafa;');
  });
  it('shows effect source-node tabs instead of mixed media categories', () => {
    expect(projectAssetBrowserSource).toContain("'来源节点'");
    expect(projectAssetBrowserSource).toContain('filterBrowserAssetsByNode');
    expect(projectAssetBrowserSource).toContain('selectedTab === option.value');
    expect(projectAssetBrowserSource).toContain('selectTab(option.value)');
    expect(projectAssetBrowserSource).not.toContain('v-for="option in ASSET_CATEGORIES"');
    expect(projectAssetBrowserSource).toContain('selectedId.value = null');
  });
  it('opens the project library without a separate current-project sidebar entry', () => {
    expect(assetDrawerSource).not.toContain('AssetCenterView');
    expect(assetDrawerSource).not.toContain('@click="view = \'current\'"');
    expect(assetDrawerSource).not.toContain('class="nav-current"');
    expect(assetDrawerSource).not.toContain('class="nav-section-label"');
    expect(assetDrawerSource).toContain('@click="enterProject(project)"');
    expect(assetDrawerSource).toContain('class="project-row"');
    expect(assetDrawerSource).toContain('enterProject(response.data)');
    expect(assetDrawerSource).not.toContain("view.value = 'current'");
    expect(assetDrawerSource).toContain('@click="backToProjects"');
    expect(assetDrawerSource).not.toContain('globalProjectKeyword');
    expect(assetDrawerSource).toContain('workflow: workflow.value, space: space.value');
  });

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
    expect(projectMatchesWorkflow(project, 'EFFECT')).toBe(true);
    expect(projectMatchesWorkflow(project, 'CUSTOMIZED')).toBe(false);
    expect(projectMatchesWorkflow(project, 'FISSION')).toBe(true);
  });

  it('recognizes an empty digital-human project as a fission workflow project', () => {
    const project = {
      id: 'avatar-project',
      name: '口播项目',
      description: null,
      status: 'ACTIVE' as const,
      createdAt: '',
      updatedAt: '',
      workflowSpaces: {
        effect: false,
        customized: false,
        fission: { clone: false, avatar: true, localReplace: false },
      },
    };
    expect(projectMatchesSpace(project, 'FISSION_AVATAR')).toBe(true);
    expect(projectMatchesWorkflow(project, 'FISSION')).toBe(true);
    expect(projectMatchesWorkflow(project, 'CUSTOMIZED')).toBe(false);
  });

  it('keeps a project bound when it explicitly supports both workflows', () => {
    const project = {
      id: 'shared-project',
      name: '跨工作流项目',
      description: null,
      status: 'ACTIVE' as const,
      createdAt: '',
      updatedAt: '',
      workflowSpaces: {
        effect: true,
        customized: true,
        fission: { clone: false, avatar: false, localReplace: false },
      },
    };
    expect(projectMatchesWorkflow(project, 'EFFECT')).toBe(true);
    expect(projectMatchesWorkflow(project, 'CUSTOMIZED')).toBe(true);
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
    expect(projectAssetBrowserSource).toContain('!isCurrentOnlyEffectImportAsset(projectAsset)');
    expect(assetDrawerSource).not.toContain('workingArtifactAsAsset');
    expect(projectWorkspaceOverviewSource).toContain('artifact.mainPreviewUrl');
    expect(projectWorkspaceOverviewSource).toContain('artifact.revision');
    expect(projectWorkspaceOverviewSource).toContain(
      "artifact.artifactKey.startsWith('source-package:')",
    );
    expect(projectWorkspaceOverviewSource).toContain('草稿已保存');
    expect(projectWorkspaceOverviewSource).toContain("artifact.freshness === 'STALE'");
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
    expect(projectAssetBrowserSource).toContain('assetTextFields(selected.value)');
  });

  it('isolates project assets and working copies by workflow, space and run', () => {
    expect(projectAssetBrowserSource).toContain(
      'workflow: scope.workflow, space: scope.space, workflowRunId: runId',
    );
    expect(projectAssetBrowserSource).toContain(
      'workflow: scope.workflow, space: scope.space, page: next',
    );
  });

  it('enters assets directly instead of a workspace overview', () => {
    expect(assetDrawerSource).toMatch(/<ProjectAssetBrowser\s+v-if="selectedProject"/);
    expect(assetDrawerSource).not.toContain('ProjectWorkspaceOverview');
    expect(projectAssetBrowserSource).toContain('props.currentProject?.id === props.project.id');
    expect(projectWorkspaceOverviewSource).toContain('工作流草稿');
    expect(projectWorkspaceOverviewSource).toContain('工作区产物');
    expect(projectWorkspaceOverviewSource).not.toContain('已归档资产');
    expect(projectWorkspaceOverviewSource).not.toContain('全局发布资产');
    expect(projectWorkspaceOverviewSource).not.toContain('archived-panel');
    expect(projectWorkspaceOverviewSource).not.toContain('global-panel');
    expect(projectWorkspaceOverviewSource).not.toContain('listAssets');
    expect(projectWorkspaceOverviewSource).not.toContain('listAssetVersions');
    expect(projectWorkspaceOverviewSource).toContain('只有当前绑定项目可以直接返回节点继续编辑');
    expect(projectWorkspaceOverviewSource).toContain('visibleArtifacts.length');
    expect(projectWorkspaceOverviewSource).toContain('进入素材池');
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

  it('derives final-output status from rendered video artifacts, not only saved node drafts', () => {
    expect(projectWorkspaceOverviewSource).toContain('finalVideoArtifactCounts(artifacts.value)');
    expect(projectWorkspaceOverviewSource).toContain("definition.id === 'FINAL_OUTPUT'");
    expect(projectWorkspaceOverviewSource).toContain("return '已完成'");
    expect(projectWorkspaceOverviewSource).toContain("return '待更新'");
    expect(projectWorkspaceOverviewSource).toContain('已渲染 ${completed}/${total} 条成片');
  });
});
