import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { it, expect } from 'vitest';
import Settings from '../../../platform/workflow/components/WorkflowVideoRenderSettings.vue';
import Panel from './ProductionShotRenderPanel.vue';
import { DEFAULT_CUSTOMIZED_VIDEO_RENDER_SETTINGS as settings } from '@ai-marketing/contracts';
it('keeps render progress in the player card and preserves the prior video during regeneration', async () => {
  const html = await renderToString(
    createSSRApp(Panel, {
      projectId: 'p',
      workflowRunId: 'r',
      clipId: 'clip',
      shot: { id: 's', title: '杯', durationSeconds: 6, assetIds: [] },
      assets: [],
      prompt: '杯的特写',
      locked: true,
      editing: true,
      index: 1,
      settings,
      promptReady: true,
      video: {
        value: { clipId: 'clip', durationSeconds: 6, width: 1280, height: 720 },
        revision: 2,
        stale: false,
      },
      renderTask: {
        status: 'RUNNING',
        progress: 58,
        steps: [{ status: 'RUNNING', content: '视频服务正在生成' }],
      },
    }),
  );
  const player = html.split('class="player-card"')[1]!.split('</section>')[0]!;
  expect(player).toContain('<video');
  expect(player).toContain('视频服务正在生成');
  expect(player).toContain('aria-valuenow="58"');
  expect(html.split('<footer')[1]).not.toContain('视频服务正在生成');
});
it('renders live shared configuration fields', async () => {
  const html = await renderToString(createSSRApp(Settings, { modelValue: settings }));
  expect(html).toContain('role="combobox"');
  expect(html).toContain('Doubao-Seedance-2.0');
  expect(html).toContain('720P');
});
it('keeps a real playable prior video visible after a failed regeneration', async () => {
  const html = await renderToString(
    createSSRApp(Panel, {
      projectId: 'p',
      workflowRunId: 'r',
      clipId: 'clip',
      shot: { id: 's', title: '杯', durationSeconds: 6, assetIds: [] },
      assets: [],
      prompt: '杯的特写',
      locked: false,
      editing: true,
      index: 1,
      settings,
      promptReady: true,
      video: {
        value: { clipId: 'clip', durationSeconds: 6, width: 1280, height: 720 },
        revision: 2,
        stale: false,
      },
      renderTask: { status: 'FAILED', errorMessage: '受控失败', steps: [] },
    }),
  );
  expect(html).toContain('<video');
  expect(html).toContain('controls');
  expect(html).toContain('下载当前分镜视频');
  expect(html).toContain('受控失败');
  expect(html).toContain('重新生成视频');
  expect(html).not.toContain('暂无视频');
});
it.each([6, 14])(
  'renders confirmed duration %s as static information even in editable mode',
  async (seconds) => {
    const html = await renderToString(
      createSSRApp(Panel, {
        projectId: 'p',
        workflowRunId: 'r',
        clipId: 'clip',
        shot: { id: 's', title: '杯', durationSeconds: seconds, assetIds: [] },
        assets: [],
        prompt: '杯的特写',
        locked: false,
        editing: true,
        index: 1,
        settings,
        promptReady: true,
      }),
    );
    expect(html).toContain(`分镜时长：${seconds}秒，沿用已确认分镜`);
    expect(html).toContain('视频配置');
    expect(html).not.toContain('type="number"');
    expect(html).not.toContain('shot-render-duration');
  },
);
