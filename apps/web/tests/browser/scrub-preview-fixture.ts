/** Explicit offline browser fixture: synthetic workspace, local media, no business requests. */
import { createApp, h, ref } from 'vue';
import type { EffectTemplateMixRole, EffectTemplateMixVariant } from '@ai-marketing/contracts';
import Mix from '../../src/workflows/effect/template-mix/EffectTemplateMixNodePage.vue';
import { rememberWorkbench } from '../../src/workflows/effect/template-mix/effect-template-mix-workbench-handoff';
import '../../src/styles/global.css';

const roles: EffectTemplateMixRole[] = ['HOOK', 'PAIN_POINT', 'PRODUCT', 'SELLING_POINT', 'TRANSFORMATION', 'END'];
const slots = roles.map((role, i) => ({ id: `s${i}`, role, label: `槽位${i + 1}`,
  duration: 4, purpose: 'PRODUCT_DISPLAY' as const, transition: '硬切' as const }));
const media = '/tests/manual/fixtures/effect-final-output-demo.mp4';
const materials = slots.map((slot, i) => ({ id: `m${i}`, code: `R-${i + 1}`, name: `隔离视频${i + 1}`,
  duration: 4, purpose: 'PRODUCT_DISPLAY', compatiblePurposes: ['PRODUCT_DISPLAY'],
  artifactId: `m${i}`, artifactKey: `render-clip:m${i}`, artifactRevision: 1, fileObjectId: `f${i}`,
  contentHash: `hash${i}`, contentUrl: media, ratio: '16:9', resolution: '720p', available: true, activeSource: true }));
const variant: EffectTemplateMixVariant = {
  id: 'v', name: '快速定位回归', appliedTemplateVersion: 1, slots,
  bindings: Object.fromEntries(slots.map((s, i) => [s.id, `m${i}`])),
  bindingRevisions: Object.fromEntries(slots.map(s => [s.id, 1])), offsets: {}, manualSlotIds: [],
  conflictSlotIds: [], status: 'CURRENT', captions: [], subtitleStyle: 'standard', bgm: null, voice: null, originalVolume: 1,
};
const workspace = {
  draftRevision: 1, templateCreationReady: true, slotDurationMaxSeconds: 10,
  draft: { schemaVersion: 1, activeTemplateId: 't', templates: [{ id: 't', workspace: {
    editVersion: 1, template: { name: '定位回归模板', editVersion: 1, slots }, variants: [variant],
  } }] }, materials, commits: [], classificationPools: [], aiRuns: [], pendingAddedMaterialIds: {},
};
const blockedWrites = ref(0);
const result = ref('未执行连续定位');
const rapidScrub = async () => {
  const slider = document.querySelector<HTMLInputElement>('input[aria-label="播放进度"]');
  if (!slider) { result.value = '未找到播放进度控件'; return; }
  let covers = 0;
  for (let i = 0; i < 60; i++) {
    // Same events as dragging the native range; alternate forwards/backwards within one clip.
    slider.value = String(i % 2 ? 2.3 : 1.1);
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    covers += document.querySelectorAll('.player-first-frame').length;
  }
  for (const time of [6.2, 18.1, 5.7, 14.5, 10.3]) {
    slider.value = String(time);
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  }
  await new Promise(resolve => setTimeout(resolve, 300));
  const videos = [...document.querySelectorAll<HTMLVideoElement>('video.timeline-stage-video')];
  const visible = videos.filter(v => getComputedStyle(v).opacity === '1');
  result.value = `连续定位 65 次 · 同素材封面覆盖 ${covers} 帧 · 最终播放头 ${slider.value} 秒 · 视频 ${visible.map(v => v.currentTime.toFixed(3)).join(',')} 秒 · 首帧封面 ${document.querySelectorAll('.player-first-frame').length}`;
};
const nativeFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = String(input), method = (init?.method ?? 'GET').toUpperCase();
  if (!['GET', 'HEAD'].includes(method)) {
    blockedWrites.value++;
    // Acknowledge navigation-only autosaves in memory; never forward to the API.
    return new Response(JSON.stringify({ data: url.includes('/final-output/sync') ? { refreshed: [] } : workspace, requestId: 'offline-scrub-write' }),
      { headers: { 'Content-Type': 'application/json' } });
  }
  if (!url.includes('/api/')) return nativeFetch(input, init);
  let data: unknown = [];
  if (url.includes('/branches')) data = { branches: [] };
  else if (url.includes('/template-mix?')) data = workspace;
  else if (url.includes('/sources?')) data = { materials, draftRevision: 1, pendingAddedMaterialIds: {} };
  else if (url.includes('/background-')) data = null;
  return new Response(JSON.stringify({ data, requestId: 'offline-scrub' }), { headers: { 'Content-Type': 'application/json' } });
};
rememberWorkbench({ workflowRunId: 'qa-run', templateId: 't', variantId: 'v', view: 'EDITOR' });
createApp({ setup: () => () => h('main', [
  h('p', `隔离快速定位回归 · 真实业务请求 0 · 阻止写入 ${blockedWrites.value}`),
  h('button', { onClick: rapidScrub }, '执行快速连续定位'),
  h('p', { role: 'status' }, result.value),
  h(Mix, { projectId: 'qa-project', workflowRunId: 'qa-run', products: [] }),
]) }).mount('#app');
