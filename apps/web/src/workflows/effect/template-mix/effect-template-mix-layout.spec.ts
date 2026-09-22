import { describe, expect, it } from 'vitest';
import workflowSource from '../source-import/EffectImportNodePage.vue?raw';
import pageSource from './EffectTemplateMixNodePage.vue?raw';
import packagingSource from './EffectTemplateMixPackaging.vue?raw';
import thumbnailCacheSource from './effect-template-mix-thumbnail-cache.ts?raw';
import thumbnailSource from './EffectTemplateMixThumbnail.vue?raw';
import filmstripSource from './EffectTemplateMixFilmstrip.vue?raw';
import timelineSource from './EffectTemplateMixTimeline.vue?raw';
import waveformSource from './EffectTemplateMixWaveform.vue?raw';

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
    expect(pageSource).toContain('createEmptyEffectTemplateMixVariant');
    expect(pageSource).toContain('createEffectTemplateMixAiRun');
    expect(pageSource).toContain('getEffectTemplateMixAiRun');
    expect(pageSource).toContain('大模型按 Prompt 归槽');
    expect(pageSource).toContain('changeTrimStart');
    expect(pageSource).toContain('applyEffectTemplateMixVariant');
    expect(pageSource).toContain('completeEffectTemplateMixPackaging');
    expect(pageSource).not.toMatch(/\bfillEffectTemplateMixVariant\b/u);
    expect(pageSource).not.toContain('syncEffectTemplateMixVariants');
    expect(pageSource).not.toMatch(/Mock|MOCK|createEffectTemplateMixMock/u);
  });
  it('creates an empty film project separately from AI operations', () => {
    expect(pageSource).toContain('<Plus :size="13" />新建成片');
    expect(pageSource).toContain('@click="createEmptyVariant"');
    expect(pageSource).toContain('智能成片包装');
    expect(pageSource).toContain('<Workflow :size="13" />查看工作流');
    expect(pageSource).toContain('智能成片包装真实任务进度');
    expect(pageSource).not.toContain('<Plus :size="13" />AI 智能填充');
  });
  it('keeps configuration and refinement as separate views', () => {
    expect(pageSource).toContain('进入精修工作台');
    expect(pageSource).not.toContain('智能填充并进入精修');
    expect(pageSource).toContain('返回模板配置');
    expect(pageSource).toContain('成片精修工作台');
    expect(pageSource).toContain('智能填充');
    expect(pageSource).toContain('尚未生成成片工程');
    expect(pageSource).not.toContain('算法批量组合');
    expect(pageSource).not.toContain('composeEffectTemplateMixVariants');
    expect(pageSource).toContain('aria-label="AI 归槽素材筛选"');
    expect(pageSource).toContain('materialRoleOptions');
    expect(pageSource).toContain('selectMaterialRole(option.role)');
    expect(pageSource).not.toContain('class="timeline-health"');
    expect(pageSource).not.toContain('class="slot-tabs"');
    expect(pageSource).not.toContain('class="tools"');
    expect(pageSource).toContain('EffectTemplateMixTimeline');
    expect(pageSource).toContain('workspace.materials.length < 6');
    expect(pageSource).not.toContain('!selectedVariant ||\n                workspace.materials.length < 6');
    expect(pageSource).toContain(
      '<LoaderCircle v-if="activeAiRun" class="spin" :size="15" />',
    );
    expect(pageSource).toContain('<RefreshCw v-else-if="selectedVariant" :size="15" />');
    expect(pageSource).not.toContain('<Play v-else :size="15" />{{');
    expect(pageSource).toContain('WorkflowRunProgress');
    expect(pageSource).toContain('class="editor-workflow-progress"');
    expect(pageSource).toContain('class="mix-run-progress"');
    expect(packagingSource).toContain('v-if="starting || active"');
    expect(packagingSource).toContain('class="workflow-graph-content"');
    expect(packagingSource).not.toContain('class="workflow-version-notice"');
    expect(packagingSource).not.toContain('class="summary"');
    expect(pageSource).toContain('查看当前工作流');
    expect(pageSource).toContain('@show-details="openWorkflowDialog"');
    expect(pageSource).toContain('TEMPLATE MIX WORKFLOW');
    expect(pageSource).toContain('class="workflow-graph-content"');
    expect(pageSource).toContain('class="mix-workflow-progress"');
    expect(pageSource).not.toContain('class="workflow-version-notice"');
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
    expect(pageSource).toContain('查看 Prompt');
    expect(pageSource).toContain('openMaterialSlotPicker');
    expect(pageSource).toContain('moveMaterialToSlot');
    expect(pageSource).toContain('EffectSegmentRenderSourcePrompt');
    expect(pageSource).toContain('compareMaterialsByName');
    expect(pageSource).toContain('align-self: stretch');
    expect(pageSource).toContain('height: 100%;\n  display: flex;\n  flex-direction: column;');
    expect(pageSource).toContain('flex: 1 1 auto');
    expect(timelineSource).toContain(
      "const trackOrder = ref<VisibleTrack[]>(['CAPTION', 'VIDEO']);",
    );
    expect(timelineSource).toContain('const orderedTracks = computed<VisibleTrack[]>(() => {');
    expect(timelineSource).toContain('const visiblePrimaryTracks = computed');
    expect(timelineSource).toContain('const hasCaptionTrack = computed');
    expect(timelineSource).toContain('const hasAudioTrack = computed');
    expect(timelineSource).toContain('const hasCaptionTrack = computed(() => true);');
    expect(timelineSource).toContain('const hasAudioTrack = computed(() => true);');
    expect(timelineSource).toContain('const assignIntervalLanes');
    expect(timelineSource).not.toContain('Math.max(2,');
    expect(timelineSource).not.toContain('未配置字幕');
    expect(timelineSource).not.toContain('未配置音频');
    expect(timelineSource).toContain("type VisibleTrack = 'AUDIO' | 'CAPTION' | 'VIDEO'");
    expect(timelineSource).not.toContain('@dragstart="onTrackDragStart($event, track)"');
    expect(timelineSource).toContain('@scroll="syncTrackScroll(\'HEADERS\')"');
    expect(timelineSource).toContain('@scroll="syncTrackScroll(\'VIEWPORT\')"');
    expect(timelineSource).toContain('const syncTrackScroll');
    expect(timelineSource).toContain('const draggedTimelineEnd = computed');
    expect(timelineSource).toContain('draggedTimelineEnd.value');
    expect(timelineSource).toContain('const duration = Math.max(0, timelineDuration.value)');
    expect(timelineSource).not.toContain('+ majorTickSeconds.value;');
    expect(timelineSource).toContain('overflow: auto;');
    expect(timelineSource).toContain("'moveClip'");
    expect(timelineSource).toContain("'moveClips'");
    expect(timelineSource).toContain('selectionModifier');
    expect(timelineSource).toContain('!drag.selectionModifier');
    expect(timelineSource).toContain('draggingGroupDelta');
    expect(timelineSource).toContain('clipDrag?.selectedSlotIds.length === 1');
    expect(pageSource).toContain('const moveTimelineClips');
    expect(pageSource).toContain('@move-clips="moveTimelineClips"');
    expect(timelineSource).toContain('videoLanes');
    expect(pageSource).toContain('primeUpcomingTimelinePlayer');
    expect(pageSource).toContain('primedTimelinePlayers');
    expect(pageSource).toContain('positionedTimelinePlayers');
    expect(pageSource).toContain('syncPlayingVideoFrame');
    expect(pageSource).toContain('const timelinePlaybackStart = (slotId: string): number => {');
    expect(pageSource).toContain("slot.transition === '硬切'");
    expect(pageSource).toContain('effectTemplateMixTransitionDuration(slot, previousSlot)');
    expect(pageSource).not.toContain('if (transition?.incomingSlot.id === slotId) return transition.start;');
    expect(pageSource).toContain('video.readyState === HTMLMediaElement.HAVE_NOTHING');
    expect(pageSource).toContain('video.src');
    expect(pageSource).toContain('!primedTimelinePlayers.has(video)');
    expect(pageSource).toContain('const sourceTime = timelineSourceTime(slot.id);');
    expect(pageSource).toContain('const resetTimelinePlayerState = (): void => {');
    expect(pageSource).toContain('positionedTimelinePlayers = new WeakSet<HTMLVideoElement>();');
    expect(pageSource).not.toContain('drift > 0.12');
    expect(pageSource).toContain('preload="metadata"');
    expect(pageSource).toContain("otherVideo.preload = slotId === slot.id ? 'auto' : 'metadata'");
    expect(pageSource).toContain('scheduleSeekSync');
    expect(pageSource).toContain('seekSyncRequestId');
    expect(pageSource).toContain('resolveTimelinePlacement');
    expect(pageSource).toContain('overlapsTimelineClip');
    expect(pageSource).toContain('prefer an empty lane above it');
    expect(pageSource).toContain('normalizeVariantVideoLanes');
    expect(pageSource).toContain('clearDetachedTransitions');
    expect(pageSource).toContain('remainsAttached');
    expect(pageSource).toContain('insertLaneAt');
    expect(pageSource).toContain('if (requestedLane < 0)');
    expect(pageSource).toContain('forceInsertLane');
    expect(pageSource).toContain('nextLane < currentLane');
    expect(timelineSource).toContain('drag.currentLane = -1');
    expect(timelineSource).toContain('Math.hypot(');
    expect(pageSource).toContain('beginMaterialPointerDrag');
    expect(pageSource).toContain("className = 'material-drag-ghost'");
    expect(pageSource).toContain(':draggable="Boolean(selectedVariant)"');
    expect(pageSource).toContain('@dragstart="beginMaterialDrag($event, material)"');
    expect(pageSource).toContain('@dragend="endMaterialDrag"');
    expect(pageSource).toContain('@dragstart.capture="onNativeImageDragStart"');
    expect(pageSource).toContain('lane: variant.videoLanes?.[range.id] ?? 0');
    expect(pageSource).toContain('coverMaterial(variant)');
    expect(pageSource).toContain('封面');
    expect(pageSource).toContain('occupiedEnds');
    expect(pageSource).toContain('variantDuration(variant)');
    expect(pageSource).toContain('captureDisplayedFrame');
    expect(pageSource).toContain('player-transition-frame');
    expect(pageSource).not.toContain('resource-tabs-count');
    expect(pageSource).toContain('grid-template-columns: repeat(7, minmax(0, 1fr));');
    expect(pageSource).not.toContain('初次生成数量');
    expect(pageSource).toContain('templateTransitionForRow');
    expect(pageSource).toContain('index < workspace.template.slots.length - 1');
    expect(pageSource).toContain('class="slot-transition-empty"');
    expect(pageSource).not.toContain('v-model="slot.transition"');
    expect(pageSource).toContain('class="slot-readonly-control"');
    expect(pageSource).not.toContain('@change="changeProjectDuration');
    expect(pageSource).not.toContain('@change="changeTrimStart');
  });
  it('renders loading, empty, error and real-media states', () => {
    expect(pageSource).toContain("pageState === 'LOADING'");
    expect(pageSource).toContain("pageState === 'ERROR'");
    expect(pageSource).toContain('还没有混剪模板');
    expect(pageSource).toContain(":class=\"{ 'is-empty': !workspace.variants.length }\"");
    expect(pageSource).toContain('.projects > div.is-empty');
    expect(pageSource).toContain('.project-actions .button svg');
    expect(pageSource).toContain('line-height: 1;');
    expect(pageSource).toContain(':src="materialForSlot(slot.id)?.contentUrl"');
    expect(pageSource).toContain(':src="auditionMaterial.contentUrl"');
    expect(pageSource).toContain('const previewSlot = computed');
    expect(pageSource).toContain('class="player-blackout"');
    expect(pageSource).toContain('class="player-source-error"');
    expect(pageSource).toContain('requestAnimationFrame(updatePlaybackFrame)');
    expect(pageSource).not.toContain('@timeupdate="onTime"');
    expect(pageSource).toContain('preload="auto"');
    expect(pageSource).toContain('visibleTimelineSlotIds.has(slot.id)');
    expect(pageSource).toContain('{{ workspace.variants.length }} 个');
    expect(pageSource).toContain('const variantDisplayName');
    expect(pageSource).toContain("成片 ${String(index + 1).padStart(2, '0')}");
    expect(pageSource).not.toContain('class="player-label"');
    expect(pageSource).toContain(':style="stageStyle"');
    expect(pageSource).toContain('const materialPageSize = computed');
    expect(pageSource).toContain('materialColumnCount.value * 3');
    expect(pageSource).toContain('EffectTemplateMixThumbnail');
  });
  it('renders a compact Jianying-style track and overlay playhead', () => {
    expect(timelineSource).not.toContain("from 'vue-timeline-editor'");
    expect(timelineSource).toContain('class="clip-mini-preview"');
    expect(timelineSource).toContain('EffectTemplateMixWaveform');
    expect(timelineSource).toContain(':trim-start="activeTrimOffset(slot.id)"');
    expect(timelineSource).not.toContain('Math.sin');
    expect(timelineSource).toContain('EffectTemplateMixFilmstrip');
    expect(filmstripSource).toContain('class="mix-filmstrip"');
    expect(filmstripSource).toContain('frameCount');
    expect(timelineSource).not.toContain('frameUrl(materialForSlot');
    expect(timelineSource).toContain('class="timeline-playhead"');
    expect(timelineSource).toContain('class="playhead-handle"');
    expect(timelineSource).toContain('class="edge-trim-handle edge-trim-left"');
    expect(timelineSource).toContain('class="edge-trim-handle edge-trim-right"');
    expect(timelineSource).toContain('const beginEdgeTrim');
    expect(timelineSource).toContain('const edgeTrimBlocked');
    expect(timelineSource).toContain("event.target.closest<HTMLButtonElement>('.edge-trim-handle')");
    expect(timelineSource).toContain('if (edgeHandle?.disabled)');
    expect(timelineSource).toContain('const edgeThreshold = Math.min(12');
    expect(timelineSource).toContain(":disabled=\"edgeTrimBlocked(slot.id, 'LEFT')\"");
    expect(timelineSource).toContain(":disabled=\"edgeTrimBlocked(slot.id, 'RIGHT')\"");
    expect(timelineSource).toContain("'resizeSlot'");
    expect(timelineSource).toContain('class="clip-duration-badge"');
    expect(timelineSource).toContain('formatTimecode(activeSlotDuration(slot.id))');
    expect(timelineSource).toContain('Keep the ghost under the pointer while dragging');
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
    expect(pageSource).toContain('@pointerdown="beginMaterialPointerDrag($event, material)"');
    expect(pageSource).toContain('@assign-material="assignDroppedMaterial"');
    expect(pageSource).toContain('@click="onMaterialCardClick(material)"');
    expect(pageSource).toContain('togglePreviewPlayback');
    expect(pageSource).toContain('aria-label="调整素材库宽度"');
    expect(pageSource).toContain("startPaneResize($event, 'LEFT')");
    expect(pageSource).toContain('@resize-slot="resizeTimelineSlot"');
    expect(pageSource).toContain('const hasMaterialOnSide = variant.slots.some');
    expect(pageSource).toContain('if (hasMaterialOnSide) return;');
    expect(pageSource).toContain('repeat(auto-fill, minmax(142px, 1fr))');
    expect(pageSource).toContain('materialUsageLabel(material.id)');
    expect(pageSource).toContain('同一成片不能重复使用');
    expect(pageSource).toContain('aria-label="关闭提示"');
    expect(timelineSource).toContain("emit('assignMaterial', materialId, slotId)");
    expect(timelineSource).toContain('@dragover="onTrackDragOver"');
    expect(timelineSource).toContain("'is-material-target': materialDropSlotId === slot.id");
    expect(timelineSource).toContain('translate3d(${playheadLeft}px, 0, 0)');
    expect(timelineSource).toContain('--timeline-bg: #f6f8fc');
    expect(pageSource).toContain('aria-label="调整预览区与时间轴高度"');
    expect(pageSource).toContain('@pointerdown="startEditorHeightResize"');
    expect(timelineSource).toContain('aria-label="调整轨道控制区宽度"');
    expect(timelineSource).toContain('@pointerdown="startTimelineResize"');
    expect(timelineSource).toContain("'--track-header-width': `${trackHeaderWidth.value}px`");
    expect(timelineSource).toContain("'--timeline-height': `${props.height}px`");
    expect(timelineSource).toContain('min-height: 100%');
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
  it('draws real waveforms on taller Jianying-style voice, caption and BGM lanes', () => {
    expect(timelineSource).toContain('const AUDIO_LANE_HEIGHT = 50');
    expect(timelineSource).toContain('const AUDIO_CLIP_HEIGHT = 44');
    expect(timelineSource).toContain('* AUDIO_LANE_HEIGHT');
    expect(timelineSource).toContain('const audioWaveformBarCount');
    expect(timelineSource).toContain('layout="fill"');
    expect(timelineSource).toContain('const timelineCaptionEntries');
    expect(timelineSource).toContain('id: `caption:${caption.id}`');
    expect(timelineSource).toContain('const fileUrl');
    expect(timelineSource).toContain('/file-objects/${id}/content');
    expect(timelineSource).toContain('class="caption-clip-text"');
    expect(timelineSource).toContain('class="audio-volume-line"');
    expect(timelineSource).toContain('const beginAudioVolume');
    expect(timelineSource).toContain('const beginAudioTrim');
    expect(timelineSource).toContain('const onCaptionPointerDown');
    expect(timelineSource).toContain('const captionBounds');
    expect(timelineSource).toContain('drag.maxEnd - drag.initialDuration');
    expect(timelineSource).toContain("emit('moveAudioClip'");
    expect(timelineSource).toContain("'resizeAudioClip',");
    expect(timelineSource).toContain("emit('changeAudioVolume'");
    expect(waveformSource).toContain("{ tone: 'VIDEO', layout: 'strip' }");
    expect(waveformSource).toContain('.clip-waveform.is-layout-fill');
    expect(waveformSource).toContain('.clip-waveform.is-tone-voice');
    expect(waveformSource).toContain('.clip-waveform.is-tone-music');
    // Captions are their own cards now, so no waveform tone is reserved for them.
    expect(waveformSource).not.toContain('is-tone-caption');
    expect(waveformSource).toContain('pointer-events: none');
    expect(pageSource).toContain('updateEffectPackagingAudio');
    expect(pageSource).toContain('@move-audio-clip="movePackagingAudio"');
    expect(pageSource).toContain('@resize-audio-clip="resizePackagingAudio"');
    expect(pageSource).toContain('@change-audio-volume="changePackagingAudioVolume"');
    expect(pageSource).toContain('expectedUpdatedAt');
    // Unsaved audio geometry is scoped to its item, so diffs and rollbacks cannot cross items.
    expect(pageSource).toContain('itemId: string;');
    expect(pageSource).toContain('baseline.itemId !== item.id');
    expect(pageSource).toContain('audioBaseline?.itemId === current.id) void flushAudioEdit();');
    expect(pageSource).toContain('if (audioBaseline?.itemId === targetId) audioBaseline = null;');
    expect(timelineSource).toContain('() => props.packaging?.id');
    // Only a finished item can be saved, so unfinished drafts must not offer drag/trim handles.
    expect(timelineSource).toContain(
      "const audioEditable = computed(() => props.packaging?.status === 'COMPLETED');",
    );
    expect(timelineSource).toContain('editable: audioEditable.value');
    expect(timelineSource).toContain('v-if="audioEditable && selectedAudioIds.includes(entry.id)"');
    expect(timelineSource).toContain('if (!audioEditable.value) {');
  });
  it('renders captions as standalone cards, in the preview and as an editable row', () => {
    // Each caption is its own selectable card with a fixed type icon on the left.
    expect(timelineSource).toContain('class="caption-clip-icon"');
    expect(timelineSource).toContain('<Captions class="caption-clip-icon"');
    expect(timelineSource).toContain('border-radius: 6px');
    expect(timelineSource).toContain('background: #8c3b2e');
    // Subtitle cards are slimmer than the audio lanes they sit beside, as in CapCut.
    expect(timelineSource).toContain('const CAPTION_LANE_HEIGHT = 34');
    expect(timelineSource).toContain('const CAPTION_CLIP_HEIGHT = 28');
    expect(timelineSource).toContain('height: `${CAPTION_CLIP_HEIGHT}px`');
    expect(timelineSource).toContain('* CAPTION_LANE_HEIGHT');
    expect(timelineSource).toContain('height: 22px');
    // The lane paints no waveform for captions any more.
    expect(timelineSource).not.toContain('is-waveform');
    // Selecting a card publishes it so the editor row above the timeline can follow it.
    expect(timelineSource).toContain("emit('selectAudioClip'");
    expect(timelineSource).toContain("selectAudioClip: [clipId: string | null]");
    // The burned-in subtitle is mirrored on the stage from the same checkpoint geometry.
    expect(pageSource).toContain('const previewCaption');
    expect(pageSource).toContain('class="player-caption"');
    expect(pageSource).toContain('stageCaptionFontSize');
    expect(pageSource).toContain('const DEFAULT_CAPTION_BOX: PackagingCaptionBox');
    expect(pageSource).toContain('const captionBoxStyle = (id: string)');
    // Clicking a card opens a single-line text editor in the row above the timeline.
    expect(pageSource).toContain('const editingCaption');
    expect(pageSource).toContain('class="caption-text-editor"');
    expect(pageSource).toContain('const changeCaptionText');
    expect(pageSource).toContain('@select-audio-clip="onAudioClipSelected"');
    expect(pageSource).toContain('checkpoint.captions?.find((c) => c.id === captionId)');
  });
  it('makes the in-video caption selectable, draggable and resizable with snap guides', () => {
    // Both directions of the selection are wired: preview -> timeline and timeline -> preview.
    expect(pageSource).toContain(':selected-audio-clip-id="');
    expect(pageSource).toContain('`caption:${selectedCaptionId}`');
    expect(timelineSource).toContain('selectedAudioClipId?: string | null;');
    expect(timelineSource).toContain('() => props.selectedAudioClipId');
    // Selecting must not move the playhead.
    expect(timelineSource).not.toContain("props.selectedAudioClipId) seek");
    // The caption's own frame stays white; green is reserved for the player's snap lines.
    expect(pageSource).toContain('class="player-caption-box"');
    expect(pageSource).toContain('.player-caption-box.is-selected');
    expect(pageSource).toContain('outline: 2px solid #fff');
    expect(pageSource).toContain('background: #22c55e');
    // The frame never borrows the guide's colour; it is always plain white.
    expect(pageSource).not.toContain('var(--caption-guide)');
    // The frame hugs the caption's own glyphs, and is drawn only while it is the selected one.
    expect(pageSource).toContain('.player-caption-box.is-selected .player-caption');
    expect(pageSource).toContain('display: flex');
    expect(pageSource).toContain('justify-content: center');
    expect(pageSource).toContain('outline-offset: 2px');
    // No handle chrome: the frame's own left/right grab zones do the stretching.
    expect(pageSource).not.toContain('caption-box-handle');
    expect(pageSource).toContain('@pointerdown="onCaptionBoxPointerDown"');
    expect(pageSource).toContain('const captionDragMode = (clientX: number, rect: DOMRect)');
    expect(pageSource).toContain('const CAPTION_EDGE_GRAB = 10');
    // The stretch zones straddle the frame edges and are bounded, so the empty wrap space next
    // to a short caption still moves it rather than stretching it.
    expect(pageSource).toContain('clientX >= rect.left - CAPTION_EDGE_GRAB && clientX <= rect.left + CAPTION_EDGE_GRAB');
    expect(pageSource).toContain('clientX >= rect.right - CAPTION_EDGE_GRAB && clientX <= rect.right + CAPTION_EDGE_GRAB');
    expect(pageSource).toContain("box.querySelector<HTMLElement>('.player-caption')");
    expect(pageSource).toContain('setPointerCapture(event.pointerId)');
    // A solid dot on the top-left corner scales the text; dragging it up enlarges.
    expect(pageSource).toContain('class="caption-scale-handle"');
    expect(pageSource).toContain("onCaptionBoxPointerDown($event, 'SCALE')");
    expect(pageSource).toContain("'MOVE' | 'LEFT' | 'RIGHT' | 'SCALE'");
    expect(pageSource).toContain('border-radius: 50%');
    expect(pageSource).toContain('cursor: nwse-resize');
    expect(pageSource).toContain('frameBottom: frame.bottom');
    expect(pageSource).toContain('(origin.scale * distance) / startDistance');
    // Five snap lines: the player's four borders plus the middle column, nothing else.
    expect(pageSource).toContain('class="caption-guide is-vertical"');
    expect(pageSource).toContain('class="caption-guide is-horizontal"');
    expect(pageSource).toContain('const snapAxis = (');
    expect(pageSource).toContain('{ target: half, guide: 0 }');
    expect(pageSource).toContain('{ target: 1 - half, guide: 1 }');
    expect(pageSource).toContain('{ target: 0, guide: 0 }');
    expect(pageSource).toContain('{ target: 1 - drag.height, guide: 1 }');
    expect(pageSource).toContain('{ target: 0.5, guide: 0.5 }');
    // A line on the far border would be clipped by the stage, so it is pulled back its own width.
    expect(pageSource).toContain('const captionGuideOffset = (value: number)');
    expect(pageSource).toContain('--caption-guide-width: 2px');
    expect(pageSource).toContain("' - var(--caption-guide-width)'");
    expect(pageSource).toContain('const CAPTION_SNAP = 0.015');
    // The caption stops on the frame's edge, so the clamp uses the frame width, not the wrap box.
    expect(pageSource).toContain('frameWidth: frame.width / bounds.width');
    expect(pageSource).toContain('const half = Math.min(0.5, drag.frameWidth / 2)');
    // Font size sits next to the text box and is stored as a scale of the pipeline default.
    expect(pageSource).toContain('class="caption-font-size"');
    expect(pageSource).toContain('aria-label="增大字号"');
    expect(pageSource).toContain('const changeCaptionScale = (step: number)');
    // Geometry is checkpoint state, so it is persisted rather than preview-only.
    expect(pageSource).toContain('checkpoint.captionBoxes = { ...(checkpoint.captionBoxes ?? {}),');
    expect(pageSource).toContain('...(Object.keys(diff.boxes).length ? { boxes: diff.boxes } : {})');
  });
  it('selects several captions at once and edits their geometry as one group', () => {
    // The caption lane marquees exactly like the video lane, and Ctrl/Cmd toggles one card.
    expect(timelineSource).toContain("track: 'VIDEO' | 'CAPTION' | 'AUDIO';");
    expect(timelineSource).toContain('const captionTrack = ref<HTMLElement | null>(null);');
    expect(timelineSource).toContain(':ref="setCaptionTrackElement"');
    expect(timelineSource).toContain('captionTrack.value');
    expect(timelineSource).toContain("track === 'VIDEO' || track === 'CAPTION'");
    expect(timelineSource).toContain('selectCaptionClips: [captionIds: string[]];');
    expect(timelineSource).toContain('if (event.ctrlKey || event.metaKey) {');
    expect(timelineSource).toContain('const captionGroupIds = (draggedId: string): string[]');
    // A group slides rigidly, so the shared delta is capped by the caption nearest the start.
    expect(timelineSource).toContain('const shared = Math.max(delta, -earliest);');
    expect(pageSource).toContain('@select-caption-clips="onCaptionClipsSelected"');
    expect(pageSource).toContain('const selectedCaptionIds = ref<string[]>([]);');
    expect(pageSource).toContain('const onCaptionClipsSelected = (captionIds: string[]): void');
    // Only a lone caption feeds the text editor, which is why the id is derived rather than held.
    expect(pageSource).toContain('selectedCaptionIds.value.length === 1 ? selectedCaptionIds.value[0]! : null');
    // A caption click arrives on its own event, so the audio channel must not clear the set.
    expect(pageSource).toContain("if (clipId?.startsWith('caption:')) return;");
    // Every selected caption's starting geometry is captured, so the drag can move them together.
    expect(pageSource).toContain('boxes: Record<string, PackagingCaptionBox>;');
    expect(pageSource).toContain('boxes: Object.fromEntries(ids.map((id) => [id, { ...captionBox(id) }]))');
    // The grabbed caption is the standard, so the rest take its position outright. Sliding the set
    // by one shared delta is what used to pin a caption to the border it had been dragged onto.
    expect(pageSource).not.toContain('slideX');
    expect(pageSource).not.toContain('lowX');
    expect(pageSource).toContain('Math.min(Math.max(origin.x + dx, half), 1 - half)');
    expect(pageSource).toContain('Math.min(Math.max(origin.y + dy, 0), Math.max(0, 1 - drag.height))');
    expect(pageSource).toContain(
      'next[id] = { ...drag.boxes[id]!, x: across.value, y: down.value, scale: origin.scale };',
    );
    // Wrap width belongs to one caption's text, so a stretch never reaches the rest of the set.
    expect(pageSource).toContain("const ids = mode === 'LEFT' || mode === 'RIGHT' ? [caption.id] : selectedCaptionIds.value;");
    // Scaling the set keeps one size, and the stepper is offered for a multi-selection too.
    expect(pageSource).toContain('for (const id of ids) boxes[id] = { ...captionBox(id), scale };');
    expect(pageSource).toContain('已选中 {{ selectedCaptionIds.length }} 条字幕');
    expect(pageSource).toContain('selectedCaptionIds.includes(previewCaption.id)');
  });
  it('marquees the audio lane and adjusts a voice/BGM group as one', () => {
    expect(timelineSource).toContain('const audioTrack = ref<HTMLElement | null>(null);');
    expect(timelineSource).toContain(':ref="setAudioTrackElement"');
    expect(timelineSource).toContain('const setAudioTrackElement = (element: unknown): void');
    // The audio lane marquees like the other two, and only picks its own blocks.
    expect(timelineSource).toContain("track === 'VIDEO' || track === 'CAPTION' || track === 'AUDIO'");
    expect(timelineSource).toContain("box?.track === 'AUDIO'");
    expect(timelineSource).toContain('const audioGroupIds = (): string[]');
    expect(timelineSource).toContain("selectedAudioIds.value.filter((id) => !id.startsWith('caption:'))");
    expect(timelineSource).toContain('const dragGroupIds = (id: string): string[]');
    // Legacy read-only audio has no checkpoint behind it, so it never joins a group.
    expect(timelineSource).toContain('.filter((audio) => audio.editable)');
    // Ctrl/Cmd toggles one block, and a plain click keeps an existing set so it can be dragged.
    expect(timelineSource).toContain('const group = audioGroupIds();');
    expect(timelineSource).toContain('if (!audioGroupIds().includes(audio.id)) selectAudio(audio.id);');
    // A set slides rigidly: the shared delta is bounded by whichever block leaves the timeline first.
    expect(timelineSource).toContain('const shared = Math.min(');
    expect(timelineSource).toContain('timelineDuration.value - latest,');
    expect(timelineSource).toContain(
      "for (const clip of clips) emit('moveAudioClip', clip.id, Math.max(0, clip.start + shared));",
    );
    // Volume is the audio counterpart of caption size, and each kind keeps its own ceiling.
    expect(timelineSource).toContain('Math.min(audio.currentVolume, audioVolumeMax(clip.kind))');
  });
  it('edits volume, fade-in and fade-out for a voice/BGM selection from one standard', () => {
    // The timeline reports the whole voice/music set, captions excluded: they own the font stepper.
    expect(timelineSource).toContain('selectAudioClips: [clipIds: string[]];');
    expect(timelineSource).toContain("emit(\n      'selectAudioClips',\n      ids.filter((id) => !id.startsWith('caption:')),");
    expect(pageSource).toContain('@select-audio-clips="onAudioClipsSelected"');
    expect(pageSource).toContain('const selectedAudioClipIds = ref<string[]>([]);');
    expect(pageSource).toContain('const onAudioClipsSelected = (clipIds: string[]): void');
    // The row mirrors the caption font stepper's markup, in its own palette.
    expect(pageSource).toContain('class="audio-edit-row"');
    expect(pageSource).toContain('v-else-if="audioStandard"');
    expect(pageSource).toContain('class="audio-stepper"');
    for (const label of ['减小音量', '增大音量', '减小淡入', '增大淡入', '减小淡出', '增大淡出']) {
      expect(pageSource).toContain(`aria-label="${label}"`);
    }
    expect(pageSource).toContain('音量 {{ audioStandardVolume }}%');
    expect(pageSource).toContain("淡入 {{ audioStandardFade('fadeIn') }}s");
    expect(pageSource).toContain("淡出 {{ audioStandardFade('fadeOut') }}s");
    // The pipeline default is written in exactly one place, and the worker is named as its source.
    expect(pageSource).toContain('const MUSIC_DEFAULT_FADE = 0.5;');
    expect(pageSource).toContain('final_output.py');
    expect(pageSource).toContain('const audioVolumeMax = (kind: \'MUSIC\' | \'VOICE\'): number');
    expect(pageSource).toContain('const audioFade = (');
    // Every step is read from the standard and written to the whole set, clamped per clip.
    expect(pageSource).toContain('const audioStandard = computed<{ kind: \'MUSIC\' | \'VOICE\'; audio: PackagingAudio } | null>');
    // The grabbed block leads the set, so the pointer is what the group aligns to.
    expect(timelineSource).toContain('selectedAudioIds.value = [audio.id, ...selectedAudioIds.value.filter((id) => id !== audio.id)];');
    expect(pageSource).toContain('const changeAudioVolumeStep = (step: number): void');
    expect(pageSource).toContain('const changeAudioFadeStep = (edge: \'fadeIn\' | \'fadeOut\', step: number): void');
    expect(pageSource).toContain('audio.volume = Math.min(audioVolumeMax(target.kind), Math.max(0, stepped));');
    expect(pageSource).toContain('audio[edge] = Math.round(Math.min(stepped, ceiling) * 100) / 100;');
    // Absent means "pipeline default", so the diff has to compare effective seconds or a music fade
    // dragged from 0.5s down to 0 would look unchanged and never be saved.
    expect(pageSource).toContain('audioFade(left, kind, \'fadeIn\') === audioFade(right, kind, \'fadeIn\')');
    expect(pageSource).toContain('fadeIn: audioFade(audio, kind, \'fadeIn\'),');
    expect(pageSource).toContain('fadeOut: audioFade(audio, kind, \'fadeOut\'),');
    expect(pageSource).toContain('sameAudio(before, audio, \'VOICE\')');
    expect(pageSource).toContain('sameAudio(baseline.music, current.music, \'MUSIC\')');
    expect(pageSource).toContain("audioEdit(current.music, 'MUSIC')");
  });
  it('lets a snapped caption be dragged back off the line', () => {
    // Once the caption nearly fills the frame the centre and both borders collapse together, so a
    // fixed threshold would merge the three zones into one no drag could escape.
    expect(pageSource).toContain('const snapThreshold = (span: number): number');
    expect(pageSource).toContain('Math.min(CAPTION_SNAP, Math.max(0, span) / 3)');
    expect(pageSource).toContain('snapThreshold(0.5 - half)');
    expect(pageSource).toContain('snapThreshold(1 - drag.height)');
    // The frame is capped at the wrap box, so it can never grow as wide as the stage itself.
    expect(pageSource).toContain('min-width: 0;');
    expect(pageSource).toContain('overflow-wrap: anywhere;');
  });
  it('clears the selection on a blank click but not while scrubbing', () => {
    // The player clears everywhere except the picture itself.
    expect(pageSource).toContain('@pointerdown="onPlayerPanelPointerDown"');
    expect(pageSource).toContain('const onPlayerPanelPointerDown = (event: PointerEvent): void');
    expect(pageSource).toContain("target.closest('.stage')");
    // The timeline clears everywhere except its own material and the two scrubbing gestures.
    expect(timelineSource).toContain('@pointerdown="onShellPointerDown"');
    expect(timelineSource).toContain('const onShellPointerDown = (event: PointerEvent): void');
    expect(timelineSource).toContain(
      "'.time-ruler, .timeline-playhead, [data-slot-id], [data-audio-id], .selection-marquee'",
    );
    expect(timelineSource).toContain('const clearSelection = (): void');
    expect(timelineSource).toContain('defineExpose({ clearSelection })');
    expect(pageSource).toContain('timelineRef.value?.clearSelection()');
    expect(pageSource).toContain('const timelineRef = ref<{ clearSelection: () => void } | null>(null);');
  });
  it('sizes the track area so the lanes scroll instead of being clipped', () => {
    // The toolstrip lives inside the height the editor allots, so it has to come out of the tracks.
    expect(timelineSource).toContain('--timeline-toolstrip-height: 42px;');
    expect(timelineSource).toContain('height: var(--timeline-toolstrip-height);');
    expect(timelineSource).toContain(
      'calc(var(--timeline-height, 220px) - var(--timeline-toolstrip-height))',
    );
    // A thin bar is hard to grab, and this is the only way to reach a lane below the fold.
    expect(timelineSource).toContain('width: 12px;');
    expect(timelineSource).toContain('scrollbar-width: auto;');
  });
  it('scrolls the lanes with the wheel from anywhere in the timeline', () => {
    // A fixed floor a couple of pixels above the viewport painted a bar that could not scroll.
    expect(timelineSource).not.toContain('min-height: 220px;');
    expect(timelineSource).toContain('min-height: 100%;');
    expect(timelineSource).toContain('height: 100%;');
    // The lane headers are their own scroll column and used to swallow the wheel over their half.
    expect(timelineSource).toContain('<div class="timeline-workarea" @wheel="onWheel">');
    expect(timelineSource).toContain('const wheelDelta = (event: WheelEvent): number');
    // A line-based mouse reports three lines, which crept the tracks three pixels a notch.
    expect(timelineSource).toContain('if (event.deltaMode === 1) return event.deltaY * 16;');
    expect(timelineSource).toContain('element.scrollTop += delta;');
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
    expect(pageSource).toContain('const CENTER_PANE_MIN_WIDTH = 380');
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
  it('retains real material thumbnails outside the compact timeline', () => {
    expect(pageSource).toContain('EffectTemplateMixThumbnail');
    expect(thumbnailSource).toContain('retainEffectTemplateMixThumbnail');
    expect(thumbnailSource).toContain('releaseEffectTemplateMixThumbnail');
    expect(thumbnailSource).toContain('-webkit-user-drag: none');
    expect(thumbnailSource).toContain('@dragstart.prevent');
    expect(pageSource).toContain('.thumb :deep(img)');
    expect(pageSource).toContain('pointer-events: none');
    expect(pageSource).toContain('beginMaterialPointerDrag');
    expect(pageSource).toContain("className = 'material-drag-ghost'");
    expect(pageSource).toContain('draggable="false"');
    expect(timelineSource).toContain('is-material-pointer-target');
    expect(thumbnailCacheSource).toContain('!pinCounts.has(key)');
    expect(thumbnailCacheSource).toContain('retryAfter.set(key');
    expect(thumbnailCacheSource).toContain("video.addEventListener('canplay', capture)");
    expect(thumbnailCacheSource).not.toContain('failedKeys');
  });
});
