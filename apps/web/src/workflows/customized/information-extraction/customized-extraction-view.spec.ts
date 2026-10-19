import { describe, expect, it, vi } from 'vitest';
import mammoth from 'mammoth';
import { createSSRApp, reactive } from 'vue';
import { renderToString } from 'vue/server-renderer';
import CustomizedInfoExtractionNodePage from './CustomizedInfoExtractionNodePage.vue';
import {
  customizedExtractionEditable,
  customizedExtractionReady,
  emptyCustomizedExtractionView,
  snapshotCustomizedFields,
} from './customized-extraction-view';

describe('customized extraction confirmation boundary', () => {
  it('saves an independent plain snapshot after a reactive card edit', () => {
    const original = reactive(emptyCustomizedExtractionView().fields);
    original.sellingPoints.push('独立卖点');
    const edited = reactive({ ...original, brandName: '梅间' });
    const snapshot = snapshotCustomizedFields(edited);
    expect(structuredClone(snapshot)).toEqual({ ...snapshot, sellingPoints: ['独立卖点'] });
    edited.sellingPoints[0] = '后续修改';
    expect(snapshot.sellingPoints).toEqual(['独立卖点']);
  });
  it('creates independent empty views without invented results', () => {
    const first = emptyCustomizedExtractionView();
    first.fields.brandName = '人工品牌';
    first.fields.productName = '人工产品';
    first.fields.productDescription = '青梅风味调味酱';
    first.fields.productSpecifications = '200 g，单瓶装';
    first.fields.productAppearance = '包装待确认';
    first.fields.avoidedElements = '不出现未确认的功效';
    first.fields.sellingPoints.push('独立卖点');
    const second = emptyCustomizedExtractionView();
    expect(
      Object.entries(second.fields)
        .filter(([key]) => key !== 'sellingPoints')
        .every(([, value]) => value === ''),
    ).toBe(true);
    expect(second.fields.sellingPoints).toEqual([]);
    expect(second.committed).toBe(false);
  });
  it('does not enable downstream from a successful but unconfirmed result', () => {
    const view = { ...emptyCustomizedExtractionView(), status: 'COMPLETED' as const };
    expect(customizedExtractionReady(view, true, true)).toBe(false);
    expect(customizedExtractionReady({ ...view, committed: true }, true, true)).toBe(true);
  });
  it.each(['EMPTY', 'QUEUED', 'RUNNING', 'FAILED', 'PARTIAL', 'STALE'] as const)(
    'blocks downstream for %s even with an older confirmed result',
    (status) => {
      const view = { ...emptyCustomizedExtractionView(), status, committed: true };
      expect(customizedExtractionReady(view, true, true)).toBe(false);
    },
  );
  it('blocks disabled services, unconfirmed sources, isolated edits, saves and unresolved blocking conflicts', () => {
    const view = {
      ...emptyCustomizedExtractionView(),
      status: 'COMPLETED' as const,
      committed: true,
    };
    expect(customizedExtractionReady(view, false, true)).toBe(false);
    expect(customizedExtractionReady(view, true, false)).toBe(false);
    expect(customizedExtractionReady({ ...view, editing: true }, true, true)).toBe(false);
    expect(customizedExtractionReady({ ...view, saving: true }, true, true)).toBe(false);
    const issue = {
      id: 'conflict',
      field: 'productSpecifications' as const,
      alternatives: ['200 g', '250 g'],
      sourceIds: ['a', 'b'],
      message: '产品规格不一致',
      blocking: true,
    };
    expect(customizedExtractionReady({ ...view, issues: [issue] }, true, true)).toBe(false);
    expect(
      customizedExtractionReady({ ...view, issues: [{ ...issue, blocking: false }] }, true, true),
    ).toBe(true);
  });
  it('allows edits only in a ready isolated view, never while running or without sources', () => {
    const view = {
      ...emptyCustomizedExtractionView(),
      status: 'COMPLETED' as const,
      editing: true,
    };
    expect(customizedExtractionEditable(view, true, true)).toBe(true);
    expect(customizedExtractionEditable({ ...view, status: 'STALE' }, true, true)).toBe(true);
    expect(customizedExtractionEditable({ ...view, status: 'RUNNING' }, true, true)).toBe(false);
    expect(customizedExtractionEditable(view, false, true)).toBe(false);
    expect(customizedExtractionEditable(view, true, false)).toBe(false);
    expect(customizedExtractionEditable({ ...view, saving: true }, true, true)).toBe(false);
  });
});

describe('customized extraction presentation', () => {
  const props = {
    projectId: 'test-project',
    workflowRunId: 'test-run',
    sourceConfirmed: true,
    sources: [],
  };
  it('renders the two actual information cards before backend integration without inventing a result', async () => {
    const html = await renderToString(createSSRApp(CustomizedInfoExtractionNodePage, props));
    for (const title of ['品牌基础信息', '产品核心信息']) expect(html).toContain(title);
    expect(html).toContain('AI 提炼功能待接入');
    expect(html).toContain('下一步：脚本创作');
    expect(html).toContain('确认后用于脚本创作');
    expect(html).toContain('readonly');
    expect(html).not.toContain('客户');
    for (const removed of [
      '声音形式',
      '文案安排',
      '配乐或音效偏好',
      '交付内容与数量',
      '必须包含的元素',
      '已有的创意或故事',
      '产品特点与事实',
      '核心传播信息',
      '视频用途',
      '发布渠道',
      '创意方向',
      '创作偏好',
      '视觉风格偏好',
      '主色调偏好',
      '情绪偏好',
      '品牌规范',
      '使用方式',
      '品牌调性约束',
      '视频规格',
      '视频时长',
      '视频分辨率',
      '视频画幅',
      '视频格式',
    ])
      expect(html).not.toContain(removed);
  });
  it('matches the downloaded Word template sections and every field in order', async () => {
    const { readFile } = await vi.importActual<{
      readFile(
        path: URL,
      ): Promise<
        Extract<Parameters<typeof mammoth.convertToHtml>[0], { buffer: unknown }>['buffer']
      >;
    }>('node:fs/promises');
    const buffer = await readFile(
      new URL(
        '../../../../../../docs/workflows/customized/templates/视频创作简报模板.docx',
        import.meta.url,
      ),
    );
    const template = (await mammoth.convertToHtml({ buffer })).value;
    const text = (value: string) => value.replace(/<[^>]*>/g, '').trim();
    const templateFields = [...template.matchAll(/<tr[^>]*>(.*?)<\/tr>/gs)]
      .map((row) => text(row[1]!.match(/<t[dh][^>]*>(.*?)<\/t[dh]>/s)![1]!))
      .filter((label) => label !== '填写项');
    const templateSections = [...template.matchAll(/<h1[^>]*>(.*?)<\/h1>/gs)].map((heading) =>
      text(heading[1]!).replace(/^[一二三四五]\s+/, ''),
    );
    const html = await renderToString(createSSRApp(CustomizedInfoExtractionNodePage, props));
    const fields = [
      ...html.matchAll(/<(?:label\b|h4\b[^>]*data-information-label)[^>]*>(.*?)<\/(?:label|h4)>/gs),
    ].map((label) => text(label[1]!));
    const sections = [...html.matchAll(/<h3[^>]*>(.*?)<\/h3>/gs)].map((heading) =>
      text(heading[1]!),
    );
    expect(templateFields).toHaveLength(12);
    expect(fields).toEqual(templateFields);
    expect(sections).toEqual(templateSections);
    expect(templateSections).toHaveLength(2);
    expect([...fields, ...sections].every((label) => !/[或/]/.test(label))).toBe(true);
    const cardLabels = (id: string) =>
      [
        ...html
          .match(new RegExp(`data-section="${id}"(.*?)</section>`, 's'))![1]!
          .matchAll(/<(?:label\b|h4\b[^>]*data-information-label)[^>]*>(.*?)<\/(?:label|h4)>/gs),
      ].map((label) => text(label[1]!));
    expect(cardLabels('brand')).toEqual([
      '品牌名称',
      '项目名称',
      '项目背景',
      '品牌调性',
      '视觉统一规则',
      '画面禁用元素',
    ]);
    expect(cardLabels('product')).toEqual([
      '产品名称',
      '产品介绍',
      '产品规格',
      '产品外观',
      '核心卖点',
      '目标受众',
    ]);
    expect(html).not.toContain('data-section="brandTone"');
    expect(html).not.toContain('data-section="creative"');
    expect(html).not.toContain('data-section="specifications"');
    expect(html).not.toContain('data-section="audience"');
  });
  it('preserves product details, multiple selling points and merged brand constraints in the rendered view', async () => {
    const view = emptyCustomizedExtractionView();
    view.status = 'COMPLETED';
    view.fields.projectName = '青梅酱新品短片';
    view.fields.productDescription = '青梅风味调味酱，带细小果肉';
    view.fields.productSpecifications = '200 g，单瓶装；尺寸待确认';
    view.fields.productAppearance = '黄绿色酱体；包装请 AI 提方案';
    view.fields.sellingPoints = ['青梅风味', '细小果肉颗粒', '适合日常佐餐'];
    view.fields.avoidedElements = '不添加未确认功效';
    view.fields.brandTone = '烟火食欲感、岭南人情味、真实克制';
    view.fields.visualConsistencyRules = '产品外观全片一致，品牌标识保持原样';
    const html = await renderToString(
      createSSRApp(CustomizedInfoExtractionNodePage, { ...props, view, available: true }),
    );
    expect(html).toContain('青梅酱新品短片');
    expect(html).toContain('青梅风味调味酱，带细小果肉');
    expect(html).toContain('200 g，单瓶装；尺寸待确认');
    expect(html).toContain('黄绿色酱体；包装请 AI 提方案');
    for (const point of view.fields.sellingPoints) expect(html).toContain(point);
    expect([...html.matchAll(/aria-label="卖点 \d+"/g)]).toHaveLength(3);
    expect(html).toContain('title="添加一个卖点"');
    expect([...html.matchAll(/aria-label="删除卖点"/g)]).toHaveLength(3);
    expect(html).toContain('不添加未确认功效');
    expect(html).toContain('烟火食欲感、岭南人情味、真实克制');
    expect(html).toContain('产品外观全片一致，品牌标识保持原样');
    expect(html).not.toContain('value="25-30"');
  });
  it('renders a loading or error state without a duplicate result form', async () => {
    const loading = await renderToString(
      createSSRApp(CustomizedInfoExtractionNodePage, { ...props, loading: true }),
    );
    expect(loading).toContain('正在恢复信息提炼');
    expect(loading).not.toContain('品牌基础信息');
    const error = await renderToString(
      createSSRApp(CustomizedInfoExtractionNodePage, { ...props, loadError: '读取暂时失败' }),
    );
    expect(error).toContain('读取暂时失败');
    expect(error).not.toContain('品牌基础信息');
  });
});
