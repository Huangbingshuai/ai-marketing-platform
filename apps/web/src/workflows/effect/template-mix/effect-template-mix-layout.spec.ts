import { describe, expect, it } from 'vitest';
import workflowSource from '../source-import/EffectImportNodePage.vue?raw';
import pageSource from './EffectTemplateMixNodePage.vue?raw';

describe('effect template mix workbench layout', () => {
  it('mounts in the fifth workflow step', () => {
    expect(workflowSource).toContain(
      "import EffectTemplateMixNodePage from '../template-mix/EffectTemplateMixNodePage.vue'",
    );
    expect(workflowSource).toContain('v-else-if="activeStep === 4"');
  });
  it('uses the real draft, material and validation API', () => {
    expect(pageSource).toContain("from './api/effect-template-mix.api'");
    expect(pageSource).toContain('loadEffectTemplateMixWorkspace');
    expect(pageSource).toContain('saveEffectTemplateMixDraft');
    expect(pageSource).toContain('validateEffectTemplateMix');
    expect(pageSource).not.toMatch(/Mock|MOCK|createEffectTemplateMixMock/u);
  });
  it('keeps configuration and refinement as separate views', () => {
    expect(pageSource).toContain('进入精修工作台');
    expect(pageSource).toContain('返回模板配置');
    expect(pageSource).toContain('成片精修工作台');
    expect(pageSource).toContain('音频轨');
    expect(pageSource).toContain('字幕轨');
    expect(pageSource).toContain('BGM 轨');
    expect(pageSource).not.toContain('初次生成数量');
  });
  it('renders loading, empty, error and real-media states', () => {
    expect(pageSource).toContain("pageState === 'LOADING'");
    expect(pageSource).toContain("pageState === 'ERROR'");
    expect(pageSource).toContain('还没有混剪模板');
    expect(pageSource).toContain(':src="selectedMaterial.contentUrl"');
  });
});
