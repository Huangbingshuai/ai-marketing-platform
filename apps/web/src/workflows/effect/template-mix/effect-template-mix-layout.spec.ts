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
    expect(pageSource).toContain('const videoTrackMuted = ref(false);');
    expect(pageSource).toContain('const voiceTrackMuted = ref(false);');
    expect(pageSource).toContain('const musicTrackMuted = ref(false);');
    expect(pageSource).toContain(':voice-muted="voiceTrackMuted"');
    expect(pageSource).toContain(':music-muted="musicTrackMuted"');
    expect(pageSource).toContain('@toggle-audio-mute="setTimelineTrackMute"');
    expect(pageSource).toContain('startPlaybackAudio');
    expect(pageSource).toContain('workspace.materials.length < 6');
    expect(pageSource).not.toContain(
      '!selectedVariant ||\n                workspace.materials.length < 6',
    );
    expect(pageSource).toContain('<LoaderCircle v-if="activeAiRun" class="spin" :size="15" />');
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
    expect(timelineSource).toContain('const hasCaptionTrack = computed(() => true);');
    expect(timelineSource).toContain("const audioTracks: TimelineAudioKind[] = ['VOICE', 'MUSIC'];");
    expect(timelineSource).toContain('const assignIntervalLanes');
    // The old fixed three-lane grid is gone, and no empty row is reserved either: lanes are
    // compacted, and the row a downward drag reaches for exists only while that drag is live.
    expect(timelineSource).not.toContain('Math.max(2,');
    expect(timelineSource).not.toContain('Math.min(3,');
    expect(timelineSource).not.toContain('未配置字幕');
    expect(timelineSource).not.toContain('未配置音频');
    expect(timelineSource).toContain("type VisibleTrack = 'CAPTION' | 'MUSIC' | 'VIDEO' | 'VOICE'");
    expect(timelineSource).toContain('voiceMuted?: boolean');
    expect(timelineSource).toContain('musicMuted?: boolean');
    expect(timelineSource).toContain("toggleAudioMute: [kind: TimelineAudioKind | 'VIDEO', muted: boolean]");
    expect(timelineSource).toContain("emit('toggleAudioMute', track,");
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
    expect(pageSource).not.toContain(
      'if (transition?.incomingSlot.id === slotId) return transition.start;',
    );
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
    // Rows are compacted rather than reserved, and a drag cannot inflate the count while it moves:
    // the row a drop needs is created on release, which also keeps the rows the pointer is measured
    // against from shifting under it mid-drag.
    expect(timelineSource).toContain('Math.max(1, occupiedVideoLaneValues.value.length)');
    expect(timelineSource).not.toContain('nextFreeVideoLane');
    // Free vertical travel: no clamp to the occupied lanes, so the ghost can cross any clip, any row
    // and any neighbouring track while the pointer moves. Measured from a row's centre so it rounds to
    // a lane in the gap between two rows rather than the instant it leaves one.
    expect(timelineSource).toContain('const pointerTop = clientY - videoBounds.top - 38;');
    expect(timelineSource).toContain('drag.currentLane = Math.round(pointerTop / 70);');
    expect(timelineSource).toContain('videoBounds.height > 0');
    expect(timelineSource).not.toContain('clientYInVideoTrack');
    // The ghost follows the pointer pixel for pixel rather than hopping a row at a time, so the drag
    // reads as one continuous movement — including over lanes that have no row yet.
    expect(timelineSource).toContain('drag.ghostTop = pointerTop;');
    expect(timelineSource).toContain('top: `${drag.ghostTop}px`,');
    expect(timelineSource).not.toContain('top: `${7 + drag.currentLane * 70}px`,');
    // The rest of a dragged selection rides the same continuous offset, so a group moves as one piece.
    expect(timelineSource).toContain('topPx: drag.ghostTop - originTop,');
    expect(timelineSource).toContain(
      "? 7 + (drag?.initialLanes[slot.id] ?? clipLane(slot.id)) * 70 + (delta?.topPx ?? 0)",
    );
    expect(timelineSource).toContain('Math.hypot(');
    expect(pageSource).toContain('beginMaterialPointerDrag');
    expect(pageSource).toContain("className = 'material-drag-ghost'");
    expect(pageSource).toContain(':draggable="Boolean(selectedVariant)"');
    expect(pageSource).not.toContain('过期素材不能重新拖入槽位');
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
    expect(pageSource).toContain(':class="{ \'is-empty\': !workspace.variants.length }"');
    expect(pageSource).toContain('.projects > div.is-empty');
    expect(pageSource).toContain('.project-actions .button svg');
    expect(pageSource).toContain('line-height: 1;');
    expect(pageSource).toContain(':src="materialForSlot(slot.id)?.contentUrl"');
    expect(pageSource).toContain(':src="auditionMaterial.contentUrl"');
    expect(pageSource).toContain('const previewSlot = computed');
    expect(pageSource).toContain('class="player-blackout"');
    expect(pageSource).not.toContain('class="player-source-error"');
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
    expect(timelineSource).toContain(
      "event.target.closest<HTMLButtonElement>('.edge-trim-handle')",
    );
    expect(timelineSource).toContain('if (edgeHandle?.disabled)');
    expect(timelineSource).toContain('const edgeThreshold = Math.min(12');
    expect(timelineSource).toContain(':disabled="edgeTrimBlocked(slot.id, \'LEFT\')"');
    expect(timelineSource).toContain(':disabled="edgeTrimBlocked(slot.id, \'RIGHT\')"');
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
    expect(waveformSource).toContain("{ tone: 'VIDEO', layout: 'strip', fadeIn: 0, fadeOut: 0, gain: 1 }");
    expect(waveformSource).toContain('.clip-waveform.is-layout-fill');
    expect(waveformSource).toContain('.clip-waveform.is-tone-voice');
    expect(waveformSource).toContain('.clip-waveform.is-tone-music');
    // Captions are their own cards now, so no waveform tone is reserved for them.
    expect(waveformSource).not.toContain('is-tone-caption');
    expect(waveformSource).toContain('pointer-events: none');
    // Fades are drawn as a gain envelope, so the bars show the easing the worker will encode.
    expect(waveformSource).toContain('const envelope = (offset: number): number');
    expect(waveformSource).toContain('const rise = props.fadeIn > 0 ? offset / props.fadeIn : 1;');
    expect(waveformSource).toContain(
      'const fall = props.fadeOut > 0 ? (props.duration - offset) / props.fadeOut : 1;',
    );
    expect(waveformSource).toContain('return Math.max(0, Math.min(1, rise, fall));');
    expect(waveformSource).toContain(
      'return peak * envelope(((index + 0.5) / count) * props.duration) * Math.max(0, props.gain);',
    );
    expect(waveformSource).toContain('align-items: flex-end');
    expect(timelineSource).toContain(':gain="audioGain(audio)"');
    expect(timelineSource).toContain('class="audio-fade-mask audio-fade-in"');
    expect(timelineSource).toContain('class="audio-fade-mask audio-fade-out"');
    // The timeline resolves the effective fades and hands them to the strip.
    expect(timelineSource).toContain("packagingAudioFade(audio, 'VOICE', 'fadeIn')");
    expect(timelineSource).toContain(
      "packagingAudioFade(packaged.checkpoint.music, 'MUSIC', 'fadeOut')",
    );
    expect(timelineSource).toContain(':fade-in="audio.fadeIn"');
    expect(timelineSource).toContain(':fade-out="audio.fadeOut"');
    expect(timelineSource).toContain('fadeIn: number;');
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
    // Only a finished current item can be saved, so read-only checkpoints expose selection but not
    // drag/trim handles.
    expect(timelineSource).toContain(
      "() => props.packaging?.status === 'COMPLETED' && !props.packaging.stale,",
    );
    expect(timelineSource).toContain('editable: audioEditable.value');
    expect(timelineSource).toContain('v-if="audioEditable && selectedAudioIds.includes(entry.id)"');
    expect(timelineSource).toContain('if (!audioEditable.value) return;');
  });
  it('lines any lane up against any other lane with one shared snap guide', () => {
    // Every head and tail on the timeline feeds one pool, so a caption can be snapped onto the
    // voiceover it belongs to instead of only onto its own lane.
    expect(timelineSource).toContain('type SnapEdge = { ownerId: string; time: number };');
    expect(timelineSource).toContain('const snapEdges = computed<SnapEdge[]>(() => {');
    expect(timelineSource).toContain('{ ownerId: entry.id, time: entry.caption.start },');
    expect(timelineSource).toContain('{ ownerId: entry.id, time: entry.caption.end },');
    expect(timelineSource).toContain('{ ownerId: audio.id, time: audio.start },');
    expect(timelineSource).toContain('{ ownerId: audio.id, time: audio.start + audio.duration },');
    // The timeline's end is derived from the clips, so it is not an edge to snap to.
    expect(timelineSource).not.toContain("{ ownerId: '', time: timelineDuration.value }");
    // A block cannot snap to itself, or to the group travelling with it — not even the lone block,
    // which would otherwise catch on the position it was dragged away from.
    expect(timelineSource).toContain('if (ignored.has(edge.ownerId)) continue;');
    expect(timelineSource).toContain('new Set([drag.id, ...dragGroupIds(drag.id)])');
    expect(timelineSource).toContain('new Set(drag.selectedSlotIds)');
    // Both ends of the dragged block get a turn at every edge, not just its head.
    expect(timelineSource).toContain('const snapDraggedBlock = (');
    expect(timelineSource).toContain('[0, rawStart],');
    expect(timelineSource).toContain('[duration, rawStart + duration],');
    expect(timelineSource).toContain('const start = edge.time - offset;');
    // A snap that would leave the window the caller already allows is not a snap.
    expect(timelineSource).toContain('start < window.minStart || start > window.maxStart');
    expect(timelineSource).toContain('const threshold = 7 / pixelsPerSecond.value;');
    // All three drag gestures go through it, and the guide is one shared time, not a track offset.
    expect(timelineSource).toContain('const snapGuideTime = ref<number | null>(null);');
    expect(timelineSource).toContain(
      'const snapGuideLeft = computed(() =>\n  snapGuideTime.value === null ? null : snapGuideTime.value * pixelsPerSecond.value,\n);',
    );
    expect(timelineSource).toContain('snapGuideTime.value = snapped.guide;');
    expect(timelineSource).toContain('snapGuideTime.value = null;\n  clipDrag.value = null;');
    // The line lives on the canvas, so it spans the ruler and every lane rather than one track.
    expect(timelineSource).toContain('v-if="snapGuideLeft !== null"');
    expect(timelineSource).toContain(':style="{ left: `${snapGuideLeft}px` }"');
    expect(timelineSource).not.toContain('dropGuideLeft');
    expect(timelineSource).toContain('z-index: 17;\n  top: 0;\n  bottom: 0;');
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
    expect(timelineSource).toContain('selectAudioClip: [clipId: string | null]');
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
    expect(timelineSource).not.toContain('props.selectedAudioClipId) seek');
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
    expect(pageSource).toContain(
      'clientX >= rect.left - CAPTION_EDGE_GRAB && clientX <= rect.left + CAPTION_EDGE_GRAB',
    );
    expect(pageSource).toContain(
      'clientX >= rect.right - CAPTION_EDGE_GRAB && clientX <= rect.right + CAPTION_EDGE_GRAB',
    );
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
    expect(pageSource).toContain(
      '...(Object.keys(diff.boxes).length ? { boxes: diff.boxes } : {})',
    );
  });
  it('selects several captions at once and edits their geometry as one group', () => {
    // The caption lane marquees exactly like the video lane, and Ctrl/Cmd toggles one card.
    expect(timelineSource).toContain('track: VisibleTrack;');
    expect(timelineSource).toContain('const captionTrack = ref<HTMLElement | null>(null);');
    expect(timelineSource).toContain(':ref="setCaptionTrackElement"');
    expect(timelineSource).toContain('captionTrack.value');
    expect(timelineSource).toContain("track === 'VIDEO' || track === 'CAPTION' || track === 'VOICE' || track === 'MUSIC'");
    expect(timelineSource).toContain('selectCaptionClips: [captionIds: string[]];');
    expect(timelineSource).toContain('if (event.ctrlKey || event.metaKey) {');
    expect(timelineSource).toContain('const captionGroupIds = (draggedId: string): string[]');
    // A group slides rigidly, so the shared delta is capped by the caption nearest the start.
    expect(timelineSource).toContain('const shared = Math.max(delta, -earliest);');
    expect(pageSource).toContain('@select-caption-clips="onCaptionClipsSelected"');
    expect(pageSource).toContain('const selectedCaptionIds = ref<string[]>([]);');
    expect(pageSource).toContain('const onCaptionClipsSelected = (captionIds: string[]): void');
    // Only a lone caption feeds the text editor, which is why the id is derived rather than held.
    expect(pageSource).toContain(
      'selectedCaptionIds.value.length === 1 ? selectedCaptionIds.value[0]! : null',
    );
    // A caption click arrives on its own event, so the audio channel must not clear the set.
    expect(pageSource).toContain("if (clipId?.startsWith('caption:')) return;");
    // Every selected caption's starting geometry is captured, so the drag can move them together.
    expect(pageSource).toContain('boxes: Record<string, PackagingCaptionBox>;');
    expect(pageSource).toContain(
      'boxes: Object.fromEntries(ids.map((id) => [id, { ...captionBox(id) }]))',
    );
    // The grabbed caption is the standard, so the rest take its position outright. Sliding the set
    // by one shared delta is what used to pin a caption to the border it had been dragged onto.
    expect(pageSource).not.toContain('slideX');
    expect(pageSource).not.toContain('lowX');
    expect(pageSource).toContain('Math.min(Math.max(origin.x + dx, half), 1 - half)');
    expect(pageSource).toContain(
      'Math.min(Math.max(origin.y + dy, 0), Math.max(0, 1 - drag.height))',
    );
    expect(pageSource).toContain(
      'next[id] = { ...drag.boxes[id]!, x: across.value, y: down.value, scale: origin.scale };',
    );
    // Wrap width belongs to one caption's text, so a stretch never reaches the rest of the set.
    expect(pageSource).toContain(
      "const ids = mode === 'LEFT' || mode === 'RIGHT' ? [caption.id] : selectedCaptionIds.value;",
    );
    // Scaling the set keeps one size, and the stepper is offered for a multi-selection too.
    expect(pageSource).toContain('for (const id of ids) boxes[id] = { ...captionBox(id), scale };');
    expect(pageSource).toContain('已选中 {{ selectedCaptionIds.length }} 条字幕');
    expect(pageSource).toContain('selectedCaptionIds.includes(previewCaption.id)');
  });
  it('marquees the independent voice/music lanes and adjusts an audio group as one', () => {
    expect(timelineSource).toContain('const voiceTrack = ref<HTMLElement | null>(null);');
    expect(timelineSource).toContain('const musicTrack = ref<HTMLElement | null>(null);');
    expect(timelineSource).toContain(':ref="(element) => setAudioTrackElement(track, element)"');
    expect(timelineSource).toContain('const setAudioTrackElement = (kind: TimelineAudioKind, element: unknown): void');
    // Each audio lane marquees only its own kind.
    expect(timelineSource).toContain("box?.track === 'VOICE'");
    expect(timelineSource).toContain("box?.track === 'MUSIC'");
    expect(timelineSource).toContain('.filter((audio) => audio.kind === box.track)');
    expect(timelineSource).toContain('const audioGroupIds = (): string[]');
    expect(timelineSource).toContain(
      "selectedAudioIds.value.filter((id) => !id.startsWith('caption:'))",
    );
    expect(timelineSource).toContain('const dragGroupIds = (id: string): string[]');
    // Read-only audio remains selectable even though its geometry cannot be edited.
    expect(timelineSource).toContain('if (!audio.editable) return;');
    // Ctrl/Cmd toggles one block, and a plain click keeps an existing set so it can be dragged.
    expect(timelineSource).toContain('const group = audioGroupIds();');
    expect(timelineSource).toContain(
      'if (!audioGroupIds().includes(audio.id)) selectAudio(audio.id);',
    );
    // A set slides rigidly: the shared delta is bounded by whichever block leaves the timeline first.
    expect(timelineSource).toContain('const shared = Math.min(');
    expect(timelineSource).toContain('timelineDuration.value - latest,');
    expect(timelineSource).toContain(
      "for (const clip of clips) emit('moveAudioClip', clip.id, Math.max(0, clip.start + shared));",
    );
    // Volume is the audio counterpart of caption size. The strip is a dB scale shared with the editor
    // row, so the pointer picks decibels and unity sits where the row says it does — a raw gain would
    // draw a normal level near the bottom of the strip.
    expect(timelineSource).toContain(
      'const audioLevel = (volume: number): number => packagingAudioLevel(volume);',
    );
    expect(timelineSource).toContain('return { top: `${(1 - audioLevel(volume)) * 100}%` };');
    expect(timelineSource).toContain(
      'PACKAGING_AUDIO_DB_FLOOR + Math.max(0, Math.min(1, ratio)) * audioDbSpan,',
    );
    expect(timelineSource).toContain('drag.currentVolume = packagingAudioFromDb(db);');
    // One scale for every kind, so a shared level needs no per-clip re-clamp.
    expect(timelineSource).not.toContain('audioVolumeMax');
    expect(timelineSource).toContain(
      'else for (const id of group) emit(\'changeAudioVolume\', id, audio.currentVolume);',
    );
  });
  it('edits volume, fade-in and fade-out for a voice/BGM selection from one standard', () => {
    // The timeline reports the whole voice/music set, captions excluded: they own the font stepper.
    expect(timelineSource).toContain('selectAudioClips: [clipIds: string[]];');
    expect(timelineSource).toContain(
      "emit(\n      'selectAudioClips',\n      ids.filter((id) => !id.startsWith('caption:')),",
    );
    expect(pageSource).toContain('@select-audio-clips="onAudioClipsSelected"');
    expect(pageSource).toContain('const selectedAudioClipIds = ref<string[]>([]);');
    expect(pageSource).toContain('const onAudioClipsSelected = (clipIds: string[]): void');
    // The grabbed block leads the set, so the pointer is what the group aligns to.
    expect(timelineSource).toContain(
      'selectedAudioIds.value = [audio.id, ...selectedAudioIds.value.filter((id) => id !== audio.id)];',
    );
    // The row is the shared parameter list, configured with one entry per adjustable number.
    expect(pageSource).toContain('class="audio-edit-row"');
    expect(pageSource).toContain('v-else-if="audioStandard"');
    expect(pageSource).toContain('<ParameterAdjustList');
    expect(pageSource).toContain('@update:model-value="onAudioParamsChange"');
    expect(pageSource).toContain('const audioParamItems = computed<ParameterAdjustItem[]>(() =>');
    expect(pageSource).toContain('const audioParamValues = computed<Record<string, number>>(() =>');
    expect(pageSource).toContain(
      'const onAudioParamsChange = (values: Record<string, number>): void',
    );
    // Label, unit, range and step all come from the config, and the fades share the clip's length.
    expect(pageSource).toContain("label: '音量'");
    expect(pageSource).toContain("unit: 'dB'");
    expect(pageSource).toContain("label: '淡入'");
    expect(pageSource).toContain("label: '淡出'");
    expect(pageSource).toContain('--parameter-row-flex: 0 1 auto;');
    expect(pageSource).toContain('--parameter-row-width: clamp(150px, 16vw, 218px);');
    expect(pageSource).toContain('--parameter-mark-label-display: none;');
    expect(pageSource).toContain('--parameter-input-align: center;');
    expect(pageSource).toContain('--parameter-track-fill: #2563eb;');
    expect(pageSource).toContain('--parameter-track-rest: #cbd5e1;');
    expect(pageSource).toContain('--parameter-thumb-width: 10px;');
    expect(pageSource).toContain('--parameter-thumb-height: 14px;');
    expect(pageSource).toContain('--parameter-thumb-radius: 4px;');
    expect(pageSource).toContain("unit: 's'");
    // A fade can never outlast its own clip, so the row's 6.1s top end is also capped by the room the
    // other edge leaves — the server rejects a pair whose sum exceeds the clip.
    expect(pageSource).toContain('const AUDIO_FADE_MAX = 6.1;');
    expect(pageSource).toContain('max: Math.min(AUDIO_FADE_MAX, Math.max(0, length - fadeOut)),');
    expect(pageSource).toContain('max: Math.min(AUDIO_FADE_MAX, Math.max(0, length - fadeIn)),');
    // Volume is shown in dB but stored as the gain the worker multiplies by, on a scale shared with
    // the timeline and the server's own check.
    expect(pageSource).toContain('const AUDIO_DB_FLOOR = PACKAGING_AUDIO_DB_FLOOR;');
    expect(pageSource).toContain('const audioToDb = packagingAudioToDb;');
    expect(pageSource).toContain('const audioFromDb = packagingAudioFromDb;');
    expect(pageSource).toContain('max: PACKAGING_AUDIO_DB_CEILING,');
    expect(pageSource).toContain("floorLabel: '-∞',");
    // The scale's two reference points: the bottom is silence, and unity is what an editor aims at.
    expect(pageSource).toContain("marks: [");
    expect(pageSource).toContain("{ value: AUDIO_DB_FLOOR, label: '-∞' },");
    expect(pageSource).toContain("{ value: 0, label: '0dB' },");
    // The row is one line, so the three numbers cost no more height than the caption stepper it swaps
    // with.
    expect(pageSource).toContain('--parameter-row-gap: 16px;');
    expect(pageSource).toContain('--parameter-label-width: 2.8em;');
    expect(pageSource).toContain(
      "const audioStandard = computed<{ kind: 'MUSIC' | 'VOICE'; audio: PackagingAudio } | null>",
    );
    // A row counts as edited only when it left the standard's own value, so nudging a fade cannot
    // silently rewrite a gain that was deliberately set to something else.
    expect(pageSource).toContain(
      'const volumeTouched = Math.abs(audioToDb(standard.audio.volume) - db) >= 0.5;',
    );
    expect(pageSource).toContain('const fadeInTouched =');
    expect(pageSource).toContain(
      'if (!volumeTouched && !fadeInTouched && !fadeOutTouched) return;',
    );
    // Only the row that moved is written, so a fade nudge cannot quietly rewrite a gain.
    expect(pageSource).toContain('if (fadeInTouched) {');
    expect(pageSource).toContain('if (fadeOutTouched) {');
    // A shorter clip in the set cannot hold the standard's pair, so each edge is capped by what the
    // clip's other, already-committed edge leaves — never past its own end.
    expect(pageSource).toContain(
      "const room = Math.max(0, audio.duration - packagingAudioFade(audio, target.kind, 'fadeOut'));",
    );
    expect(pageSource).toContain(
      "const room = Math.max(0, audio.duration - packagingAudioFade(audio, target.kind, 'fadeIn'));",
    );
    expect(pageSource).toContain('const fadeIn = Math.min(values.fadeIn ?? 0, room);');
    expect(pageSource).toContain('const fadeOut = Math.min(values.fadeOut ?? 0, room);');
    // One ceiling for every kind, matching what the server accepts, so the row's top end is reachable.
    expect(pageSource).toContain('audio.volume = audioFromDb(');
    expect(pageSource).toContain(
      'Math.min(PACKAGING_AUDIO_DB_CEILING, Math.max(AUDIO_DB_FLOOR, db)),',
    );
    // Absent means "pipeline default", so the diff has to compare effective seconds or a music fade
    // dragged from 0.5s down to 0 would look unchanged and never be saved.
    expect(pageSource).toContain(
      "packagingAudioFade(left, kind, 'fadeIn') === packagingAudioFade(right, kind, 'fadeIn')",
    );
    expect(pageSource).toContain("fadeIn: packagingAudioFade(audio, kind, 'fadeIn'),");
    expect(pageSource).toContain("fadeOut: packagingAudioFade(audio, kind, 'fadeOut'),");
    expect(pageSource).toContain("sameAudio(before, audio, 'VOICE')");
    expect(pageSource).toContain("sameAudio(baseline.music, current.music, 'MUSIC')");
    expect(pageSource).toContain("audioEdit(current.music, 'MUSIC')");
    // The palette is handed in, so the list itself stays free of colour and placement.
    expect(pageSource).toContain('--parameter-accent: #2563eb;');
    expect(pageSource).toContain('--parameter-field-background: #ffffff;');
  });
  it('keeps a stale packaging on the timeline instead of wiping its captions and audio', () => {
    // Nulling the prop on staleness is what used to empty the caption and audio lanes the moment a
    // lane moved: those packaged clips are the arrangement the user is looking at, so they stay put.
    expect(pageSource).toContain(':packaging="selectedPackaging"');
    expect(pageSource).not.toContain(
      ':packaging="selectedPackaging?.stale ? null : selectedPackaging"',
    );
    // Stale geometry is shown but never written: the server rejects a write whose timeline moved on.
    expect(pageSource).toContain(
      "selectedPackaging.value?.status === 'COMPLETED' && !selectedPackaging.value.stale",
    );
    expect(pageSource).toContain('if (item.stale) {');
    expect(pageSource).toContain('时间轴已改变，当前包装已过期，请重新生成包装后再编辑');
    // The timeline reads the same flag: kept, dimmed, and without the edit gestures.
    expect(timelineSource).toContain(
      "() => props.packaging?.status === 'COMPLETED' && !props.packaging.stale,",
    );
    expect(timelineSource).toContain(
      'const packagingStale = computed(() => Boolean(props.packaging?.stale));',
    );
    expect(timelineSource).toContain("'is-stale': packagingStale,");
    expect(timelineSource).toContain('.caption-clip.is-stale,\n.audio-clip.is-stale {');
    expect(timelineSource).toContain('opacity: 0.5;');
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
    expect(pageSource).toContain(
      'const timelineRef = ref<{ clearSelection: () => void } | null>(null);',
    );
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
