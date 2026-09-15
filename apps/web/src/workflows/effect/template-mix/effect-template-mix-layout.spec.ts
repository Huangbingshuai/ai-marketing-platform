import { describe, expect, it } from 'vitest';
import workflowSource from '../source-import/EffectImportNodePage.vue?raw';
import pageSource from './EffectTemplateMixNodePage.vue?raw';
import thumbnailCacheSource from './effect-template-mix-thumbnail-cache.ts?raw';
import thumbnailSource from './EffectTemplateMixThumbnail.vue?raw';
import timelineSource from './EffectTemplateMixTimeline.vue?raw';

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
    expect(pageSource).toContain('createEffectTemplateMixAiRun');
    expect(pageSource).toContain('getEffectTemplateMixAiRun');
    expect(pageSource).not.toContain('createEmptyEffectTemplateMixVariant');
    expect(pageSource).toContain('大模型按 Prompt 归槽');
    expect(pageSource).toContain('changeTrimStart');
    expect(pageSource).toContain('applyEffectTemplateMixVariant');
    expect(pageSource).toContain('validateEffectTemplateMix');
    expect(pageSource).not.toMatch(/\bfillEffectTemplateMixVariant\b/u);
    expect(pageSource).not.toContain('syncEffectTemplateMixVariants');
    expect(pageSource).not.toMatch(/Mock|MOCK|createEffectTemplateMixMock/u);
  });
  it('keeps configuration and refinement as separate views', () => {
    expect(pageSource).toContain('进入精修工作台');
    expect(pageSource).not.toContain('智能填充并进入精修');
    expect(pageSource).toContain('返回模板配置');
    expect(pageSource).toContain('成片精修工作台');
    expect(pageSource).toContain('AI 智能填充');
    expect(pageSource).toContain('尚未生成成片工程');
    expect(pageSource).toContain('后续可用算法复用六槽素材');
    expect(pageSource).toContain('算法批量组合');
    expect(pageSource).toContain('composeEffectTemplateMixVariants');
    expect(pageSource).toContain('aria-label="AI 归槽素材筛选"');
    expect(pageSource).toContain('materialRoleOptions');
    expect(pageSource).toContain('selectMaterialRole(option.role)');
    expect(pageSource).not.toContain('class="timeline-health"');
    expect(pageSource).not.toContain('class="slot-tabs"');
    expect(pageSource).not.toContain('class="tools"');
    expect(pageSource).toContain('EffectTemplateMixTimeline');
    expect(pageSource).toContain('WorkflowRunProgress');
    expect(pageSource).toContain('查看当前工作流');
    expect(pageSource).toContain('@show-details="openWorkflowDialog"');
    expect(pageSource).toContain('TEMPLATE MIX WORKFLOW');
    expect(pageSource).toContain('class="workflow-graph-content"');
    expect(pageSource).toContain('class="workflow-graph-canvas"');
    expect(pageSource).toContain('class="workflow-graph-node"');
    expect(pageSource).toContain('class="workflow-node-detail"');
    expect(pageSource).toContain('4 条执行边');
    expect(pageSource).toContain('返回工作区');
    expect(pageSource).toContain("view.value = 'EDITOR'");
    expect(pageSource).toContain('if (resumedRun)');
    expect(pageSource).toContain('!targetVariantId ||');
    expect(pageSource).toContain('material-pagination');
    expect(pageSource).toContain('displayedMaterials');
    expect(timelineSource).toContain(
      "const tracks: VisibleTrack[] = ['CAPTION', 'VIDEO', 'VOICE', 'BGM'];",
    );
    expect(timelineSource).toContain('未配置字幕');
    expect(timelineSource).toContain('未配置口播');
    expect(timelineSource).toContain('未配置 BGM');
    expect(pageSource).not.toContain('初次生成数量');
  });
  it('renders loading, empty, error and real-media states', () => {
    expect(pageSource).toContain("pageState === 'LOADING'");
    expect(pageSource).toContain("pageState === 'ERROR'");
    expect(pageSource).toContain('还没有混剪模板');
    expect(pageSource).toContain(':src="materialForSlot(slot.id)?.contentUrl"');
    expect(pageSource).toContain(':src="auditionMaterial.contentUrl"');
    expect(pageSource).toContain('const previewSlot = computed');
    expect(pageSource).toContain('class="player-blackout"');
    expect(pageSource).toContain('class="player-source-error"');
    expect(pageSource).toContain('requestAnimationFrame(updatePlaybackFrame)');
    expect(pageSource).not.toContain('@timeupdate="onTime"');
    expect(pageSource).toContain('preload="auto"');
    expect(pageSource).toContain('displayedTimelineSlotId === slot.id');
    expect(pageSource).not.toContain('class="player-label"');
    expect(pageSource).toContain(':style="stageStyle"');
    expect(pageSource).toContain('const materialPageSize = computed');
    expect(pageSource).toContain('materialColumnCount.value * 3');
    expect(pageSource).toContain('EffectTemplateMixThumbnail');
  });
  it('renders a Jianying-style filmstrip track and overlay playhead', () => {
    expect(timelineSource).not.toContain("from 'vue-timeline-editor'");
    expect(timelineSource).toContain('class="clip-filmstrip"');
    expect(timelineSource).toContain('EffectTemplateMixWaveform');
    expect(timelineSource).toContain(':trim-start="activeTrimOffset(slot.id)"');
    expect(timelineSource).not.toContain('Math.sin');
    expect(timelineSource).toContain('EffectTemplateMixThumbnail');
    expect(timelineSource).not.toContain('frameUrl(materialForSlot');
    expect(timelineSource).toContain('class="timeline-playhead"');
    expect(timelineSource).toContain('class="playhead-handle"');
    expect(timelineSource).toContain('@pointerdown="onRulerPointerDown"');
    expect(timelineSource).toContain('@pointerdown="onClipPointerDown($event, slot.id)"');
    expect(timelineSource).toContain('@pointerdown="onPlayheadPointerDown"');
    expect(timelineSource).toContain('class="drag-ghost"');
    expect(timelineSource).toContain('class="snap-guide"');
    expect(timelineSource).toContain('class="selection-marquee"');
    expect(timelineSource).toContain('quantizeToFrame');
    expect(timelineSource).toContain('anchorTime');
    expect(timelineSource).toContain('@wheel="onWheel"');
    expect(timelineSource).toContain("emit('trimSlot'");
    expect(timelineSource).toContain("emit('undo')");
    expect(timelineSource).toContain("emit('redo')");
    expect(pageSource).toContain('@dragstart="beginMaterialDrag($event, material)"');
    expect(pageSource).toContain('@assign-material="assignDroppedMaterial"');
    expect(pageSource).toContain('@click="previewLibraryMaterial(material)"');
    expect(pageSource).toContain('togglePreviewPlayback');
    expect(pageSource).toContain('aria-label="调整素材库宽度"');
    expect(pageSource).toContain("startPaneResize($event, 'LEFT')");
    expect(pageSource).toContain('repeat(auto-fill, minmax(142px, 1fr))');
    expect(pageSource).toContain('materialUsageLabel(material.id)');
    expect(pageSource).toContain('同一成片不能重复使用');
    expect(pageSource).toContain('aria-label="关闭提示"');
    expect(timelineSource).toContain("emit('assignMaterial', materialId, slotId)");
    expect(timelineSource).toContain('@dragover="onMaterialDragOver"');
    expect(timelineSource).toContain("'is-material-target': materialDropSlotId === slot.id");
    expect(timelineSource).toContain('translate3d(${playheadLeft}px, 0, 0)');
    expect(timelineSource).toContain('--timeline-bg: #f6f8fc');
    expect(pageSource).toContain('aria-label="调整预览区与时间轴高度"');
    expect(pageSource).toContain('@pointerdown="startEditorHeightResize"');
    expect(timelineSource).toContain('aria-label="调整轨道控制区宽度"');
    expect(timelineSource).toContain('@pointerdown="startTimelineResize"');
    expect(timelineSource).toContain("'--track-header-width': `${trackHeaderWidth.value}px`");
    expect(timelineSource).toContain("'--timeline-height': `${props.height}px`");
    expect(timelineSource).not.toContain('draggable="true"');
    const selectSlotBlock = pageSource.slice(
      pageSource.indexOf('const selectSlot'),
      pageSource.indexOf('const applyMaterial'),
    );
    expect(selectSlotBlock).not.toContain('seek(');
    const seekBlock = pageSource.slice(
      pageSource.indexOf('const seek ='),
      pageSource.indexOf('const togglePlay'),
    );
    expect(seekBlock).not.toContain('selectedSlotId');
    expect(timelineSource).toContain('等待 AI 智能填充');
  });
  it('provides Jianying-style preview playback controls', () => {
    expect(pageSource).toContain('formatPlayerTimecode');
    expect(pageSource).toContain('aria-label="播放进度"');
    expect(pageSource).toContain('声音监控：检测到声音');
    expect(pageSource).toContain('class="player-audio-meter"');
    expect(pageSource).toContain('const AUDIO_METER_LEVELS = [2, 4, 3] as const');
    expect(pageSource).toContain('segment <= AUDIO_METER_LEVELS[column - 1]!');
    expect(pageSource).toContain('.player-audio-meter b.lit');
    expect(pageSource).toContain('class="player-audio-status"');
    expect(pageSource).toContain('role="status"');
    expect(pageSource).toContain('audio-meter-signal');
    expect(pageSource).not.toContain("togglePlayerMenu('AUDIO')");
    expect(pageSource).not.toContain('监控音量');
    expect(pageSource).not.toContain('previewVolume');
    expect(pageSource).toContain('webkitAudioDecodedByteCount');
    expect(pageSource).toContain('previewHasAudibleTrack');
    expect(pageSource).toContain('previewIsPlaying.value &&');
    expect(pageSource).not.toContain('previewPlaybackRate');
    expect(pageSource).not.toContain('previewLoop');
    expect(pageSource).not.toContain('previewMuted');
    expect(pageSource).toContain('预览缩放');
    expect(pageSource).toContain('aria-label="预览画面缩放"');
    expect(pageSource).toContain('@click="adjustPreviewZoom(-5)"');
    expect(pageSource).toContain('@click="adjustPreviewZoom(5)"');
    expect(pageSource).toContain('background: #0c0d10');
    expect(pageSource).toContain('right: -64px !important');
    expect(pageSource).not.toContain('<output>{{ previewZoom }}%</output>');
    expect(pageSource).toContain('画幅跟随当前素材，不可修改');
    expect(pageSource).not.toContain("playerMenu === 'ASPECT'");
    expect(pageSource).not.toContain('仅调整预览画布');
    expect(pageSource).toContain('toggleFullscreen');
    expect(pageSource).toContain("event.key.toLocaleLowerCase() === 'f'");
    expect(pageSource).toContain("event.key === 'Home' || event.key === 'End'");
  });
  it('allows a three-column material pane while preserving the player width', () => {
    expect(pageSource).toContain('const LEFT_PANE_MAX_WIDTH = 680');
    expect(pageSource).toContain('const CENTER_PANE_MIN_WIDTH = 420');
    expect(pageSource).toContain(
      'bounds.width - rightPaneWidth.value - CENTER_PANE_MIN_WIDTH - 14',
    );
    expect(pageSource).toContain('minmax(${CENTER_PANE_MIN_WIDTH}px, 1fr)');
    expect(pageSource).toContain(':aria-valuemax="LEFT_PANE_MAX_WIDTH"');
    expect(pageSource).toContain('repeat(auto-fill, minmax(142px, 1fr))');
    expect(pageSource).not.toContain('availableHeight * stageAspectRatio.value');
  });
  it('keeps the new-template primary action visibly available', () => {
    expect(pageSource).toContain('class="button primary modal-submit"');
    expect(pageSource).toContain('创建模板');
    expect(pageSource).toContain('type="button"');
    expect(pageSource).toContain('var(--blue, #2563eb)');
  });
  it('retains real timeline frames across zoom, redraw and variant changes', () => {
    expect(timelineSource).toContain('const count = 8');
    expect(timelineSource).toContain('const sourceStart = props.variant?.offsets[slot.id] ?? 0');
    expect(timelineSource).toContain('materialForSlot(slot.id)!.contentHash');
    expect(thumbnailSource).toContain('retainEffectTemplateMixThumbnail');
    expect(thumbnailSource).toContain('releaseEffectTemplateMixThumbnail');
    expect(thumbnailCacheSource).toContain('!pinCounts.has(key)');
    expect(thumbnailCacheSource).toContain('retryAfter.set(key');
    expect(thumbnailCacheSource).toContain("video.addEventListener('canplay', capture)");
    expect(thumbnailCacheSource).not.toContain('failedKeys');
  });
});
