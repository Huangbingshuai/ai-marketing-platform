<script setup lang="ts">
import type { Asset } from '@ai-marketing/contracts';
import {
  ArrowRight,
  FileText,
  Image,
  Link2,
  ListChecks,
  Lock,
  Play,
  Replace,
  ScanSearch,
  Settings2,
  UserRound,
} from '@lucide/vue';
import { computed, ref } from 'vue';

const props = withDefaults(defineProps<{ asset: Asset; compact?: boolean }>(), { compact: false });
const mediaFailed = ref(false);
const kind = computed(() => props.asset.type);
const views = computed(() =>
  props.asset.views?.length ? props.asset.views.slice(0, 3) : ['内容预览', '文件规格', '版本记录'],
);
const contentSummary = computed(() => {
  const content = props.asset.content ?? props.asset.businessData;
  if (typeof content === 'string') return content;
  if (content && typeof content === 'object') {
    const record = content as Record<string, unknown>;
    const value = record.summary ?? record.text ?? record.description;
    if (typeof value === 'string') return value;
  }
  return props.asset.notes || props.asset.originalFileName || props.asset.name;
});
const isDocument = computed(() => ['SOURCE_MATERIAL', 'ARCHIVE_DELIVERABLE'].includes(kind.value));
const isText = computed(() => ['PROMPT', 'SCRIPT_COPY'].includes(kind.value));
const isStoryboard = computed(() => kind.value === 'STORYBOARD_SCRIPT');
const isTimeline = computed(() =>
  ['MIX_TEMPLATE', 'TIMELINE_PROJECT', 'EDITING_PROJECT'].includes(kind.value),
);
const isReport = computed(() => ['INSIGHT_RESULT', 'ANALYSIS_QUALITY_REPORT'].includes(kind.value));
const isManifest = computed(() => kind.value === 'DELIVERY_MANIFEST');
const isAudio = computed(() => ['VOICE_AUDIO', 'VOICE_PROFILE'].includes(kind.value));
const isSubtitle = computed(() => kind.value === 'SUBTITLE');
const isMapping = computed(() => ['REPLACEMENT_MAPPING', 'REFERENCE_SET'].includes(kind.value));
const isConfiguration = computed(() => kind.value === 'REPLACEMENT_CONFIGURATION');
const isVideo = computed(() =>
  ['GENERIC_VIDEO', 'REFERENCE_VIDEO', 'SOURCE_VIDEO', 'VIDEO_MATERIAL', 'FINAL_VIDEO'].includes(
    kind.value,
  ),
);
const isVisual = computed(() =>
  [
    'DIGITAL_HUMAN_CHARACTER',
    'AVATAR_REFERENCE',
    'PERSON_ASSET',
    'PRODUCT_ASSET',
    'SCENE_BACKGROUND',
    'VISUAL_ASSET',
  ].includes(kind.value),
);
</script>

<template>
  <div class="v4-preview" :class="{ detail: !compact }">
    <div v-if="isDocument" class="preview-document">
      <div class="document-cover">
        <FileText :size="compact ? 17 : 24" /><i>DOC</i><strong>{{ asset.name }}</strong
        ><small>{{ asset.originalFileName || '项目资料' }}</small>
      </div>
      <div class="document-tabs">
        <span v-for="view in views" :key="view">{{ view }}</span>
      </div>
    </div>
    <div v-else-if="isText" class="preview-text">
      <header>
        <i>{{ kind === 'PROMPT' ? 'PROMPT' : 'SCRIPT' }}</i
        ><b>{{ asset.name }}</b>
      </header>
      <p>{{ contentSummary }}</p>
      <span /><span /><span />
    </div>
    <div v-else-if="isStoryboard" class="preview-storyboard">
      <header>
        <b>分镜脚本</b><em>{{ views.length }} 镜</em>
      </header>
      <div v-for="(view, index) in views" :key="view">
        <i>{{ index + 1 }}</i
        ><span>{{ view }}</span
        ><small>00:0{{ index * 4 }}–00:{{ String(index * 4 + 4).padStart(2, '0') }}</small>
      </div>
    </div>
    <div v-else-if="isTimeline" class="preview-timeline">
      <header>
        <b>{{ kind === 'MIX_TEMPLATE' ? '模板槽位' : '剪辑时间轴' }}</b
        ><small>00:30</small>
      </header>
      <div class="ruler">00:00 / 00:10 / 00:20 / 00:30</div>
      <p class="video"><i /><i /><i /><i /></p>
      <p class="subtitle"><i /><i /><i /></p>
      <p class="audio"><i /></p>
    </div>
    <div v-else-if="isReport" class="preview-report">
      <header>
        <b>{{ kind === 'INSIGHT_RESULT' ? '提炼结果' : '分析报告' }}</b
        ><em>指标已生成</em>
      </header>
      <section>
        <div v-for="(view, index) in views" :key="view">
          <span>{{ view }}</span
          ><strong>{{ [92, 88, 96][index] }}%</strong
          ><i :style="{ width: `${[92, 88, 96][index]}%` }" />
        </div>
      </section>
    </div>
    <div v-else-if="isManifest" class="preview-manifest">
      <header>
        <ListChecks :size="15" /><b>交付清单</b><em>{{ views.length }} 个文件</em>
      </header>
      <div class="table-row head"><span>文件</span><span>格式</span><span>规格</span></div>
      <div v-for="(view, index) in views" :key="view" class="table-row">
        <span>{{ view }}</span
        ><span>{{ index === 1 ? 'SRT' : 'MP4' }}</span
        ><span>1080P</span>
      </div>
    </div>
    <div v-else-if="isAudio" class="preview-audio">
      <header>
        <b>{{ asset.name }}</b
        ><small>标准音色</small>
      </header>
      <div class="wave">
        <i v-for="index in 34" :key="index" :style="{ height: `${18 + ((index * 17) % 45)}%` }" />
      </div>
      <audio
        v-if="!compact && asset.hasFile && !mediaFailed"
        controls
        :src="asset.contentUrl"
        @error="mediaFailed = true"
      />
      <footer v-else><button type="button">▶ 试听</button><span /><em>00:30</em></footer>
    </div>
    <div v-else-if="isSubtitle" class="preview-subtitle">
      <div>
        <small>00:08.20</small><strong>{{ views[0] }}</strong
        ><em>底部安全区</em>
      </div>
    </div>
    <div v-else-if="isMapping || isConfiguration" class="preview-mapping">
      <section>
        <Settings2 v-if="isConfiguration" :size="compact ? 20 : 34" /><ScanSearch
          v-else
          :size="compact ? 20 : 34"
        /><b>{{ isConfiguration ? '单镜头' : views[0] }}</b>
      </section>
      <ArrowRight :size="18" />
      <section>
        <Lock v-if="isConfiguration" :size="compact ? 20 : 34" /><Replace
          v-else
          :size="compact ? 20 : 34"
        /><b>{{ isConfiguration ? '原片结构锁定' : views[1] }}</b
        ><small>v{{ asset.currentVersion ?? 1 }}</small>
      </section>
    </div>
    <div v-else-if="isVideo" class="preview-video">
      <video
        v-if="!compact && asset.hasFile && !mediaFailed"
        controls
        :src="asset.contentUrl"
        @error="mediaFailed = true"
      /><template v-else>
        <section>
          <i v-for="(view, index) in views" :key="view" :class="`tone-${index}`"
            ><Play :size="compact ? 15 : 24" fill="currentColor" /><small>{{ view }}</small></i
          >
        </section>
        <footer><span>9:16</span><span>00:15</span><span>1080P</span></footer>
      </template>
    </div>
    <div v-else-if="isVisual" class="preview-visual">
      <span v-for="(view, index) in views" :key="view" :class="`tone-${index}`"
        ><img
          v-if="index === 0 && asset.hasFile && !mediaFailed"
          :src="asset.contentUrl"
          alt=""
          @error="mediaFailed = true"
        /><UserRound
          v-else-if="kind === 'DIGITAL_HUMAN_CHARACTER' || kind === 'PERSON_ASSET'"
          :size="compact ? 24 : 38"
        /><Image v-else :size="compact ? 24 : 38" /><small>{{ view }}</small></span
      >
    </div>
    <div v-else class="preview-fallback">
      <Link2 :size="compact ? 24 : 38" /><strong>{{ asset.name }}</strong
      ><small>{{ asset.originalFileName }}</small>
    </div>
  </div>
</template>

<style scoped>
.v4-preview {
  height: 144px;
  overflow: hidden;
  border-bottom: 1px solid #dce5f1;
  background: #eef4fb;
  color: #27364e;
}
.v4-preview.detail {
  height: 238px;
  border: 1px solid #d8e2f0;
  border-radius: 15px;
  box-shadow: 0 8px 22px rgb(38 75 130 / 8%);
}
.v4-preview header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.v4-preview header b {
  font-size: 9px;
}
.v4-preview header em,
.v4-preview header small {
  color: #718097;
  font-size: 7px;
  font-style: normal;
}
.detail header b {
  font-size: 13px;
}
.detail header em,
.detail header small {
  font-size: 10px;
}
.preview-document {
  height: 100%;
  display: grid;
  grid-template-columns: 1.2fr 0.8fr;
  padding: 12px;
  background: linear-gradient(135deg, #edf4ff, #f9fbff);
}
.document-cover {
  display: flex;
  min-width: 0;
  flex-direction: column;
  justify-content: center;
  padding: 8px 12px;
  border-left: 5px solid #2766ed;
  border-radius: 7px;
  background: #fff;
  box-shadow: 0 5px 14px rgb(39 102 237 / 10%);
}
.document-cover svg,
.document-cover i {
  color: #2766ed;
}
.document-cover i {
  font-size: 7px;
  font-style: normal;
  font-weight: 900;
  letter-spacing: 0.12em;
}
.document-cover strong {
  margin: 5px 0;
  overflow: hidden;
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.document-cover small {
  color: #7c899e;
  font-size: 7px;
}
.document-tabs {
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 6px;
  margin-left: 8px;
}
.document-tabs span {
  padding: 5px 7px;
  border-radius: 5px;
  background: #dfeafb;
  color: #56709a;
  font-size: 7px;
}
.detail .preview-document {
  padding: 22px;
}
.detail .document-cover {
  padding: 18px 22px;
}
.detail .document-cover strong {
  font-size: 17px;
}
.detail .document-tabs span,
.detail .document-cover small {
  font-size: 10px;
}
.preview-text {
  height: 100%;
  padding: 12px 14px;
  background: #f8faff;
}
.preview-text header {
  justify-content: flex-start;
  gap: 7px;
}
.preview-text header i {
  padding: 3px 5px;
  border-radius: 4px;
  background: #2766ed;
  color: #fff;
  font-size: 7px;
  font-style: normal;
}
.preview-text p {
  height: 48px;
  margin: 10px 0 5px;
  overflow: hidden;
  color: #52627a;
  font-size: 9px;
  line-height: 1.55;
}
.preview-text > span {
  display: block;
  width: 88%;
  height: 3px;
  margin-top: 5px;
  border-radius: 3px;
  background: #dce5f1;
}
.preview-text > span:nth-last-child(2) {
  width: 72%;
}
.preview-text > span:last-child {
  width: 52%;
}
.detail .preview-text {
  padding: 20px 22px;
}
.detail .preview-text p {
  height: 112px;
  font-size: 12px;
  line-height: 1.75;
}
.preview-storyboard {
  height: 100%;
  padding: 10px 12px;
  background: #f8faff;
}
.preview-storyboard header {
  margin-bottom: 5px;
}
.preview-storyboard > div {
  display: grid;
  grid-template-columns: 20px 1fr auto;
  align-items: center;
  gap: 6px;
  padding: 6px 0;
  border-top: 1px solid #e3eaf3;
  font-size: 7px;
}
.preview-storyboard > div i {
  display: grid;
  width: 17px;
  height: 17px;
  place-items: center;
  border-radius: 4px;
  background: #e7efff;
  color: #2766ed;
  font-style: normal;
  font-weight: 900;
}
.preview-storyboard > div small {
  color: #8d98aa;
}
.detail .preview-storyboard {
  padding: 16px 18px;
}
.detail .preview-storyboard > div {
  grid-template-columns: 28px 1fr auto;
  padding: 10px 0;
  font-size: 10px;
}
.detail .preview-storyboard > div i {
  width: 24px;
  height: 24px;
}
.preview-timeline {
  height: 100%;
  padding: 10px 12px;
  background: #222b39;
  color: #fff;
}
.preview-timeline header small {
  color: #b7c4d6;
}
.ruler {
  margin: 8px 0 4px;
  color: #8090a5;
  font-size: 7px;
}
.preview-timeline p {
  display: flex;
  height: 19px;
  margin: 4px 0;
  overflow: hidden;
  border-radius: 3px;
  background: #131923;
}
.preview-timeline p i {
  display: block;
  margin-right: 2px;
  border-radius: 2px;
}
.preview-timeline .video i {
  width: 25%;
  background: #3678e8;
}
.preview-timeline .subtitle i {
  width: 34%;
  background: #75849c;
}
.preview-timeline .audio i {
  width: 100%;
  background: repeating-linear-gradient(90deg, #20a37a 0 2px, #5dd0ad 2px 3px);
}
.detail .preview-timeline {
  padding: 16px 18px;
}
.detail .ruler {
  margin: 13px 0 8px;
  font-size: 9px;
}
.detail .preview-timeline p {
  height: 30px;
  margin: 7px 0;
}
.preview-report {
  height: 100%;
  padding: 11px 13px;
  background: #f7faff;
}
.preview-report section {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 7px;
  margin-top: 12px;
}
.preview-report section div {
  padding: 8px;
  border: 1px solid #dce5f1;
  border-radius: 7px;
  background: #fff;
}
.preview-report span,
.preview-report strong {
  display: block;
}
.preview-report span {
  height: 22px;
  color: #78869a;
  font-size: 7px;
}
.preview-report strong {
  margin: 4px 0;
  color: #2766ed;
  font-size: 13px;
}
.preview-report section i {
  display: block;
  height: 3px;
  border-radius: 3px;
  background: #2fa87c;
}
.detail .preview-report {
  padding: 18px;
}
.detail .preview-report section {
  gap: 10px;
  margin-top: 16px;
}
.detail .preview-report section div {
  padding: 14px;
}
.detail .preview-report span {
  height: 28px;
  font-size: 10px;
}
.detail .preview-report strong {
  font-size: 20px;
}
.preview-manifest {
  height: 100%;
  padding: 10px 12px;
  background: #fff;
}
.preview-manifest header {
  justify-content: flex-start;
  gap: 6px;
}
.preview-manifest header em {
  margin-left: auto;
}
.table-row {
  display: grid;
  grid-template-columns: 1.4fr 0.6fr 0.7fr;
  gap: 5px;
  padding: 6px 2px;
  border-top: 1px solid #edf1f6;
  color: #66758a;
  font-size: 7px;
}
.table-row.head {
  margin-top: 7px;
  background: #eef4ff;
  color: #2766ed;
  font-weight: 900;
}
.detail .preview-manifest {
  padding: 16px 18px;
}
.detail .table-row {
  padding: 10px 6px;
  font-size: 10px;
}
.preview-audio {
  height: 100%;
  padding: 11px 13px;
  background: linear-gradient(180deg, #f4f8ff, #eaf2ff);
}
.wave {
  height: 70px;
  display: flex;
  align-items: center;
  gap: 2px;
  margin-top: 8px;
}
.wave i {
  flex: 1;
  min-height: 4px;
  border-radius: 2px;
  background: #4380eb;
}
.preview-audio footer {
  display: flex;
  align-items: center;
  gap: 7px;
  color: #74829a;
  font-size: 7px;
}
.preview-audio footer button {
  padding: 0;
  border: 0;
  background: transparent;
  color: #2766ed;
  font-weight: 800;
}
.preview-audio footer span {
  flex: 1;
  height: 2px;
  background: #bfd0ea;
}
.preview-audio audio {
  width: 100%;
  height: 38px;
}
.detail .wave {
  height: 138px;
}
.detail .preview-audio footer {
  font-size: 10px;
}
.preview-subtitle {
  height: 100%;
  display: grid;
  padding: 12px;
  place-items: center;
  background: linear-gradient(135deg, #d8e5f2, #a9bfd5);
}
.preview-subtitle > div {
  width: 86%;
  height: 106px;
  display: flex;
  padding: 7px;
  align-items: center;
  justify-content: flex-end;
  flex-direction: column;
  border-radius: 6px;
  background: linear-gradient(180deg, #62758c, #273448);
  color: #fff;
}
.preview-subtitle small {
  align-self: flex-start;
  color: #b9c8d9;
  font-size: 7px;
}
.preview-subtitle strong {
  max-width: 95%;
  padding: 4px 8px;
  border-radius: 4px;
  background: rgb(12 18 28 / 70%);
  font-size: 10px;
}
.preview-subtitle em {
  margin-top: 3px;
  color: #b9c8d9;
  font-size: 7px;
  font-style: normal;
}
.detail .preview-subtitle > div {
  height: 190px;
}
.detail .preview-subtitle strong {
  font-size: 14px;
}
.preview-mapping {
  height: 100%;
  display: grid;
  grid-template-columns: 1fr 28px 1fr;
  align-items: center;
  gap: 5px;
  padding: 12px;
  background: #f5f8fd;
}
.preview-mapping > section {
  height: 100px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  border: 1px solid #dce5f1;
  border-radius: 8px;
  background: #fff;
}
.preview-mapping > section svg {
  color: #2766ed;
}
.preview-mapping > section b {
  margin-top: 7px;
  font-size: 8px;
}
.preview-mapping > section small {
  color: #7f8da1;
  font-size: 7px;
}
.preview-mapping > svg {
  color: #2766ed;
}
.detail .preview-mapping > section {
  height: 190px;
}
.detail .preview-mapping > section b {
  font-size: 12px;
}
.preview-video {
  height: 100%;
  background: #172131;
}
.preview-video video {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.preview-video section {
  display: grid;
  height: 110px;
  grid-template-columns: repeat(3, 1fr);
  gap: 2px;
}
.preview-video section i {
  position: relative;
  display: grid;
  place-items: center;
  background: linear-gradient(145deg, #87432f, #d47c4a);
  color: #fff;
  font-style: normal;
}
.preview-video section .tone-1 {
  background: linear-gradient(145deg, #244d76, #5c8eb7);
}
.preview-video section .tone-2 {
  background: linear-gradient(145deg, #485a3b, #99ac68);
}
.preview-video section i small {
  position: absolute;
  right: 4px;
  bottom: 4px;
  left: 4px;
  overflow: hidden;
  font-size: 7px;
  text-align: center;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.preview-video footer {
  display: flex;
  padding: 8px;
  justify-content: space-around;
  color: #b9c6d8;
  font-size: 8px;
}
.detail .preview-video section {
  height: 194px;
}
.detail .preview-video footer {
  padding: 10px;
  font-size: 10px;
}
.preview-visual {
  height: 100%;
  display: grid;
  padding: 7px;
  grid-template-columns: repeat(3, 1fr);
  gap: 2px;
  background: #e9eef6;
}
.preview-visual > span {
  position: relative;
  display: grid;
  overflow: hidden;
  place-items: center;
  border-radius: 6px;
  background: linear-gradient(145deg, #fff, #cdd8e7);
  color: #6a7c97;
}
.preview-visual > span.tone-1 {
  background: linear-gradient(145deg, #edf4ff, #bacbe1);
}
.preview-visual > span.tone-2 {
  background: linear-gradient(145deg, #e7eef7, #91a7c5);
}
.preview-visual img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.preview-visual small {
  position: absolute;
  right: 4px;
  bottom: 3px;
  left: 4px;
  padding: 2px 3px;
  overflow: hidden;
  border-radius: 3px;
  background: #17233aaa;
  color: #fff;
  font-size: 7px;
  text-align: center;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.preview-fallback {
  height: 100%;
  display: flex;
  padding: 20px;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  gap: 7px;
  color: #5e7190;
}
.preview-fallback strong {
  max-width: 90%;
  overflow: hidden;
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.preview-fallback small {
  color: #8793a6;
  font-size: 8px;
}
</style>
