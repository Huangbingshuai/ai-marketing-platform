import { describe, expect, it } from 'vitest';

import pageSource from './EffectImportNodePage.vue?raw';
import manifestDialogSource from './components/BatchManifestImportDialog.vue?raw';
import globalConfigSource from './components/GlobalVideoConfigPanel.vue?raw';
import productEditorSource from './components/ProductImportEditor.vue?raw';
import overrideDialogSource from './components/ProductConfigOverrideDialog.vue?raw';
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
      expect(overrideDialogSource).toContain(label);
    }
    for (const removed of ['分辨率', '帧率', '字幕策略', '口播策略', 'BGM 策略']) {
      expect(globalConfigSource).not.toContain(removed);
      expect(overrideDialogSource).not.toContain(removed);
    }
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

  it('keeps validation and next-step access locked until every product has a name', () => {
    expect(pageSource).toContain('const unnamedProductCount = computed(');
    expect(pageSource).toMatch(
      /const validatedCurrentRevision[\s\S]*unnamedProductCount\.value === 0/,
    );
    expect(pageSource.match(/if \(unnamedProductCount\.value\)/g)).toHaveLength(1);
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

describe('effect import automatic draft saving', () => {
  it('debounces node-state saving and removes node-level asset publishing', () => {
    expect(pageSource).toContain('putWorkflowNodeState(');
    expect(pageSource).toContain('setTimeout(() => void flushProduct(productId), 1000)');
    expect(pageSource).toContain('defineExpose({ flushPendingEdits })');
    expect(pageSource).not.toContain('publishEffectImportDraft');
    expect(pageSource).not.toContain('asset-publish-bar');
    expect(pageSource).not.toContain('保存到项目资产库');
  });
});
