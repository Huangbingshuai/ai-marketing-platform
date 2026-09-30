import { describe, expect, it } from 'vitest';
import workflowSource from '../source-import/EffectImportNodePage.vue?raw';
import audioLanesSource from './effect-template-mix-audio-lanes.ts?raw';
import rawPageSource from './EffectTemplateMixNodePage.vue?raw';
import packagingSource from './EffectTemplateMixPackaging.vue?raw';
import thumbnailCacheSource from './effect-template-mix-thumbnail-cache.ts?raw';
import thumbnailSource from './EffectTemplateMixThumbnail.vue?raw';
import filmstripSource from './EffectTemplateMixFilmstrip.vue?raw';
import rawTimelineSource from './EffectTemplateMixTimeline.vue?raw';
import waveformSource from './EffectTemplateMixWaveform.vue?raw';

const pageSource = rawPageSource.replace(/\r\n/gu, '\n');
const timelineSource = rawTimelineSource.replace(/\r\n/gu, '\n');

describe('effect template mix workbench layout', () => {
  it('uses the shared delete confirmation and gives immediate feedback while checking render readiness', () => {
    expect(pageSource).toContain("import { requestActionConfirmation } from '../../../shared/composables/action-confirmation';");
    expect(pageSource).toContain('title: `删除模板「${entry.workspace.template.name}」？`');
    expect(pageSource).not.toContain('window.confirm(');
    expect(pageSource).toContain('模板列表 <small class="template-list__count">共 {{ catalog.length }} 个</small>');
    expect(pageSource).toContain("showNotice('尚未检测到已完成的渲染批次，正在刷新状态…', 'warning');");
    expect(pageSource).toContain(':disabled="checkingTemplateCreation"');
  });
  it('leaves the transition track empty at a direct cut while keeping drop-to-add available', () => {
    expect(timelineSource).toContain(
      "variant.slots.slice(1).filter((slot) => slot.transition !== '硬切')",
    );
    expect(timelineSource).not.toContain('is-hard-cut');
    expect(timelineSource).toContain('onTransitionDrop(event)');
    expect(pageSource).toContain("item === '硬切' ? '无转场' : item");
    expect(pageSource).toContain("item.id !== '硬切' && item.category !== '热门'");
  });
  it('mounts in the fifth workflow step', () => {
    expect(workflowSource).toContain(
      "import EffectTemplateMixNodePage from '../template-mix/EffectTemplateMixNodePage.vue'",
    );
    expect(workflowSource).toContain('v-else-if="activeStep === 4"');
  });
  it('keeps confirmed source clips when creating the first template', () => {
    expect(pageSource).toContain('sourceMaterials.value = data.materials;');
    expect(pageSource).toContain('entry.workspace.materials = sourceMaterials.value;');
  });
  it('only blocks packaging when the template needs an AI refill, not because a source changed', () => {
    expect(pageSource).toContain('const packagingActionBlockReason = computed(() => {');
    expect(pageSource).toContain('if (entry.needsAiFill)');
    expect(pageSource).not.toContain('material.artifactRevision !== variant.bindingRevisions[slot.id]');
    expect(pageSource).toContain('Boolean(packagingActionBlockReason)');
    expect(pageSource).toContain('packagingActionBlockReason ??');
    expect(pageSource).toContain("if (target === 'ACTION' && packagingActionBlockReason.value)");
    expect(pageSource).toContain('background: #fff;\n  border-color: #dbe3ef;\n  opacity: 1;');
  });
  it('supports same-template timeline copy and paste shortcuts and restores double-click audio separation', () => {
    expect(timelineSource).toContain("if (!editingText && key === 'c')");
    expect(timelineSource).toContain("if (!editingText && key === 'v')");
    expect(timelineSource).toContain('copyVideoSlots');
    expect(timelineSource).toContain('copyAudioClip');
    expect(timelineSource).toContain('pasteVideoMaterials');
    expect(timelineSource).toContain('pasteAudioMaterial');
    expect(timelineSource).toContain('复制素材');
    expect(timelineSource).toContain('粘贴素材');
    expect(timelineSource).toContain('@dblclick="onVideoClipDoubleClick($event, slot.id)"');
    expect(timelineSource).toContain("emit('separateAudio', slotId)");
    expect(timelineSource).toContain('() => props.templateId');
    expect(pageSource).toContain('@paste-video-materials="pasteTimelineVideoMaterials"');
    expect(pageSource).toContain('@paste-audio-material="pasteTimelineAudioMaterial"');
  });
  it('adds an editable caption clip at the playhead without stealing the caret', () => {
    expect(pageSource).toContain('const packaging = selectedPackaging.value;');
    expect(pageSource).toContain('if (!variant && !packaging)');
    expect(pageSource).toContain('if (packaging) {');
    expect(pageSource).toContain('manual: true,');
    expect(pageSource).toContain('...(manual ? { manual: true } : {})');
    expect(pageSource).toContain('const start = quantizeTimelineTime(playhead.value)');
    expect(pageSource).toContain('start + 3');
    expect(pageSource).toContain("text: '',");
    expect(pageSource).toContain('trackId: `subtitle-track-${Date.now()');
    expect(timelineSource).toContain(
      'assignEffectTemplateMixCaptionLanes(timelineCaptions.value, props.fps)',
    );
    expect(timelineSource).toContain("entry.caption.text || '新字幕'");
    expect(pageSource).toContain('selectedCaptionIds.value = [caption.id]');
    // Picking a caption must not pull the caret into the text box: Delete and Ctrl+Z are handed to a
    // focused input, so an auto-focused box turned "delete this subtitle" into "delete its text".
    expect(pageSource).not.toContain('watch(editingCaption');
    expect(pageSource).not.toContain('captionTextInput.value?.focus');
    // The box only gains focus by being clicked, so a timeline click has to take focus away itself —
    // every clip gesture calls preventDefault on pointerdown, so the browser never does it for us.
    expect(pageSource).toContain(
      'if (document.activeElement === captionTextInput.value) captionTextInput.value?.blur();',
    );
    // A pointer anywhere else in the workbench takes the keyboard back. Keying off the selection would
    // miss a card that was already selected: nothing changes, so nothing blurs, and Delete still lands
    // in the box.
    expect(pageSource).toContain('const onWorkbenchPointerDown = (event: PointerEvent): void => {');
    expect(pageSource).toContain('if (target instanceof Node && captionTextInput.value?.contains(target)) return;');
    expect(pageSource).toContain('@pointerdown.capture="onWorkbenchPointerDown"');
    // A focused control owns only the keys it can act on. Clicking 「添加」 leaves that button focused,
    // and a button-wide bail swallowed Delete and Ctrl+Z there — so "delete this subtitle" did nothing.
    expect(pageSource).toContain('const buttonOwnsKey =');
    expect(pageSource).toContain("(event.code === 'Space' || event.key === 'Enter');");
    expect(pageSource).not.toContain('(target?.matches(\'button\') &&');
    expect(pageSource).toContain("if (event.key === 'Delete' || event.key === 'Backspace') {");
    expect(pageSource).toContain('<strong>字幕</strong');
    expect(pageSource).toContain('<Plus :size="13" />添加');
    expect(pageSource).not.toContain('class="caption-list"');
    expect(pageSource).not.toContain('removeCaption');
    expect(pageSource).not.toContain('字幕样式');
    expect(pageSource).not.toContain('点击“添加”，在播放头位置新建字幕素材。');
    expect(pageSource).toContain('const captionItems = computed');
  });
  it('uses the real draft and material API', () => {
    expect(pageSource).toContain("from './api/effect-template-mix.api'");
    expect(pageSource).toContain('loadEffectTemplateMixWorkspace');
    expect(pageSource).toContain('saveEffectTemplateMixDraft');
    expect(pageSource).toContain('createEmptyEffectTemplateMixVariant');
    expect(pageSource).toContain('createEffectTemplateMixAiRun');
    expect(pageSource).toContain('getEffectTemplateMixAiRun');
    expect(pageSource).toContain('大模型按 Prompt 归槽');
    expect(pageSource).toContain('changeTrimStart');
    expect(pageSource).not.toMatch(/\bfillEffectTemplateMixVariant\b/u);
    expect(pageSource).not.toContain('syncEffectTemplateMixVariants');
    expect(pageSource).not.toMatch(/Mock|MOCK|createEffectTemplateMixMock/u);
  });
  it('drops 完成校验: packaging alone puts the films into the output queue', () => {
    // The button used to be the only thing that handed a film to the output node, so removing it is
    // what makes 智能成片包装 land in 待渲染区 on its own.
    expect(pageSource).not.toContain('completeEffectTemplateMixPackaging');
    expect(pageSource).not.toContain('validateDraft');
    expect(pageSource).toContain(':show-validate="false"');
    expect(pageSource).not.toContain('const completionKey');
    expect(pageSource).not.toContain('const canValidate');
  });
  it('syncs each saved draft silently and flushes the last edit on exit', () => {
    expect(pageSource).toContain('syncEffectFinalOutput');
    expect(pageSource).toContain('queueOutputSync(result.data.draftRevision, savedTemplateId)');
    expect(pageSource).toContain('expectedDraftRevision: queued.revision');
    expect(pageSource).toContain('const newerRevision = queuedOutputRevision();');
    expect(pageSource).toContain('const syncOutputOnExit = async (): Promise<boolean> => {');
    expect(pageSource).toContain('if (!(await flushPendingEdits())) return false;');
    expect(pageSource).not.toContain('已同步成片待渲染区 ${refreshedCount} 条');
    expect(pageSource).toContain('const returnToFinalOutput = async (): Promise<void> => {');
    expect(pageSource).toContain('if (!(await syncOutputOnExit())) return;');
    expect(pageSource).toContain('void syncOutputOnExit();');
  });
  it('never lets two draft saves share a revision', () => {
    // A drag outlives a save, so the debounce can fire again while the first request is still on the
    // wire. Both would carry the same revision and the second would come back as "节点内容已在其他
    // 页面更新" even though nothing is stale, so the saves are chained instead.
    expect(pageSource).toContain('const previous = pendingSave ?? Promise.resolve(true);');
    expect(pageSource).toContain('() => persistNow(keepalive),');
    expect(pageSource).toContain('const persistNow = async (keepalive = false): Promise<boolean> => {');
  });
  it('creates an empty film project separately from AI operations', () => {
    expect(pageSource).toContain('<Plus :size="13" />新建成片');
    expect(pageSource).toContain('@click="createEmptyVariant"');
    expect(pageSource).toContain('智能成片包装');
    expect(pageSource).toContain('<Workflow :size="13" />查看工作流');
    expect(pageSource).toContain('智能成片包装真实任务进度');
    expect(pageSource).not.toContain('<Plus :size="13" />AI 智能填充');
  });
  it('keeps the smart-fill workflow as a read-only, per-node progress view', () => {
    expect(pageSource).not.toContain('class="mix-workflow-progress"');
    expect(pageSource).not.toContain('action-label="关闭工作流"');
    expect(pageSource).not.toContain('返回工作区');
    expect(pageSource).toContain('workflowStageProgress(stage)');
    expect(pageSource).toContain('本阶段实际输入（最多展示 4 项）');
    expect(pageSource).toContain('本阶段实际结果（最多展示 4 项）');
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
    // Rows are generic 音频 tracks and each owns its mute, so the state is one flag per row rather
    // than one per kind of audio.
    expect(pageSource).toContain('const audioRowMuted = ref<boolean[]>([]);');
    expect(pageSource).toContain('const audioRowByClipId = computed<Record<string, number>>');
    expect(pageSource).toContain(':audio-row-muted="audioRowMuted"');
    expect(pageSource).toContain(':audio-row-by-clip-id="audioRowByClipId"');
    expect(pageSource).not.toContain('voiceTrackMuted');
    expect(pageSource).not.toContain('musicTrackMuted');
    expect(pageSource).not.toContain('detachedTrackMuted');
    expect(pageSource).toContain('@toggle-audio-mute="setTimelineTrackMute"');
    expect(pageSource).toContain('startPlaybackAudio');
    // Smart fill only ever picks current clips, so the button has to be gated on how many of those
    // exist — counting every material let a hundred stale clips keep it clickable, and the request
    // then came back as "剩余未使用素材不足以再生成一条完整成片".
    expect(pageSource).not.toContain('workspace.materials.length < 6');
    expect(pageSource).toContain('Boolean(aiFillBlockReason)');
    expect(pageSource).toContain('const availableMaterials = computed(');
    expect(pageSource).toContain('const expiredMaterialCount = computed(');
    expect(pageSource).toContain('const aiFillBlockReason = computed<string | null>(');
    expect(pageSource).toContain('if (!refreshAffectedSlots && aiFillBlockReason.value) {');
    expect(pageSource).toContain('class="material-expired-banner"');
    expect(pageSource).not.toContain('class="material-expired-badge"');
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
    expect(pageSource).not.toContain('class="mix-workflow-progress"');
    expect(pageSource).not.toContain('action-label="关闭工作流"');
    expect(pageSource).not.toContain('class="workflow-version-notice"');
    expect(pageSource).toContain('class="workflow-graph-canvas"');
    expect(pageSource).toContain('class="workflow-graph-node"');
    expect(pageSource).toContain('class="workflow-node-detail"');
    expect(pageSource).toContain('4 条执行边');
    expect(pageSource).toContain('workflowStageProgress(stage)');
    expect(pageSource).toContain('本阶段实际输入（最多展示 4 项）');
    expect(pageSource).toContain('本阶段实际结果（最多展示 4 项）');
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
    expect(timelineSource).toContain('const orderedTracks = computed<VisibleTrack[]>(() => [');
    expect(timelineSource).toContain('const visiblePrimaryTracks = computed');
    expect(timelineSource).toContain('const hasCaptionTrack = computed');
    expect(timelineSource).toContain('const hasCaptionTrack = computed(() => true);');
    // Audio rows are numbered, not classified: one row per occupied lane, and the row a downward
    // drag reaches for exists only while that drag is live.
    expect(timelineSource).toContain('const audioTracks = computed<AudioTrack[]>(() =>');
    expect(timelineSource).toContain(
      'Array.from({ length: audioRowCount.value }, (_, row) => audioRowKey(row)),',
    );
    expect(timelineSource).toContain('const audioRowCount = computed(() => audioRowCountOf(');
    // Every audio row is labelled 音频, so the kinds differ by clip colour alone.
    expect(timelineSource).toContain("const AUDIO_TRACK_LABEL = '音频';");
    expect(timelineSource).toContain('const trackLabel = (track: VisibleTrack): string =>');
    // A row is named after what it carries, never after its number. Each subtitle added from the
    // library mints its own track, so numbering the caption rows would leak that bookkeeping into the
    // UI; every caption row reads as 字幕 and every video row as 视频.
    expect(timelineSource).toContain("const CAPTION_TRACK_LABEL = '字幕';");
    expect(timelineSource).toContain("const VIDEO_TRACK_LABEL = '视频';");
    expect(timelineSource).toContain('if (isCaptionTrack(track)) return CAPTION_TRACK_LABEL;');
    expect(timelineSource).not.toContain('captionLaneOfTrack(track) + 1');
    expect(timelineSource).not.toContain("'主视频'");
    expect(timelineSource).not.toContain("VOICE: '音频',");
    expect(timelineSource).toContain('const assignIntervalLanes');
    // The old fixed three-lane grid is gone, and no empty row is reserved either.
    expect(timelineSource).not.toContain('Math.max(2,');
    expect(timelineSource).not.toContain('Math.min(3,');
    expect(timelineSource).not.toContain('未配置字幕');
    expect(timelineSource).not.toContain('未配置音频');
    expect(timelineSource).toContain("type VisibleTrack = 'CAPTION' | CaptionTrack | 'VIDEO' | AudioTrack;");
    // Mute is one flag per row, not one per kind of audio.
    expect(timelineSource).toContain('audioRowMuted?: boolean[]');
    expect(timelineSource).not.toContain('voiceMuted?: boolean');
    expect(timelineSource).not.toContain('musicMuted?: boolean');
    expect(timelineSource).not.toContain('detachedMuted?: boolean');
    expect(timelineSource).toContain(
      "const trackMuted = (track: AudioTrack | 'VIDEO'): boolean =>",
    );
    expect(timelineSource).toContain(
      "toggleAudioMute: [track: AudioTrack | 'VIDEO', muted: boolean]",
    );
    expect(timelineSource).toContain("emit('toggleAudioMute', track,");
    expect(timelineSource).not.toContain('@dragstart="onTrackDragStart($event, track)"');
    expect(timelineSource).toContain('@scroll="syncTrackScroll(\'HEADERS\')"');
    expect(timelineSource).toContain('@scroll="syncTrackScroll(\'VIEWPORT\')"');
    expect(timelineSource).toContain('const syncTrackScroll');
    expect(timelineSource).toContain('const draggedTimelineEnd = computed');
    expect(timelineSource).toContain('draggedTimelineEnd.value');
    // The film reaches as far as its content: a clip carried past the last video clip has to grow
    // the canvas under the pointer, otherwise the drag would be fenced by the current film length.
    expect(timelineSource).toContain('const draggedAudioEnd = computed');
    expect(timelineSource).toContain('draggedAudioEnd.value');
    expect(timelineSource).toContain(
      'effectTemplateMixContentDuration(props.variant, props.packaging?.checkpoint)',
    );
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
      '? 7 + (drag?.initialLanes[slot.id] ?? clipLane(slot.id)) * 70 + (delta?.topPx ?? 0)',
    );
    expect(timelineSource).toContain('Math.hypot(');
    expect(pageSource).toContain('beginMaterialPointerDrag');
    expect(pageSource).toContain("className = 'material-drag-ghost'");
    expect(pageSource).toContain(':draggable="Boolean(selectedVariant) && !projectEditLocked"');
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
  it('keeps the no-template view compact without creating a template', () => {
    expect(pageSource).toContain("pageState === 'LOADING'");
    expect(pageSource).toContain("pageState === 'ERROR'");
    expect(pageSource).toContain('class="config-layout"');
    expect(pageSource).toContain("'is-empty': !workspace");
    expect(pageSource).toContain('class="panel config-panel config-panel--empty"');
    expect(pageSource).toContain('在左侧新建模板后，这里会显示槽位、时长和转场配置。');
    expect(pageSource).toContain('.config-panel--empty');
    expect(pageSource).toContain('min-height: 240px;');
    expect(pageSource).toContain('align-items: stretch;');
    expect(pageSource).not.toContain('if (catalog.value.length === 0)');
    expect(pageSource).not.toContain('还没有混剪模板');
    expect(pageSource).not.toContain('新建第一个模板');
    expect(pageSource).not.toContain('<div class="config-head__actions">');
    expect(pageSource).toContain('<button class="button new-template" :disabled="checkingTemplateCreation" @click="openCreate">');
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
    expect(timelineSource).toContain(
      'playheadElement.value.style.transform = `translate3d(${left}px, 0, 0)`;',
    );
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
    // A subtitle travels as freely as a video clip. There is no fence at all, because a landing that
    // would overlap a card on its own track is answered by giving it a track of its own — the
    // subtitle counterpart of a video clip finding another lane.
    expect(timelineSource).not.toContain('const captionBounds');
    // The track key is the one the row packer and the checkpoint both group by. It used to be spelled
    // out here a third time; it now comes from the packer's own definition so the two cannot drift.
    expect(timelineSource).toContain('effectTemplateMixCaptionTrackKey,');
    expect(timelineSource).not.toContain('const captionTrackKeyOf');
    expect(timelineSource).toContain('const captionOverlapsTrack = (');
    expect(timelineSource).toContain('effectTemplateMixCaptionTrackKey(entry.caption) === key');
    expect(timelineSource).toContain('const captionOverlapsOwnTrack = (');
    expect(timelineSource).toMatch(
      /sourceDuration: Number\.POSITIVE_INFINITY,\s*minStart: 0,\s*maxEnd: Number\.POSITIVE_INFINITY,/u,
    );
    expect(timelineSource).toContain('captionLaneById.value.get(caption.id) ?? 0');
    // A subtitle travels its own, shorter rows: the ghost is measured against the caption area and
    // rebased onto the lane it started on, exactly as an audio clip's is against row 0.
    expect(timelineSource).toContain(
      'const captionAreaTop = (): number =>\n  captionTrackElements.get(captionTrackKey(0))?.getBoundingClientRect().top ?? 0;',
    );
    expect(timelineSource).toContain('const dragRowOf = (clipId: string): number =>');
    expect(timelineSource).toContain(
      'ghostTop: AUDIO_CLIP_INSET + row * (caption ? CAPTION_LANE_HEIGHT : AUDIO_LANE_HEIGHT),',
    );
    expect(timelineSource).toContain('drag.ghostTop - initialLane * CAPTION_LANE_HEIGHT');
    // A subtitle's row is derived from its track rather than stored, so it takes part in the row
    // gesture like anything else — but the row it lands on is never reported as an audio row it does
    // not have: naming a track is what gives it one.
    expect(timelineSource).toContain('const rowMove = audio.initialRows[audio.id] !== undefined;');
    // The drop position is resolved to a row rather than only to "the card was moved", so a card can
    // be put back on a row that already exists instead of every vertical move minting a new one.
    expect(timelineSource).toContain(
      'const targetKey = effectTemplateMixCaptionRowKeys(timelineCaptions.value, props.fps)[',
    );
    expect(timelineSource).toContain(
      "emit('moveCaptionToRow', captionId, audio.currentStart, targetKey);",
    );
    expect(timelineSource).toContain(
      'moveCaptionToRow: [captionId: string, start: number, rowKey: string];',
    );
    expect(timelineSource).not.toContain('const rowChanged = rowMove &&');
    // Its rows are separate strips, so a card carried off its own has to ride above the row below it.
    expect(timelineSource).toContain(
      '.caption-clip.is-dragging,\n.audio-clip.is-dragging {\n  z-index: 8;\n}',
    );
    // A group slides rigidly and reports once, so the workbench records one undo step for the gesture
    // rather than one per caption.
    expect(timelineSource).toContain('const shared = Math.max(delta, -earliest);');
    // A member of the set that would land on a card outside it is given a track of its own instead
    // of riding along, and the set is measured as a whole so a sibling that is moving too is not
    // what a member is checked against.
    expect(timelineSource).toContain('const moving = new Set(group);');
    expect(timelineSource).toContain(
      'if (captionOverlapsOwnTrack(id, start, length, moving)) split.push(id);',
    );
    expect(timelineSource).toContain("if (riders.length) emit('moveAudioClips', riders);");
    expect(timelineSource).toContain('drag.maxEnd - drag.initialDuration');
    expect(timelineSource).toContain("emit('moveAudioClip'");
    expect(timelineSource).toContain("'resizeAudioClip',");
    expect(timelineSource).toContain("emit('changeAudioVolume'");
    expect(waveformSource).toContain(
      "{ tone: 'VIDEO', layout: 'strip', fadeIn: 0, fadeOut: 0, gain: 1 }",
    );
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
    // The timeline resolves the effective fades and hands them to the strip. A packaged clip is
    // either a narration line or the bed, so the default is resolved against one of those two.
    expect(timelineSource).toContain(
      "const fadeKind: 'MUSIC' | 'VOICE' = ref.kind === 'MUSIC' ? 'MUSIC' : 'VOICE';",
    );
    expect(timelineSource).toContain("packagingAudioFade(audio, fadeKind, 'fadeIn')");
    expect(timelineSource).toContain("packagingAudioFade(audio, fadeKind, 'fadeOut')");
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
    // A completed snapshot remains editable even when its upstream marker is stale; unfinished
    // checkpoints still expose selection but not drag/trim handles.
    expect(timelineSource).toContain(
      "() => !props.readOnly && props.packaging?.status === 'COMPLETED',",
    );
    expect(timelineSource).toContain('editable: audioEditable.value');
    expect(timelineSource).toContain('v-if="audioEditable && selectedAudioIds.includes(entry.id)"');
    expect(timelineSource).toContain('if (!audioEditable.value) return;');
    // Undo covers both places an edit can land: rows and video geometry on the variant, but subtitles,
    // narration, music and subtitle boxes on the server-owned checkpoint. A snapshot that only carried
    // the variant restored nothing after a subtitle gesture, so undo looked like a no-op.
    expect(pageSource).toContain('packaging: TimelinePackagingSnapshot | null;');
    expect(pageSource).toContain(
      'checkpoint: cloneCheckpoint(item.checkpoint), itemId: item.id, updatedAt: item.updatedAt',
    );
    expect(pageSource).toContain('item.id === packaging.itemId &&');
    expect(pageSource).toContain('item.checkpoint = cloneCheckpoint(packaging.checkpoint);');
    // The revert is diffed against what the server holds, so it has to be pushed back the same way a
    // normal edit is; a restored checkpoint with no baseline would be dropped by flushAudioEdit.
    expect(pageSource).toContain('scheduleAudioEdit();');
    // Every discrete subtitle gesture records a step; per-keystroke text typing deliberately does not.
    expect(pageSource).toContain(
      '// Captured before the caption lands in either source, so undo removes the one just added.',
    );
    expect(pageSource).toContain(
      '// Captured before the captions are removed, so undo brings the selection back.',
    );
    expect(pageSource).toContain(
      '// Captured before the trim is written, so undo steps back to the untrimmed caption.',
    );
    expect(pageSource).toContain(
      '// Captured before the new size is written, so undo steps back to the previous size.',
    );
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
  it('offers a track border as a new-row target for a library clip', () => {
    // The border is hit-tested from the pointer, and it always beats the slot underneath it.
    expect(timelineSource).toContain('const TRACK_INSERT_THRESHOLD = 6;');
    // An audio row is one lane tall and has no gap between clips to aim at, so its band is a slice of
    // the row rather than the few pixels a video row's gap gives.
    expect(timelineSource).toContain('const AUDIO_INSERT_THRESHOLD = Math.round(AUDIO_LANE_HEIGHT / 4);');
    expect(timelineSource).toContain('let bestDistance = kinds.has(\'AUDIO\') ? AUDIO_INSERT_THRESHOLD : TRACK_INSERT_THRESHOLD;');
    expect(timelineSource).toContain(
      'const trackInsertTarget = ref<TrackInsertTarget | null>(null);',
    );
    expect(timelineSource).toContain('const trackInsertTargetFrom = (');
    expect(timelineSource).toContain("kinds: ReadonlySet<TrackInsertTarget['kind']>,");
    expect(timelineSource).toContain('const first = bounds.top + VIDEO_CLIP_INSET - 4;');
    expect(timelineSource).toContain('for (let lane = 0; lane <= videoLaneCount.value; lane += 1)');
    // A caption row owns no video rows, so both of its edges create the first one.
    expect(timelineSource).toContain(
      "{ kind: 'VIDEO', lane: 0, top: bounds.top },\n        { kind: 'VIDEO', lane: 0, top: bounds.bottom },",
    );
    // A subtitle is the one thing that reads a caption border, and it reads it as a row of its own.
    expect(timelineSource).toContain(
      "const CAPTION_INSERT_KINDS: ReadonlySet<TrackInsertTarget['kind']> = new Set(['CAPTION']);",
    );
    expect(timelineSource).toContain(
      "{ kind: 'CAPTION', lane, top: bounds.top },\n        { kind: 'CAPTION', lane: lane + 1, top: bounds.bottom },",
    );
    expect(timelineSource).toContain(
      "materialDropSlotId.value = target ? '' : slotIdFromDragEvent(event);",
    );
    expect(timelineSource).toContain('@dragover="onCaptionTrackDragOver"');
    expect(timelineSource).toContain(
      'const onCaptionTrackDragOver = (event: DragEvent): void => {',
    );
    // Releasing on a border emits the row to create, not a slot to overwrite.
    expect(timelineSource).toContain(
      'insertMaterialTrack: [materialId: string, lane: number, start: number];',
    );
    expect(timelineSource).toContain(
      "emit('insertMaterialTrack', materialId, target.lane, dropTimeFromClientX(event.clientX, false));",
    );
    expect(timelineSource).toContain('const dropTimeFromClientX = (clientX: number, snap = true): number => {');
    // The magnet pulls a clip up against a neighbour's edge, which is not what a free placement wants.
    expect(timelineSource).toContain('return snap ? snapTime(raw) : quantizeToFrame(raw);');
    // The guide is the vertical snap line laid on its side, and it lives on the canvas too.
    expect(timelineSource).toContain('v-if="trackInsertGuideTop !== null"');
    expect(timelineSource).toContain(':style="{ top: `${trackInsertGuideTop}px` }"');
    expect(timelineSource).toContain('class="track-insert-guide"');
    expect(timelineSource).toContain(
      'height: 1px;\n  position: absolute;\n  z-index: 17;\n  left: 0;\n  right: 0;',
    );
    // The editor scrolls the new row and clip into view through the exposed handle.
    expect(timelineSource).toContain(
      'const scrollToLane = (lane: number, time: number, duration = 0): void => {',
    );
    expect(timelineSource).toContain('element.scrollTop = Math.max(');
    expect(timelineSource).toContain("syncTrackScroll('VIEWPORT');\n};");
    // The whole clip has to be revealed, not just its head: one dropped near the right edge would
    // otherwise come into view with its tail cut off, and one longer than the viewport keeps its head.
    expect(timelineSource).toContain('const revealTimelineColumn = (time: number, duration: number): void => {');
    expect(timelineSource).toContain('const right = left + Math.max(0, duration) * pixelsPerSecond.value;');
    expect(timelineSource).toContain('if (right - left > element.clientWidth - margin * 2)');
    // The clip is an ordinary variant slot appended after the template's own.
    expect(pageSource).toContain(
      'const insertMaterialTrack = (materialId: string, lane: number, start: number): void => {',
    );
    expect(pageSource).toContain('@insert-material-track="insertMaterialTrack"');
    expect(pageSource).toContain('scrollToLane: (lane: number, time: number, duration?: number) => void;');
    expect(pageSource).toContain('const EFFECT_TEMPLATE_MIX_PURPOSE_ROLES');
    expect(pageSource).toContain('variant.slots.push(slot);');
    expect(pageSource).toContain('variant.manualSlotIds.push(slot.id);');
    // The clip is picture only, so it covers what it lands on instead of being spoken over it.
    expect(pageSource).toContain('overlay: true,');
    // Nothing under it moves: it starts exactly where it was dropped, and only the new clip is given a
    // start, so the clips already placed keep the layout the packaging was confirmed against.
    expect(pageSource).toContain('const insertAt = Math.max(0, start);');
    expect(pageSource).not.toContain('timelineStarts[range.id] = range.start');
    // The old ripple insert is gone: no clip is pushed along to make room for the new one.
    expect(pageSource).not.toContain('boundaries.reduce');
    // A new row pushes the rows at and below it down, then the rows are compacted again.
    expect(pageSource).toContain(
      'if (current >= insertLane) variant.videoLanes[candidate.id] = current + 1;',
    );
    expect(pageSource).toContain(
      'normalizeVariantVideoLanes(variant);\n  clearDetachedTransitions(variant);',
    );
    expect(pageSource).toContain('timelineRef.value?.scrollToLane(compactedLane, insertAt, duration)');
    // Packaging refuses a clip it cannot narrate, so the editor refuses it first.
    expect(pageSource).toContain("'素材缺少已确认原始 Prompt，无法成片'");
    expect(pageSource).toContain("'素材不足 4 秒，无法新增轨道'");
    expect(timelineSource).not.toContain('clientYInVideoTrack');
    expect(timelineSource).not.toContain('nextFreeVideoLane');
    // The row a border opens depends on what is being dragged, and that is the whole of the rule that
    // keeps music under the picture: a video drag can never see an audio border, or the other way.
    expect(timelineSource).toContain("const VIDEO_INSERT_KINDS: ReadonlySet<TrackInsertTarget['kind']> = new Set(['VIDEO']);");
    expect(timelineSource).toContain("const AUDIO_INSERT_KINDS: ReadonlySet<TrackInsertTarget['kind']> = new Set(['AUDIO']);");
    expect(timelineSource).toContain('if (videoElement && kinds.has(\'VIDEO\')) {');
    expect(timelineSource).toContain("if (kinds.has('AUDIO')) {");
    // The row below the last one has no top edge of its own, so the bottom edge opens it.
    expect(timelineSource).toContain(
      "{ kind: 'AUDIO', row, top: bounds.top },\n        { kind: 'AUDIO', row: row + 1, top: bounds.bottom },",
    );
    expect(timelineSource).toContain(
      'const onMusicTrackDragOver = (event: DragEvent, track: AudioTrack): void => {',
    );
    expect(timelineSource).toContain(
      'const target = trackInsertTargetFrom(event.clientY, AUDIO_INSERT_KINDS);',
    );
    expect(timelineSource).toContain('musicDropRow.value = target || clipId ? null : audioRowOfKey(track);');
    expect(timelineSource).toContain("...(target?.kind === 'AUDIO' ? { insertRow: target.row } : {}),");
  });
  it('lets an existing clip and a music track open a row on the border they were dropped on', () => {
    // Dragging a clip already on the timeline sees the same borders a library clip does, but only a
    // single one can use it: a group slides rigidly and has no one row to open for the whole of it.
    expect(timelineSource).toContain(
      'const border =\n    drag.selectedSlotIds.length === 1 ? trackInsertTargetFrom(clientY, VIDEO_INSERT_KINDS) : null;',
    );
    expect(timelineSource).toContain("drag.insertLane = border?.kind === 'VIDEO' ? border.lane : null;");
    // A border drop and a row drop are different answers, so the row index alone cannot carry it.
    expect(timelineSource).toContain(
      'moveClip: [slotId: string, start: number, lane: number, insertLane?: number];',
    );
    expect(timelineSource).toContain(
      "emit('moveClip', moves[0].slotId, moves[0].start, moves[0].lane, drag.insertLane ?? undefined);",
    );
    expect(pageSource).toContain(
      'const moveTimelineClip = (\n  slotId: string,\n  start: number,\n  lane: number,\n  insertLane?: number,\n): void => moveTimelineClips([{ slotId, start, lane, insertLane }]);',
    );
    // A border asks for a row of its own rather than a row to sit in, so it never looks for a free one.
    expect(pageSource).toContain(
      'insertLane !== undefined || nextLane < currentLane,',
    );
    // A music track dropped on a border opens an audio row: the rows from there down move one
    // further, and the track takes the row that was made.
    expect(pageSource).toContain('insertRow?: number | undefined;');
    expect(pageSource).toContain('if (music.insertRow === undefined) {');
    expect(pageSource).toContain('const row = Math.max(0, Math.round(music.insertRow));');
    expect(pageSource).toContain('if (lane >= row) variant.audioLanes[ref.id] = lane + 1;');
    // An existing audio clip reads the same audio borders a library track does, and a subtitle reads
    // the caption ones — the only borders that can give a caption a row of its own.
    expect(timelineSource).toContain(
      'drag.id.startsWith(\'caption:\') ? CAPTION_INSERT_KINDS : AUDIO_INSERT_KINDS,',
    );
    expect(timelineSource).toContain("drag.insertRow = insertTarget?.kind === 'AUDIO' ? insertTarget.row : null;");
    expect(timelineSource).toContain("drag.insertCaptionTrack = insertTarget?.kind === 'CAPTION';");
    expect(timelineSource).toContain('insertRow: number | null;\n  /** The caption row border the pointer is on: the subtitle is given a row of its own there. */\n  insertCaptionTrack: boolean;');
    // Let go on a border, the row it opens is the answer; the row under the pointer is not consulted.
    expect(timelineSource).toContain(
      'moveAudioClip: [clipId: string, start: number, row?: number, insertRow?: number];',
    );
    expect(timelineSource).toContain(
      "emit('moveAudioClip', audio.id, audio.currentStart, audio.insertRow, audio.insertRow);",
    );
    expect(pageSource).toContain('insertRow === undefined\n        ? resolveAudioPlacement(');
    expect(pageSource).toContain(
      'movePackagingAudios([\n    row === undefined\n      ? { clipId, start }\n      : { clipId, row, start, ...(insertRow === undefined ? {} : { insertRow }) },\n  ]);',
    );
    // The view only forces the vertical position: the clip was just let go under the pointer, so
    // scrolling sideways would carry it away from where the user dropped it.
    expect(timelineSource).not.toContain('clientWidth / 3');
    expect(timelineSource).toContain(
      'else if (left < element.scrollLeft + margin) element.scrollLeft = Math.max(0, left - margin);',
    );
  });
  it('gives a subtitle its own row and lets a music track replace a clip it was dropped on', () => {
    // A caption row is derived from the caption's track, so a new row is a new track and nothing else.
    expect(timelineSource).toContain('splitCaptionTrack: [captionId: string, start: number];');
    expect(timelineSource).toContain("emit('splitCaptionTrack', captionId, audio.currentStart);");
    expect(pageSource).toContain('@split-caption-track="splitCaptionTrack"');
    expect(pageSource).toContain(
      'const splitCaptionTrack = (captionId: string, start: number): void => {',
    );
    expect(pageSource).toContain('const trackId = `subtitle-track-${Date.now()');
    // The subtitle keeps its own length; only the row and the time were asked for.
    expect(pageSource).toContain(
      'const length = Math.max(1 / TIMELINE_FPS, caption.end - caption.start);',
    );
    // A checkpoint caption goes through the packaging editor, which is what captures the baseline the
    // save is diffed against — writing it straight onto the checkpoint would never be persisted.
    expect(pageSource).toContain(
      'editPackagingAudio((checkpoint) => {\n      const target = checkpoint.captions?.find((item) => item.id === captionId);',
    );
    // Caption rows are separate strips, so the row is measured from the first strip plus its lane.
    expect(timelineSource).toContain(
      'const scrollToCaption = (captionId: string, time: number, duration = 0): void => {',
    );
    expect(timelineSource).toContain(
      'element.scrollTop = Math.max(\n      0,\n      rowTop - element.clientHeight / 2 + CAPTION_LANE_HEIGHT / 2,\n    );',
    );
    expect(timelineSource).toContain('scrollToCaption,\n  scrollToLane,');
    expect(pageSource).toContain(
      'scrollToCaption: (captionId: string, time: number, duration?: number) => void;',
    );
    expect(pageSource).toContain('timelineRef.value?.scrollToCaption(captionId, next, length)');
    // A library track let go on top of a clip takes its place instead of opening a row beside it.
    expect(timelineSource).toContain(
      'replaceAudioWithMusic: [clipId: string, music: MusicAssetDrop];',
    );
    expect(timelineSource).toContain(
      "if (replaceClipId) {\n    emit('replaceAudioWithMusic', replaceClipId, data);",
    );
    expect(timelineSource).toContain("const musicDropClipId = ref('');");
    // The clip under the pointer is read from the drag itself, the same way the video track reads it,
    // and the row's own padding falls back to the pointer's time.
    expect(timelineSource).toContain(
      "event.target instanceof Element ? event.target.closest<HTMLElement>('.audio-clip') : null;",
    );
    expect(timelineSource).toContain('if (target?.dataset.audioId) return target.dataset.audioId;');
    expect(timelineSource).toContain('const time = dropTimeFromClientX(event.clientX, false);');
    // Only a clip the draft owns the source of can be swapped — every other audio clip is a packaging
    // checkpoint the server will not take a new file for, so dimming it would promise a drop that the
    // workbench then turns down. Those fall back to the row and the track lands beside them.
    expect(timelineSource).toContain(
      'const replaceableAudioClipId = (clipId: string): string =>\n  clipId.startsWith(\'detached:\') ? clipId : \'\';',
    );
    expect(timelineSource).toContain(
      "const clipId = target ? '' : replaceableAudioClipId(audioClipIdAtPoint(event, track));",
    );
    expect(timelineSource).toContain('musicDropClipId.value = clipId;');
    expect(pageSource).toContain('@replace-audio-with-music="replaceAudioWithMusic"');
    expect(pageSource).toContain('const replaceAudioWithMusic = (');
    // The replacement fits the hole rather than the other way round, so a short track is refused.
    expect(pageSource).toContain("showNotice(`${music.name} 短于被覆盖的片段，无法替换`, 'warning');");
    expect(pageSource).toContain('audio.offset = 0;');
    // The clip that would be replaced is the one that says so: dimmed, and outlined.
    expect(timelineSource).toContain("'is-material-target': musicDropClipId === audio.id,");
    expect(timelineSource).toContain('.audio-clip.is-material-target::before');
    expect(timelineSource).toContain('background: rgba(15, 23, 42, 0.5);');
  });
  it('shows a music track dropped on an audio row border, and the row it opened', () => {
    // Where the audio sits is the editor's arrangement and survives a packaging, exactly as a clip
    // moved between rows does — only a frozen template or a run in flight refuses the drop. Gating on
    // the template lock made the audio rows read-only in the very state the rest of them are editable.
    expect(pageSource).toContain(
      'const addMusicAssetToTimeline = (music: {',
    );
    expect(pageSource).toContain('if (!variant || projectEditLocked.value) return;');
    expect(pageSource).toContain(
      'if (!Number.isFinite(music.duration) || music.duration <= 0) return;',
    );
    expect(pageSource).not.toContain('if (!variant || templateEditLocked.value) return;');
    // A row opened below the last one is off the bottom of the viewport, so the drop would read as
    // "nothing happened" until the user scrolled. The row is measured from its own element rather
    // than from a pitch, because the rows above it are only one lane tall.
    expect(timelineSource).toContain(
      'const scrollToAudioRow = (row: number, time: number, duration = 0): void => {',
    );
    expect(timelineSource).toContain(
      'audioTrackElements.get(audioRowKey(Math.max(0, Math.round(row))))?.getBoundingClientRect()',
    );
    expect(timelineSource).toContain('revealTimelineColumn(time, duration);');
    expect(timelineSource).toContain('scrollToAudioRow,\n  scrollToCaption,\n  scrollToLane,');
    expect(pageSource).toContain(
      'scrollToAudioRow: (row: number, time: number, duration?: number) => void;',
    );
    expect(pageSource).toContain('timelineRef.value?.scrollToAudioRow(landedRow, start, duration)');
  });
  it('drags a subtitle exactly like a video clip, and deletes the audio clip that is selected', () => {
    // `?raw` hands back the worktree file, and `core.autocrlf` makes that CRLF while the committed
    // file is LF, so the multi-line assertions below read a normalised copy: git rewrites the file
    // on `git add` anyway, and this keeps the check honest on a Windows checkout too.
    const timelineText = timelineSource.split('\r\n').join('\n');
    const pageText = pageSource.split('\r\n').join('\n');
    // One snap rule for every block: the caption-only exception that suppressed the vertical guide is
    // gone, so a subtitle catches the same edges with the same line saying what it caught.
    expect(timelineText).not.toContain('snapGuideTime.value = null;\n      }');
    expect(timelineText).toContain(
      'const snapped = snapDraggedBlock(requested, drag.initialDuration, ignoredIds, {\n        maxStart,\n        minStart: drag.minStart,\n      });',
    );
    // Dragging a caption's left or right edge catches the same edges a move does and draws the same
    // guide: the trim branches used to move the edge with no magnet and no line at all.
    expect(timelineText).toContain(
      'const snapEdgeTime = (\n  time: number,\n  ignored: Set<string>,\n  window: { max: number; min: number },\n): { guide: number | null; time: number } => {',
    );
    expect(timelineText).toContain(
      'const snapped = snapEdgeTime(requested, ignoredIds, { max: headCeiling, min: headFloor });',
    );
    expect(timelineText).toContain(
      'const snapped = snapEdgeTime(requested, ignoredIds, { max: tailCeiling, min: tailFloor });',
    );
    // A subtitle has no source, so its head is free to travel back to the start of the timeline
    // instead of being pinned to where it already was — dragging its left edge left used to do
    // nothing at all, which is half of why no guide could ever appear there.
    expect(timelineText).toContain(
      'const headFloor =\n        drag.initialSourceDuration === Number.POSITIVE_INFINITY\n          ? drag.minStart\n          : Math.max(drag.minStart, drag.initialStart - drag.initialOffset);',
    );
    // One ignored set for the whole gesture, so a block never snaps to itself or to its own group.
    expect(timelineText).toContain(
      'const ignoredIds = new Set([drag.id, ...dragGroupIds(drag.id)]);',
    );
    // The landings that mint a track, and the plain time move that does not. A drop on a row that can
    // take the card joins that row instead, which is the half that lets a card come back down.
    expect(timelineText).toContain(
      'audio.insertCaptionTrack ||\n            targetKey === undefined ||\n            (targetKey !== ownKey && overlaps(targetKey))',
    );
    expect(timelineText).toContain(
      "else if (targetKey !== ownKey)\n            emit('moveCaptionToRow', captionId, audio.currentStart, targetKey);",
    );
    expect(timelineText).toContain(
      "else if (overlaps(ownKey)) emit('splitCaptionTrack', captionId, audio.currentStart);\n          else emit('moveAudioClip', audio.id, audio.currentStart);",
    );
    // A track of its own is editor geometry, so the editor writes it for either kind of card — the
    // server used to drop it silently, which is why a subtitle could never leave its row.
    expect(pageText).toContain('const trackId = `subtitle-track-${Date.now()');
    // Coming back down is a clear rather than a new track, and the row arrives as the packer's own key.
    expect(pageText).toContain(
      'const writeCaptionRow = (captionId: string, start: number, trackId: string | null): void => {',
    );
    expect(pageText).toContain('if (trackId === null) delete target.trackId;');
    expect(pageText).toContain(
      'const moveCaptionToRow = (captionId: string, start: number, rowKey: string): void => {',
    );
    expect(pageText).toContain(
      "if (rowKey === 'legacy-generated') return writeCaptionRow(captionId, start, null);",
    );
    expect(pageText).toContain(
      "return writeCaptionRow(captionId, start, rowKey.slice('track:'.length));",
    );
    expect(pageText).toContain('@move-caption-to-row="moveCaptionToRow"');
    // Dropping the field is not the same as clearing it: the server reads an absent `trackId` as
    // "leave the row alone", so a cleared row has to say `null` out loud.
    expect(pageText).toContain(
      '...(trackId ? { trackId } : previous?.trackId ? { trackId: null } : {}),',
    );
    // Audio selection is authoritative: falling through to the video slot is what made Delete on a
    // narration remove an unrelated slot, or nothing at all.
    expect(pageText).toContain('const deleteSelectedAudioClips = (clipIds: string[]): void => {');
    expect(pageText).toContain(
      'if (selectedAudioClipIds.value.length) {\n    deleteSelectedAudioClips([...selectedAudioClipIds.value]);\n    return;\n  }',
    );
    expect(pageText).toContain('if (removesMusic) delete next.music;');
    expect(pageText).toContain(
      'if (removesVoice) for (const id of voiceIds) delete next.voices?.[id];',
    );
    expect(pageText).toContain('delete next.captionVoices?.[id];');
    // A narration is an optional overlay on its line, so it deletes like any other clip: the line and
    // its subtitle stay. Only an id the checkpoint does not know is refused, out loud.
    expect(pageText).not.toContain('口播由脚本行生成，不能删除');
    expect(pageText).toContain("showNotice('该音频片段不能删除', 'warning');");
    // An unfinished packaging remains visibly read-only; stale sources do not swallow user edits.
    expect(pageText).toContain("showNotice('当前包装尚未完成，字幕不可编辑', 'warning');");
    // The three places that select an audio clip directly bypass the timeline's own selection, so a
    // stale caption set would otherwise still be what Delete acts on.
    expect(pageText).toContain(
      'selectedCaptionIds.value = [];\n    selectedAudioClipIds.value = [`detached:${audio.id}`];',
    );
    expect(pageText).toContain(
      'selectedCaptionIds.value = [];\n  selectedAudioClipIds.value = [`detached:${audio.id}`];',
    );
    expect(pageText).toContain(
      'selectedCaptionIds.value = [];\n  selectedAudioClipIds.value = [`detached:${pasted.id}`];',
    );
    // A removed bed is sent as its own flag, and a removed caption narration as the keys that went.
    expect(pageText).toContain('const removeMusic = Boolean(baseline.music) && !current.music;');
    expect(pageText).toContain('...(diff.removeMusic ? { removeMusic: true } : {}),');
    expect(pageText).toContain('...(diff.removedCaptionVoices.length');
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
    expect(pageSource).toContain('y: 0.03, width: 0.9');
    expect(pageSource).toContain('const captionBoxStyle = (id: string)');
    // Clicking a card opens a single-line text editor in the row above the timeline.
    expect(pageSource).toContain('const editingCaption');
    expect(pageSource).toContain('class="caption-text-editor"');
    expect(pageSource).toContain('const changeCaptionText');
    expect(pageSource).toContain('@select-audio-clip="onAudioClipSelected"');
    expect(pageSource).toContain('checkpoint.captions?.find((item) => item.id === captionId)');
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
    expect(timelineSource).toContain('const captionTrackElements = new Map<CaptionTrack, HTMLElement>();');
    expect(timelineSource).toContain('setCaptionTrackElement(track === \'CAPTION\' ? captionTrackKey(0) : track, element)');
    expect(timelineSource).toContain('captionTrackElements.get(captionTrackKey(0))');
    // Every row marquees, and an audio row measures only its own lane.
    expect(timelineSource).toContain("box.track === 'CAPTION'");
    expect(timelineSource).toContain('audioTrackElements.get(box.track)');
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
  it('marquees each audio row on its own and adjusts an audio group as one', () => {
    // One element per row, so a marquee on one 音频 row never reaches into another.
    expect(timelineSource).toContain(
      'const audioTrackElements = new Map<AudioTrack, HTMLElement>();',
    );
    expect(timelineSource).toContain(':ref="(element) => setAudioTrackElement(track, element)"');
    expect(timelineSource).toContain(
      'const setAudioTrackElement = (track: AudioTrack, element: unknown): void',
    );
    expect(timelineSource).toContain('audiosForTrack(box.track).map((audio) => ({');
    expect(timelineSource).toContain('const audioGroupIds = (): string[]');
    expect(timelineSource).toContain(
      "selectedAudioIds.value.filter((id) => !id.startsWith('caption:'))",
    );
    expect(timelineSource).toContain('const dragGroupIds = (id: string): string[]');
    // Ctrl/Cmd toggles one block, and a plain click keeps an existing set so it can be dragged.
    expect(timelineSource).toContain('const group = audioGroupIds();');
    expect(timelineSource).toContain(
      'if (!audioGroupIds().includes(audio.id)) selectAudio(audio.id);',
    );
    // A set slides rigidly: the shared delta is bounded by whichever block leaves the timeline first.
    // Only that left-hand bound survives — the film grows to whatever the set is dragged out to, so
    // capping the set at the film's current length would fence it where a single clip is free.
    expect(timelineSource).toContain(
      'const shared = Math.max(delta, -earliest);\n        const moves = clips.map((clip) => ({',
    );
    expect(timelineSource).not.toContain('timelineDuration.value - latest,');
    // One gesture, one event: the set is reported together so the workbench can resolve the rows
    // atomically instead of applying the members one at a time.
    expect(timelineSource).toContain("if (moves.length > 1) emit('moveAudioClips', moves);");
    expect(timelineSource).toContain(
      "else if (moves[0]) emit('moveAudioClip', moves[0].clipId, moves[0].start, moves[0].row);",
    );
    expect(pageSource).toContain('@move-audio-clips="movePackagingAudios"');
    // A clip changes rows exactly like a video clip: the ghost follows the pointer pixel for pixel
    // and the row it rounds to is deliberately unclamped, so dropping past the last row opens a
    // new one. A caption has no row, so it omits the row argument.
    expect(timelineSource).toContain('const audioAreaTop = (): number =>');
    // A subtitle travels its own, shorter rows, measured against the caption area rather than the audio
    // one: the two areas are stacked and only one of them is under the pointer.
    expect(timelineSource).toContain('const areaTop = caption ? captionAreaTop() : audioAreaTop();');
    expect(timelineSource).toContain('const rowHeight = caption ? CAPTION_LANE_HEIGHT : AUDIO_LANE_HEIGHT;');
    expect(timelineSource).toContain('const clipHeight = caption ? CAPTION_CLIP_HEIGHT : AUDIO_CLIP_HEIGHT;');
    expect(timelineSource).toContain(
      'const pointerTop = event.clientY - areaTop - (AUDIO_CLIP_INSET + clipHeight / 2);',
    );
    expect(timelineSource).toContain('drag.ghostTop = AUDIO_CLIP_INSET + pointerTop;');
    expect(timelineSource).toContain('drag.currentRow = Math.round(pointerTop / rowHeight);');
    expect(timelineSource).toContain(
      'const rowDelta = rowMove && !isCaption ? audio.currentRow - audio.initialRows[audio.id]! : 0;',
    );
    expect(timelineSource).toContain(
      'moveAudioClip: [clipId: string, start: number, row?: number, insertRow?: number];',
    );
    // The workbench compacts the stored rows before resolving a drop, so the row the timeline drew
    // and the lane it stores mean the same thing.
    expect(pageSource).toContain(
      'const normalizeVariantAudioLanes = (variant: EffectTemplateMixVariant): void => {',
    );
    expect(pageSource).toContain('const resolveAudioPlacement = (');
    expect(pageSource).toContain(
      'const movePackagingAudios = (moves: TimelineAudioMove[]): void => {',
    );
    // A caption is not an audio placement — it lives on its own row in the checkpoint — so reading only
    // the placements dropped every caption drag on the floor and the card sprang back on release.
    expect(pageSource).toContain(
      'const current = placement?.start ?? captionStartOf(clipId);',
    );
    expect(pageSource).toContain('const captionStartOf = (clipId: string): number | undefined => {');
    expect(pageSource).toContain("if (!clipId.startsWith('caption:')) return undefined;");
    // A subtitle carries its own length, so moving it keeps the end as far away as it was.
    expect(pageSource).toContain('const length = caption.end - caption.start;');
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
      "else for (const id of group) emit('changeAudioVolume', id, audio.currentVolume);",
    );
  });
  it('generates a narration for one caption from the font-size row and lands it on an audio row', () => {
    // The button sits beside the font stepper and belongs to the lone-caption branch: a narration
    // speaks one subtitle, so a multi-selection has nothing to offer it.
    expect(pageSource).toContain("{{ captionVoiceBusy ? '生成中…' : '生成口播' }}");
    expect(pageSource).toContain(':disabled="!captionVoiceReady"');
    expect(pageSource).toContain('@click="generateCaptionVoice"');
    expect(pageSource.indexOf("'生成口播'")).toBeLessThan(
      pageSource.indexOf('已选中 {{ selectedCaptionIds.length }} 条字幕'),
    );
    // The steppers are square glyphs, but this button carries a label, so it must size to its text
    // instead of inheriting the 22px square and clipping the words.
    expect(pageSource).toContain('.caption-font-size button.caption-voice-generate {');
    expect(pageSource).toContain('white-space: nowrap;');
    // The text box is capped rather than left to eat the row, so the controls beside it stay visible.
    expect(pageSource).toContain('max-width: 320px;');
    // The caption's text is debounced, so the save is flushed before the request: the server
    // asserts the text it is given against the caption it stored.
    expect(pageSource).toContain('const generateCaptionVoice = async (): Promise<void> => {');
    expect(pageSource).toContain('await flushAudioEdit();');
    expect(pageSource).toContain('await createEffectCaptionVoice(props.projectId, packaging.runId,');
    // The worker answers out of band, so the arrival is watched for on the polled checkpoint and
    // the clip is placed only then.
    expect(pageSource).toContain('const pendingCaptionVoice = ref<{ itemId: string;');
    expect(pageSource).toContain(
      '() => selectedPackaging.value?.checkpoint.captionVoices,',
    );
    expect(pageSource).toContain(
      'placeGeneratedCaptionVoice(`capvoice:${pending.captionId}`, audio.start);',
    );
    // A generated clip already sits at its caption's start, so `movePackagingAudios` would see no
    // change and drop the row insert — the placement resolves the row directly instead.
    expect(pageSource).toContain(
      'const placeGeneratedCaptionVoice = (clipId: string, start: number): void => {',
    );
    expect(pageSource).toMatch(/DEFAULT_AUDIO_LANE\.VOICE,\s*new Set\(\[clipId\]\),/u);
    expect(pageSource).toContain('if (laneOf(placement.clipId) >= resolved.insertRowAt) {');
    // The clip id carries its own namespace, so one resolver decides both which checkpoint
    // collection an edit writes and which one a placement reads.
    expect(pageSource).toContain("| { kind: 'CAPTION_VOICE'; key: string }");
    expect(pageSource).toContain(
      "if (clipId.startsWith('capvoice:')) return { kind: 'CAPTION_VOICE', key: clipId.slice(9) };",
    );
    expect(pageSource).toContain('checkpoint.captionVoices?.[target.key]');
    expect(pageSource).toContain('captionVoices: diff.captionVoices');
    // A deleted clip is a key that was there and is not any more: the geometry diff cannot see it,
    // because there is no current entry left to compare, so removals are diffed by key instead.
    expect(pageSource).toContain('const removedCaptionVoices = Object.keys(baseline.captionVoices ?? {}).filter(');
    expect(pageSource).toContain(
      'const removedVoices = Object.keys(baseline.voices ?? {}).filter(',
    );
    expect(pageSource).toContain('!removedVoices.length &&');
    expect(pageSource).toContain('    removedVoices,');
    // A deleted narration travels the same way, and it is the only removal the editor can express
    // that keeps the clip's line and subtitle in place.
    expect(pageSource).toContain('...(diff.removedVoices.length ? { removedVoices: diff.removedVoices } : {}),');
    // The timeline draws the clip and names it apart from a script line's 口播草稿.
    expect(timelineSource).toContain("ref.id.startsWith('capvoice:')");
    expect(timelineSource).toContain('checkpoint.captionVoices?.[captionId]');
    expect(timelineSource).toContain("'字幕口播'");
    expect(timelineSource).toContain(
      "checkpoint.captions?.find((caption) => caption.id === captionId)?.text",
    );
    expect(timelineSource).toContain("if (!source && audioId.startsWith('capvoice:')) {");
    // Membership stays decided in one place: the shared clip list is what makes the row exist.
    expect(audioLanesSource).toContain('id: `capvoice:${id}`');
    expect(audioLanesSource).toContain(
      'Object.keys(packaging.checkpoint.captionVoices ?? {}).length > 0',
    );
  });
  it('gives Space to the player instead of to a focused track button', () => {
    // Clicking a track's mute leaves it focused. Letting a focused button own Space meant the next
    // Space re-toggled the mute; inside the timeline Space is the player's, and Enter still
    // activates whatever button the user tabbed to.
    expect(pageSource).toContain("!target?.closest('.mix-timeline-shell') &&");
    expect(pageSource).toContain("(event.code === 'Space' || event.key === 'Enter');");
    expect(pageSource).toContain('if (!event.repeat) togglePreviewPlayback();');
    // The exclusion is scoped to the timeline, so a button anywhere else keeps the browser default.
    expect(pageSource).not.toContain("!target?.closest('.track-actions')");
  });
  it('lets a caption narration light the sound meter like any other packaging clip', () => {
    // The clip is a packaging voice like the script-line ones, so the meter has to count it or it
    // reads "当前无声音" while the narration is the only thing playing.
    expect(pageSource).toContain('Object.keys(checkpoint.captionVoices ?? {}).length ||');
    expect(pageSource).toContain('!mutedAudioClip(`capvoice:${captionId}`) && active(audio),');
    expect(pageSource).toContain('return voice || music || captionVoice || detached;');
  });
  it('releases the template configuration as soon as packaging has finished', () => {
    // The voice only feeds future packaging and voice redos, so it is released as soon as the run
    // finishes rather than staying pinned by the one-way packaging lock. A finished package is a
    // result of its own Run and a re-fill forks a branch, so the slot configuration the user has to
    // change before that re-fill must be released with it — nothing keeps a lock of its own.
    expect(pageSource).toContain('const voiceSelectLocked = computed(() => projectEditLocked.value);');
    expect(pageSource).toContain(':disabled="voiceSelectLocked"');
    expect(pageSource).toContain('if (voiceSelectLocked.value) return;');
    expect(pageSource).toContain('const templateEditLocked = projectEditLocked;');
    expect(pageSource).toContain(':disabled="templateEditLocked"');
    expect(pageSource).not.toContain('templateEditLocked = computed(() => projectEditLocked.value ||');
    // The restriction banners are gone; only the transient in-flight one is left.
    expect(pageSource).not.toContain('模板槽位配置已锁定');
    expect(pageSource).not.toContain('packagingLockNotice');
    expect(pageSource).toContain('智能填充正在运行，模板暂时锁定；任务结束后可修改。');
  });
  it('keeps editing available during packaging while preventing conflicting smart fills', () => {
    // Packaging consumes its frozen snapshot and writes separate artifacts. It must not freeze the
    // current project; only another smart fill conflicts with its workspace-binding writes.
    expect(pageSource).toContain('const packagingInFlight = computed(');
    expect(pageSource).toContain(
      "['QUEUED', 'RUNNING'].includes(packagingRunStatus.value ?? '')",
    );
    const projectLock = pageSource.match(
      /const projectEditLocked = computed\([\s\S]*?\n\);/u,
    )?.[0];
    expect(projectLock).toContain('activeEntry.value?.aiFillLocked');
    expect(projectLock).toContain('activeAiRun.value');
    expect(projectLock).toContain('fillStartPending.value');
    expect(projectLock).not.toContain('packagingInFlight.value');
    expect(pageSource).toMatch(
      /:disabled="\s+mutating \|\|\s+Boolean\(activeAiRun\) \|\|\s+packagingInFlight \|\|/u,
    );
    expect(pageSource).toContain('智能成片包装正在进行，请等待完成后再重新智能填充');
    expect(pageSource).not.toContain('此模板不能重新智能填充');
    expect(pageSource).not.toContain('常规智能填充已锁定');
  });
  it('edits volume, fade-in and fade-out for a voice/BGM selection from one standard', () => {
    // The timeline reports the whole voice/music set, captions excluded: they own the font stepper.
    expect(timelineSource).toContain('selectAudioClips: [clipIds: string[]];');
    expect(timelineSource).toMatch(/'selectAudioClips',\s*ids\.filter\(\(id\) => !id\.startsWith\('caption:'\)\)/u);
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
    expect(pageSource).toContain('marks: [');
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
      "const room = Math.max(0, audio.duration - packagingAudioFade(audio, kind, 'fadeOut'));",
    );
    expect(pageSource).toContain(
      "const room = Math.max(0, audio.duration - packagingAudioFade(audio, kind, 'fadeIn'));",
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
  it('keeps completed packaging attached and editable after picture edits without expiry labels', () => {
    expect(pageSource).toContain(':packaging="selectedPackaging"');
    expect(pageSource).toContain(
      "selectedPackaging.value?.status === 'COMPLETED' && !projectEditLocked.value",
    );
    expect(pageSource).not.toContain('时间轴已改变，当前包装已过期，请重新生成包装后再编辑');
    expect(pageSource).not.toContain('project-expired-badge');
    expect(pageSource).not.toContain('@stale-variants=');
    expect(packagingSource).not.toContain('staleVariants');
    expect(packagingSource).not.toContain('packagingSourceMatches');
    expect(timelineSource).toContain(
      "() => !props.readOnly && props.packaging?.status === 'COMPLETED',",
    );
    expect(timelineSource).not.toContain('clip-stale-badge');
    expect(timelineSource).not.toContain('is-stale');
    expect(timelineSource).not.toContain('.caption-clip.is-stale,\n.audio-clip.is-stale {');
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
    // Picking a caption is not a scrub either: the only two ways to move the playhead are the ruler
    // and the playhead itself, so selecting a card no longer drags the needle to the card's start.
    expect(timelineSource).not.toContain("emit('seek', Math.max(0, caption.start));");
    expect(timelineSource).toContain('const onCaptionPointerDown');
    expect(timelineSource).toContain("if (!selectedAudioIds.value.includes(id)) selectAudio(`caption:${caption.id}`);");
    // Everything the editor drives the timeline with, read out of the exposure block itself.
    const exposed = timelineSource.slice(timelineSource.indexOf('defineExpose({'));
    for (const method of [
      'clearSelection',
      'scrollToLane',
      'setPlaybackNeedle',
      'startPlaybackNeedle',
      'stopPlaybackNeedle',
    ])
      expect(exposed).toContain(`${method},`);
    expect(pageSource).toContain('timelineRef.value?.clearSelection()');
    expect(pageSource).toContain('const timelineRef = ref<{');
    expect(pageSource).toContain('clearSelection: () => void;');
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
    expect(pageSource).toContain('@keydown.enter="submitTemplateOnEnter"');
    expect(pageSource).toContain('nextAvailableTemplateName');
    expect(pageSource).toContain(
      ':disabled="!newTemplateName.trim() || createTemplateNameConflict"',
    );
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
  it('dims a hidden track, hatches a locked one and washes out a muted video track', () => {
    // Hiding a lane is a whole-lane state, so the lane itself dims — and the caption lane's own row
    // gradient has to be overridden for it to dim with the others. A mid slate, not black: the lane
    // is switched off, not deleted.
    expect(timelineSource).toContain('.timeline-track.caption-track.is-hidden {');
    expect(timelineSource).toContain('background: #8f9aab;');
    expect(timelineSource).toContain('filter: grayscale(1);');
    // Locking already rejects every edit through the trackLocked guards, so the hatch is what makes
    // it visible; it must not swallow the pointer those guards need to see.
    expect(timelineSource).toContain('.timeline-track.is-locked::after {');
    expect(timelineSource).toContain('rgba(38, 59, 89, 0.16) 0 6px,');
    // The video track's speaker washes out the audio strip at the clip's foot and leaves the picture
    // alone, which is what "声音关闭" means.
    expect(timelineSource).toContain("'is-muted': trackMuted('VIDEO'),");
    expect(timelineSource).toContain('.video-clip.is-muted .clip-waveform {');
  });
  it('follows the fork a full update opened instead of editing the published Run', () => {
    // Re-filling and packaging both fork an unpublished child on the server. The page has to move to
    // that Run before it reads the draft back, or the edit lands in the published branch.
    expect(rawPageSource).toContain('if (result.data.workflowRunId !== props.workflowRunId) {');
    expect(rawPageSource).toContain("emit('workflowRunChange');");
    expect(packagingSource).toContain('if (response.data.workflowRunId !== context.workflowRunId) {');
    expect(packagingSource).toContain("emit('runChange', response.data.workflowRunId);");
    expect(rawPageSource).toContain(
      'const handlePackagingRunChange = (workflowRunId: string): void => {',
    );
    expect(rawPageSource).toContain('@run-change="handlePackagingRunChange"');
  });
  it('keeps the workbench mounted and restores its selection when the fork changes Run', () => {
    expect(workflowSource).toContain(':key="`mix:${currentProjectId}`"');
    expect(workflowSource).not.toContain(':key="`${currentProjectId}:${workspace?.workflowRunId ?? \'\'}`"');
    expect(pageSource).toContain(
      "import { rememberWorkbench, takeWorkbench } from './effect-template-mix-workbench-handoff';",
    );
    expect(pageSource).toContain(
      'const handoff = !wasReady || runSwitching.value ? takeWorkbench(workflowRunId) : null;',
    );
    expect(pageSource).toContain("runSwitching.value = pageState.value === 'READY';");
    expect(pageSource).toContain("if (!wasReady) pageState.value = 'LOADING';");
    expect(pageSource).toContain('requestController !== controller ||');
    expect(pageSource).toContain('当前工作台保持可见');
    expect(pageSource).toContain('} else if (handoff) {');
    expect(pageSource).toContain('  rememberWorkbench({\n    workflowRunId,\n');
    expect(pageSource).toContain(
      '      rememberWorkbench({\n        workflowRunId: result.data.workflowRunId,\n',
    );
  });
});
