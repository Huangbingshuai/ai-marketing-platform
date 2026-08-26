import { describe, expect, it } from 'vitest';

import pageSource from './EffectImportNodePage.vue?raw';
import manifestDialogSource from './components/BatchManifestImportDialog.vue?raw';
import globalConfigSource from './components/GlobalVideoConfigPanel.vue?raw';
import productEditorSource from './components/ProductImportEditor.vue?raw';
import { EFFECT_IMPORT_PROTOTYPE_STYLE_TONES } from './effect-import-options';

describe('effect import single-product prototype grid', () => {
  it('creates an upload target automatically instead of showing an empty-state gate', () => {
    expect(pageSource).toContain('await ensureUploadTarget()');
    expect(pageSource).not.toContain('尚未创建单产品资料包');
    expect(pageSource).not.toContain('开始填写产品资料');
    expect(pageSource).not.toContain('批量草稿还是空的');
    expect(pageSource).not.toContain('>导入产品清单</button>');
    expect(pageSource).toContain('正在准备素材上传区…');
  });

  it('offers a lightweight 24-hour restore entry without adding a manual asset action', () => {
    expect(pageSource).toContain('最近删除');
    expect(pageSource).toContain('24 小时内可恢复');
    expect(pageSource).toContain('restoreEffectImportProduct');
    expect(pageSource).not.toContain('保存到项目资产库');
  });

  it('downloads the standard Word product-package template from the header action', () => {
    expect(pageSource).toContain('@click="downloadProductPackageTemplate"');
    expect(pageSource).toContain('downloadEffectProductPackageTemplate(');
    expect(pageSource).toContain('Word 资料包模板已下载');
    expect(pageSource).not.toContain('@click="downloadTemplate(\'csv\')"');
  });

  it('keeps upload and global configuration in the same stretched first row', () => {
    expect(pageSource).toMatch(
      /\.import-layout:not\(\.batch-mode\)[\s\S]*:deep\(\.upload-source-card\)[\s\S]*grid-column:\s*1;[\s\S]*grid-row:\s*1;/,
    );
    expect(pageSource).toMatch(
      />\s*:deep\(\.global-config-card\)[\s\S]*align-self:\s*stretch;[\s\S]*grid-column:\s*2;[\s\S]*grid-row:\s*1;/,
    );
  });

  it('places commerce parsing and imported materials across both columns below row one', () => {
    expect(pageSource).toMatch(
      /:deep\(\.commerce-parse\)[\s\S]*grid-column:\s*1\s*\/\s*-1;[\s\S]*grid-row:\s*2;/,
    );
    expect(pageSource).toMatch(
      /:deep\(\.imported-materials\)[\s\S]*grid-column:\s*1\s*\/\s*-1;[\s\S]*grid-row:\s*3;/,
    );
  });

  it('aligns the mode switch with the cards and lets the upload zone consume available height', () => {
    expect(pageSource).toMatch(/\.import-mode-segment\s*\{[\s\S]*margin:\s*0 0 16px;/);
    expect(productEditorSource).toMatch(
      /\.upload-source-card\s*\{[\s\S]*display:\s*flex;[\s\S]*flex-direction:\s*column;/,
    );
    expect(productEditorSource).toMatch(
      /\.source-dropzone\s*\{[\s\S]*min-height:\s*160px;[\s\S]*flex:\s*1;/,
    );
  });

  it('keeps native file controls structurally hidden while switching modes', () => {
    expect(productEditorSource.match(/type="file"\s+hidden/g)).toHaveLength(2);
    expect(productEditorSource).toMatch(
      /\.source-dropzone input\[type='file'\]\s*\{[\s\S]*display:\s*none !important;/,
    );
  });
});

describe('effect import prototype video configuration', () => {
  it('shows only the five fields confirmed by the prototype', () => {
    for (const label of ['视频时长', '画幅比例', '风格基调', '投放渠道', '禁用元素']) {
      expect(globalConfigSource).toContain(label);
    }
    for (const removed of ['分辨率', '帧率', '字幕策略', '口播策略', 'BGM 策略']) {
      expect(globalConfigSource).not.toContain(removed);
    }
    expect(pageSource).not.toContain('ProductConfigOverrideDialog');
    expect(productEditorSource).not.toContain('单品覆盖配置');
  });

  it('uses the exact frozen-prototype style tone options in the frontend', () => {
    expect(EFFECT_IMPORT_PROTOTYPE_STYLE_TONES).toEqual([
      '烟火食欲感',
      '高端电影感',
      '自然电影感',
      '户外电影感',
      '清透冰感',
      '居家纪实',
      '香槟金电影感',
      '专业测评感',
      '温馨生活感',
      '国潮新中式',
      '清新田园',
      '复古胶片',
      '赛博霓虹',
      '极简商务',
      '治愈暖光',
      '夜景氛围',
    ]);
  });
});

describe('effect import identity boundary', () => {
  it('requires a product name in both single and batch editors while leaving category to AI', () => {
    expect(productEditorSource.match(/placeholder="请输入产品名称"/g)).toHaveLength(2);
    expect(productEditorSource).toContain("changeField('name', $event)");
    expect(productEditorSource).toContain(':aria-invalid="!product.name.trim()"');
    expect(productEditorSource).toContain('请先填写产品名称，再上传产品资料');
    expect(productEditorSource).toContain(':disabled="uploadDisabled"');
    expect(productEditorSource).not.toContain('品类');
    expect(manifestDialogSource).not.toContain('<th>产品名称</th>');
    expect(manifestDialogSource).not.toContain('<th>品类</th>');
  });

  it('keeps next-step access locked and places whole-node validation beside next step', () => {
    expect(pageSource).toContain('const unnamedProductCount = computed(');
    expect(pageSource).toMatch(
      /const validatedCurrentRevision[\s\S]*unnamedProductCount\.value === 0/,
    );
    expect(pageSource).toContain('validateEffectImportDraft(');
    expect(pageSource).toContain('<WorkflowNodeDraftBar');
    expect(pageSource).toContain('title="产品资料与视频配置草稿"');
    expect(pageSource).toContain('<WorkflowNodeFooter');
    expect(pageSource).toContain('next-label="下一步：AI 信息提炼"');
    expect(pageSource).toContain('@validate="validateDraft"');
    expect(pageSource).toContain('@next="advanceDraft"');
    expect(productEditorSource).not.toContain('完成校验');
    expect(pageSource).toContain('个产品未填写名称');
  });
});

describe('effect import material previews', () => {
  it('renders product images from the project-scoped content URL instead of an extension badge', () => {
    expect(productEditorSource).toContain("material.type === 'PRODUCT_IMAGE'");
    expect(productEditorSource).toContain(':src="thumbnailUrl(material)!"');
    expect(productEditorSource).toContain('@error="markThumbnailFailed(material.id)"');
    expect(productEditorSource).toMatch(/v-else class="file-extension"/);
  });
});

describe('effect import commerce link placeholder', () => {
  it('validates and saves the link into the current product package without claiming to parse it', () => {
    expect(productEditorSource).toContain('当前仅校验链接格式并保存到资料包，暂不抓取页面内容');
    expect(productEditorSource).toContain(
      ':disabled="disabled || linkBusy || !product.commerceUrl?.trim()"',
    );
    expect(productEditorSource).toContain("{{ linkBusy ? '正在保存…' : '解析链接' }}");
    expect(pageSource).toContain('busyCommerceProductIds.value.has(product.id)');
    expect(pageSource).toContain('if (!(await flushProduct(product.id))) return;');
    expect(pageSource).toContain('电商链接已保存到当前商品资料包，暂未解析页面内容');
  });

  it('renders a saved commerce URL as an imported package item', () => {
    expect(productEditorSource).toContain('const importedItemCount = computed(');
    expect(productEditorSource).toContain('{{ importedItemCount }} 项资料');
    expect(productEditorSource).toContain('v-if="savedCommerceUrl"');
    expect(productEditorSource).toContain('<strong>电商商品链接</strong>');
    expect(productEditorSource).toContain(
      '<small :title="savedCommerceUrl">{{ savedCommerceUrl }}</small>',
    );
    expect(productEditorSource).toContain("{{ linkBusy ? '保存中' : '已保存' }}");
  });

  it('supports replacing and deleting the saved commerce URL', () => {
    expect(productEditorSource).toContain('const replaceCommerceLink = (): void => {');
    expect(productEditorSource).toContain('commerceInput.value?.select()');
    expect(productEditorSource).toContain('title="重新填写电商链接"');
    expect(productEditorSource).toContain('aria-label="删除电商链接"');
    expect(productEditorSource).toContain("emit('deleteLink', product)");
    expect(pageSource).toContain('const removeCommerceLink = async');
    expect(pageSource).toContain('{ commerceUrl: null, expectedRevision }');
    expect(pageSource).toContain('@delete-link="removeCommerceLink"');
  });
});

describe('effect import automatic draft saving', () => {
  it('activates the selected workflow node independently from node draft persistence', () => {
    expect(pageSource).toContain('activateWorkflowNode(');
    expect(pageSource).toContain('getActiveWorkflowRunOverview(');
    expect(pageSource).toContain('workflowNodeBaseId(overview.data.run?.currentNodeId)');
    expect(pageSource).toContain("'INFORMATION_EXTRACTION'");
    expect(pageSource).toContain('effectWorkflowNodeIds[step]');
    expect(pageSource).toContain('effectWorkflowNodeIds[activeStep.value]');
  });

  it('debounces node-state saving and removes node-level asset publishing', () => {
    expect(pageSource).toContain('putWorkflowNodeState(');
    expect(pageSource).toContain('setTimeout(() => void flushProduct(productId), 1000)');
    expect(pageSource).toContain('defineExpose({');
    expect(pageSource).toContain('flushPendingEdits,');
    expect(pageSource).toContain('resumeWorkflowNode,');
    expect(pageSource).toContain(
      "workflowRunId: computed(() => workspace.value?.workflowRunId ?? '')",
    );
    expect(pageSource).not.toContain('publishEffectImportDraft');
    expect(pageSource).not.toContain('asset-publish-bar');
    expect(pageSource).not.toContain('保存到项目资产库');
  });

  it('preserves the node-state revision when an edit only relocks downstream nodes', () => {
    const relockSource = pageSource.match(
      /const relockDownstreamNode = \(\): void => \{[\s\S]*?\n\};/,
    )?.[0];

    expect(relockSource).toBeDefined();
    expect(relockSource).not.toContain('nodeStateRevision.value = 0');
    expect(relockSource).not.toContain("lastSavedNodeState = ''");
    expect(pageSource).toMatch(
      /const loadProject = async[\s\S]*nodeStateRevision\.value = 0;[\s\S]*lastSavedNodeState = '';/,
    );
  });

  it('serializes node-state writes with the existing project write queue', () => {
    expect(pageSource).toContain(
      'return keepalive ? persist() : writeQueue.enqueue(projectId, persist)',
    );
    expect(pageSource).toContain('if (serialized === lastSavedNodeState) return true;');
  });
});
