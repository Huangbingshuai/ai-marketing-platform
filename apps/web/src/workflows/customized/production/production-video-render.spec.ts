import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { it, expect } from 'vitest';
import Settings from '../../../platform/workflow/components/WorkflowVideoRenderSettings.vue';
import Panel from './ProductionShotRenderPanel.vue';
import {
  DEFAULT_CUSTOMIZED_VIDEO_RENDER_SETTINGS as settings,
  SEEDANCE_MODEL_OPTIONS,
} from '@ai-marketing/contracts';
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
      renderTask: {
        id: 'render-failed',
        operation: 'RENDER',
        status: 'FAILED',
        errorMessage: '受控失败',
        steps: [],
      },
    }),
  );
  expect(html).toContain('<video');
  expect(html).toContain('controls');
  expect(html).toContain('下载当前分镜视频');
  expect(html).toContain('受控失败');
  expect(html).toContain('重新生成视频');
  expect(html).toContain('继续本次任务');
  expect(html).toContain('可能产生模型费用');
  expect(html).not.toContain('暂无视频');
});
it.each([6, 14])(
  'links confirmed duration %s to existing parameters without adding a second number input',
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
    expect(html).toContain(`编辑分镜时长：${seconds}秒`);
    expect(html).toContain('视频配置');
    expect(html).not.toContain('type="number"');
    expect(html).not.toContain('shot-render-duration');
  },
);
it.each(
  SEEDANCE_MODEL_OPTIONS.flatMap((model) => [4.5, 6.5, 5.5].map((seconds) => ({ model, seconds }))),
)(
  '$model.label explains fractional duration $seconds without suggesting a model switch or changing it',
  async ({ model, seconds }) => {
    const shot = {
      id: 's',
      title: '杯',
      durationSeconds: seconds,
      shotType: '中景',
      cameraMovement: '固定',
      visual: '杯',
      dialogue: '',
      audio: '',
      atmosphere: '',
      bindings: [],
    };
    const html = await renderToString(
      createSSRApp(Panel, {
        projectId: 'p',
        workflowRunId: 'r',
        clipId: 'clip',
        shot,
        assets: [],
        prompt: '原提示词',
        locked: false,
        editing: true,
        index: 1,
        settings: { ...settings, capabilityKey: model.value },
        promptReady: true,
      }),
    );
    const hint = html.split('class="render-hint"')[1]!.split('</p>')[0]!;
    expect(hint).toContain('仅支持整数秒');
    expect(hint).toContain(`${seconds}秒`);
    expect(hint).toContain('分镜参数');
    expect(hint).not.toContain('选择兼容模型');
    expect(html.split('class="generate-button"')[1]!.split('</button>')[0]).toContain('disabled');
    expect(shot.durationSeconds).toBe(seconds);
  },
);
it.each(SEEDANCE_MODEL_OPTIONS)('$label keeps valid integer seconds usable', async (model) => {
  const html = await renderToString(
    createSSRApp(Panel, {
      projectId: 'p',
      workflowRunId: 'r',
      clipId: 'clip',
      shot: {
        id: 's',
        title: '杯',
        durationSeconds: 6,
        shotType: '中景',
        cameraMovement: '固定',
        visual: '杯',
        dialogue: '',
        audio: '',
        atmosphere: '',
        bindings: [],
      },
      assets: [],
      prompt: '原提示词',
      locked: false,
      editing: true,
      index: 1,
      settings: { ...settings, capabilityKey: model.value },
      promptReady: true,
    }),
  );
  expect(html).not.toContain('仅支持整数秒');
  expect(html.split('class="generate-button"')[1]!.split('</button>')[0]).not.toContain('disabled');
});
