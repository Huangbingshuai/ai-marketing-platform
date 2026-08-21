import { describe, expect, it } from 'vitest';

import pageSource from './EffectImportNodePage.vue?raw';
import manifestDialogSource from './components/BatchManifestImportDialog.vue?raw';
import globalConfigSource from './components/GlobalVideoConfigPanel.vue?raw';
import productEditorSource from './components/ProductImportEditor.vue?raw';
import overrideDialogSource from './components/ProductConfigOverrideDialog.vue?raw';
import { EFFECT_IMPORT_PROTOTYPE_STYLE_TONES } from './effect-import-options';

describe('effect import single-product prototype grid', () => {
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
  it('leaves product name and category extraction to the next AI node', () => {
    expect(productEditorSource).not.toContain('产品名称');
    expect(productEditorSource).not.toContain('品类');
    expect(manifestDialogSource).not.toContain('<th>产品名称</th>');
    expect(manifestDialogSource).not.toContain('<th>品类</th>');
  });
});
