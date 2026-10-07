import { describe, expect, it } from 'vitest';
import type { WorkingArtifact } from '@ai-marketing/contracts';
import { assetDocument, assetDocumentExport } from './asset-document';
import { buildBrowserAssets } from './project-asset-browser';
import readerSource from './components/AssetDocumentReader.vue?raw';
import browserSource from './components/ProjectAssetBrowser.vue?raw';

const item = (type: 'PROMPT' | 'INSIGHT_RESULT', payload: unknown) =>
  buildBrowserAssets(
    [
      {
        id: 'document-1',
        projectId: 'p1',
        workflowRunId: 'r1',
        nodeId: type === 'PROMPT' ? 'PROMPT_GENERATION' : 'INFORMATION_EXTRACTION',
        artifactKey: type === 'PROMPT' ? 'prompt-batch:p1' : 'marketing-insight:p1',
        name: '紫苏梅子酱',
        type,
        payload,
        kind: 'STRUCTURED',
        directory: 'PROMPTS',
        metadata: null,
        originalFileName: null,
        mimeType: null,
        sizeBytes: null,
        contentUrl: null,
        downloadUrl: null,
        sourceRunId: null,
        sourceArtifactId: null,
        revision: 1,
        dependencies: [],
        fileCount: 0,
        mainPreviewUrl: null,
        status: 'WORKING',
        archiveStatus: 'UNARCHIVED',
        createdAt: '2026-10-07T00:00:00Z',
        previewKind: 'DOWNLOAD',
        availability: 'AVAILABLE',
        freshness: 'CURRENT',
        tags: [],
        files: [],
        updatedAt: '2026-10-07T00:00:00Z',
      } satisfies WorkingArtifact,
    ],
    [],
    {
      projectId: 'p1',
      workflowRunId: 'r1',
      workflow: 'EFFECT',
      space: 'EFFECT',
    },
  )[0]!;

describe('asset document reading and export', () => {
  it('shows every fact and all product basic fields without a display limit', () => {
    const asset = item('INSIGHT_RESULT', {
      productName: '紫苏梅子酱',
      productCategory: '酱料',
      coreSpecification: '220g',
      priceRange: '20元',
      visualFeatures: '玻璃瓶',
      sellingPoints: Array.from({ length: 55 }, (_, i) => `事实${i + 1}`),
      providerToken: 'never-export',
    });
    const document = assetDocument(asset)!;
    expect(document.sections[0]!.fields).toHaveLength(5);
    expect(document.sections[1]!.fields).toHaveLength(55);
    const exported = assetDocumentExport(asset, '版本01', '项目')!;
    expect(exported.content).toContain('事实55');
    expect(exported.content).not.toContain('never-export');
    expect(exported.fileName).toContain('版本01.txt');
  });
  it('reads every prompt, body, creative direction, six dimensions and source facts', () => {
    const asset = item('PROMPT', {
      settings: {
        defaultDurationSeconds: 10,
        styleMode: 'AI_AUTO',
        deliveryChannel: '抖音',
        disabledElements: ['字幕'],
      },
      sharedPrompt: { compiledContent: '无字幕约束' },
      items: Array.from({ length: 20 }, (_, i) => ({
        code: `P${i + 1}`,
        content: `【视频概览】\n正文${i + 1}\n【结束画面】`,
        targetDurationSeconds: 10,
        creativeCore: '完整创意方向',
        primaryPurpose: 'PRODUCT_DISPLAY',
        compatiblePurposes: ['PRODUCT_DISPLAY', 'EFFECT'],
        dimensions: {
          narrative: '叙事',
          scene: '场景',
          persona: '人物',
          productRelation: '产品关联',
          camera: '镜头',
          emotion: '情绪',
        },
        insightBindings: [{ factId: 'private-id', value: '真实来源事实' }],
      })),
    });
    const document = assetDocument(asset)!;
    expect(document.sections).toHaveLength(21);
    const exported = assetDocumentExport(asset, '版本02', '项目')!;
    for (const value of [
      '正文20',
      '完整创意方向',
      '叙事',
      '场景',
      '人物',
      '产品关联',
      '镜头',
      '情绪',
      '真实来源事实',
      '无字幕约束',
      '产品展示片段',
    ])
      expect(exported.content).toContain(value);
    expect(exported.content).not.toContain('private-id');
  });
  it('exports only the supplied snapshot and does not mutate it', () => {
    const old = item('PROMPT', { items: [{ content: '旧版本正文' }] });
    const fresh = item('PROMPT', { items: [{ content: '新版本正文' }] });
    const before = JSON.stringify(old);
    expect(assetDocumentExport(old, '版本01', '项目')!.content).not.toContain('新版本正文');
    expect(assetDocumentExport(fresh, '版本02', '项目')!.content).not.toContain('旧版本正文');
    expect(JSON.stringify(old)).toBe(before);
  });
  it('handles absent and unavailable content without creating a misleading export', () => {
    const empty = item('INSIGHT_RESULT', null);
    expect(assetDocument(empty)?.sections).toEqual([]);
    expect(assetDocumentExport(empty, '版本01', '项目')).toBeNull();
    const unavailable = item('PROMPT', { content: '正文' });
    unavailable.unavailable = true;
    expect(assetDocumentExport(unavailable, '版本01', '项目')).toBeNull();
  });
  it('keeps filenames safe and displays document content as text', () => {
    const asset = item('PROMPT', { content: '<script>alert(1)</script>' });
    const exported = assetDocumentExport(asset, '版本01', '项目/名称:*')!;
    expect(exported.fileName).not.toMatch(/[\\/:*?"<>|]/u);
    expect(exported.content).toContain('<script>alert(1)</script>');
    expect(readerSource).toContain('{{ field.value }}');
    expect(readerSource).not.toContain('v-html');
    expect(readerSource).not.toContain('line-clamp');
    expect(browserSource).toContain('{{ version.label }}');
    expect(browserSource).not.toContain("formatAssetTime(version.createdAt ?? '')");
  });
});
