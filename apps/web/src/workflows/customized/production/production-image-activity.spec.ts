import { afterEach, expect, it, vi } from 'vitest';
import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';
import type { ProductionAsset, ProductionTask } from '@ai-marketing/contracts';
import { assetImageActivity } from './production-image-activity';
import Status from './ProductionImageStatus.vue';
import Composer from './ProductionImageComposer.vue';
import Studio from './ProductionAssetStudio.vue';
import Dialog from './ProductionRenderDialog.vue';
const asset: ProductionAsset = {
  id: 'a',
  kind: 'PRODUCT',
  name: '随行杯',
  description: '陶瓷白釉',
  knownFacts: '',
  designNotes: '',
  sourceText: '',
  image: { assetId: 'old-image', version: 1 },
};
const task = (status: ProductionTask['status'], ids = ['a', 'b']): ProductionTask => ({
  id: 'task',
  operation: 'IMAGE',
  status,
  progress: 50,
  steps: [],
  shotId: null,
  errorMessage: null,
  imageSettings: {
    model: 'doubao-seedream-5-0-pro-260628',
    resolution: '2K',
    ratio: '1:1',
    assetIds: ids,
  },
  completedImageAssetIds: ['a'],
});
afterEach(() => vi.unstubAllGlobals());
it('keeps saved items complete when the remaining batch fails, and uses the latest attempt only', () => {
  const failed = { ...task('FAILED'), errorMessage: '图片服务暂时不可用' };
  expect(assetImageActivity([failed], 'a')?.state).toBe('SUCCEEDED');
  expect(assetImageActivity([failed], 'b')).toMatchObject({
    state: 'FAILED',
    error: '图片服务暂时不可用',
  });
  expect(assetImageActivity([failed], 'unselected')).toBeUndefined();
  const retry = { ...task('QUEUED'), id: 'new', completedImageAssetIds: [] };
  expect(assetImageActivity([retry, failed], 'a')).toEqual({ state: 'QUEUED', taskId: 'new' });
});
it('uses spinners and stage text, never percentages or a progress track', async () => {
  for (const state of ['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED'] as const) {
    const html = await renderToString(createSSRApp(Status, { activity: { state, taskId: 't' } }));
    expect(html).not.toContain('progressbar');
    expect(html).not.toContain('%');
    expect(html).toContain('role="status"');
    expect(/class="[^"]*\bspin\b/.test(html)).toBe(state === 'QUEUED' || state === 'RUNNING');
  }
});
it('keeps the composer prompt and old image while generation is busy and offers a close action', async () => {
  const html = await renderToString(
    createSSRApp(Composer, {
      asset,
      projectId: 'p',
      workflowRunId: 'r',
      busy: true,
      activity: { state: 'RUNNING', taskId: 't' },
    }),
  );
  expect(html).toContain('完成前保留当前图片');
  expect(html).toContain('陶瓷白釉');
  expect(html).toContain('正在生成图片');
  expect(html).toContain('可关闭此窗口，生成会继续');
  expect(html).not.toContain('progressbar');
});
it('shows batch completion per item and only overlays the pending asset card', async () => {
  vi.stubGlobal('document', { activeElement: null });
  vi.stubGlobal('HTMLElement', class {});
  const assets = [asset, { ...asset, id: 'b', name: '杯盖' }];
  const current = task('RUNNING');
  const cards = await renderToString(
    createSSRApp(Studio, {
      projectId: 'p',
      assets,
      shots: [],
      editing: false,
      locked: true,
      imageTasks: [current],
    }),
  );
  expect(cards).toContain('杯盖图片生成中');
  expect(cards).not.toContain('随行杯图片生成中');
  expect(cards).toContain('正在生成图片');
  expect(cards).not.toContain('progressbar');
  const context: { teleports?: Record<string, string> } = {};
  const rendered = await renderToString(
    createSSRApp(Dialog, { open: true, type: 'IMAGE', assets, task: current, busy: true }),
    context,
  );
  const dialog = rendered + Object.values(context.teleports ?? {}).join('');
  expect(dialog).toContain('图片已生成');
  expect(dialog).toContain('正在生成图片');
  expect(dialog).not.toContain('progressbar');
});
