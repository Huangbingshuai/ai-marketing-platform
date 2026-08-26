import { describe, expect, it } from 'vitest';

import parentSource from '../source-import/EffectImportNodePage.vue?raw';
import pageSource from './EffectSegmentRenderNodePage.vue?raw';
import serviceSource from './services/effect-segment-render.mock-service.ts?raw';

describe('effect segment render prototype layout', () => {
  it('reproduces the prototype heading, four stats, management toolbar and two-column cards', () => {
    for (const marker of [
      'class="segment-heading"',
      'AI 视频片段批量渲染',
      '查看 AI 渲染素材池',
      '开始批量渲染',
      'class="segment-stats"',
      '任务总数',
      '已完成',
      '生成中',
      '异常失败',
      'class="segment-toolbar"',
      'class="segment-task-card"',
      'class="segment-pagination"',
    ])
      expect(pageSource).toContain(marker);
    expect(pageSource).toMatch(
      /\.segment-task-list\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/su,
    );
    expect(pageSource).toMatch(
      /\.segment-task-card\s*\{[^}]*grid-template-columns:\s*24px\s+112px\s+minmax\(0,\s*1fr\)/su,
    );
    expect(pageSource).toContain('width: 112px');
    expect(pageSource).toContain('height: 92px');
    expect(pageSource).toContain('{{ EFFECT_SEGMENT_RENDER_PAGE_SIZE }} 条/页');
  });

  it('keeps one prompt mapped to one material fragment and uses all existing fragment labels', () => {
    expect(pageSource).toContain('每条 1 个视频素材片段');
    expect(pageSource).toContain('· 1 个素材片段');
    expect(pageSource).toContain('EFFECT_PROMPT_FRAGMENT_TYPE_LABELS');
    expect(serviceSource).toContain("source: 'PROMPT'");
    expect(serviceSource).toContain("modelMatch: 'AUTO_MATCHED'");
    expect(pageSource).not.toContain('4 个分镜片段');
    expect(serviceSource).not.toContain('完整成片脚本');
  });

  it('wires search, selection, import, retry, delete, export and accessible dialogs', () => {
    for (const handler of [
      'toggleAllFiltered',
      'requestImport',
      'retryTasks([...selectedTaskIds])',
      'requestDelete([...selectedTaskIds], $event)',
      'exportSelected',
      'openPreview(task, $event)',
      'openPrompt(task, $event)',
    ])
      expect(pageSource).toContain(handler);
    expect(pageSource).toContain('role="dialog"');
    expect(pageSource).toContain('role="alertdialog"');
    expect(pageSource).toContain('@keydown.esc="closeAllDialogs(true)"');
    expect(pageSource).toContain('ref="deleteConfirmButton"');
    expect(pageSource).toContain('trigger?.isConnected && trigger.focus()');
  });

  it('uses the common draft and footer controls without a node-level asset save button', () => {
    expect(pageSource).toContain('<WorkflowNodeDraftBar');
    expect(pageSource).toContain('<WorkflowNodeFooter');
    expect(pageSource).toContain('尚未提交真实工作副本');
    expect(pageSource).not.toContain('保存到项目资产库');
    expect(pageSource).not.toContain('localStorage');
  });

  it('keeps asynchronous mock behavior in the standalone service with no network call', () => {
    expect(serviceSource).toContain('const workspaces = new Map');
    expect(serviceSource).toContain('startEffectSegmentRenderBatch');
    expect(serviceSource).toContain('regenerateEffectSegmentRenderTasks');
    expect(serviceSource).toContain('自动重试已达上限');
    expect(serviceSource).not.toContain('fetch(');
    expect(pageSource).not.toContain('setInterval(');
  });

  it('replaces only step four and leaves later nodes on the existing placeholder', () => {
    expect(parentSource).toContain(
      "import EffectSegmentRenderNodePage from '../segment-render/EffectSegmentRenderNodePage.vue'",
    );
    expect(parentSource).toContain('v-else-if="activeStep === 3"');
    expect(parentSource).toContain('ref="segmentRenderNode"');
    expect(parentSource).toContain('@back="selectWorkflowStep(2)"');
    expect(parentSource).toContain('@next="selectWorkflowStep(4)"');
    expect(parentSource).toContain('v-else-if="activeDownstreamBoundary"');
  });
});
