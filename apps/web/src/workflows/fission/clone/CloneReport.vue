<script setup lang="ts">
import {
  BarChart3,
  Sparkles,
  Package,
  Film,
  Music,
  Palette,
  AlertTriangle,
  Play,
} from '@lucide/vue';
import type { CloneMockState } from './clone-mock';
import { clonePrototypeFixture as fixture } from './clone-prototype.fixture';
defineProps<{ state: CloneMockState }>();
const icons = [BarChart3, Sparkles, Package, Film, Music, Palette];
const labels: Record<string, string> = {
  summary: '整体叙事结构',
  ratios: '各阶段时长占比',
  hook: '钩子位置',
  conversion: '转化节点',
  rhythm: '节奏曲线',
  concept: '核心创意',
  emotion: '情绪共鸣',
  contrast: '反差设计',
  memory: '记忆锚点',
  timing: '产品出场时机',
  angles: '产品展示角度',
  closeup: '产品特写占比',
  effect: '效果呈现方式',
  bgm: 'BGM 节奏与卡点',
  voice: '口播节奏',
  sfx: '环境声与音效',
  silence: '静音设计',
  subtitle: '字幕样式与安全区',
  filter: '色彩与滤镜',
  stickers: '贴纸与装饰',
  ratio: '画幅与构图安全区',
};
</script>
<template>
  <div class="frg-body">
    <div class="frg-report-meta">
      <div>
        <span>参考视频</span><b>{{ state.reference?.name ?? '未上传' }}</b>
      </div>
      <div><span>关联商品</span><b>广式腊肠</b></div>
      <div><span>时长 / 画幅</span><b>00:32 · 9:16</b></div>
      <div><span>解析方式</span><b>六维深度拆解</b></div>
      <div><span>报告状态</span><b>本地 Mock · 可编辑</b></div>
    </div>
    <section class="frg-section">
      <header class="frg-section-head">
        <b>六维视频解析报告</b><small>固定顺序 · 全部字段可编辑</small>
      </header>
      <div class="frg-dimensions">
        <article v-for="(dim, index) in state.report" :key="dim.name" class="frg-dimension">
          <header>
            <span><component :is="icons[index]" :size="17" /></span
            ><b>{{ index + 1 }}. {{ dim.name }}</b
            ><small>字段均可直接编辑</small>
          </header>
          <div v-if="index !== 3" class="frg-dimension-fields">
            <div
              v-for="key in Object.keys(dim).filter((k) => labels[k])"
              :key="key"
              class="frg-dimension-field"
              :class="{ wide: key === 'summary' }"
            >
              <label :for="`report-${key}`">{{ labels[key] }}</label
              ><textarea :id="`report-${key}`" v-model="dim[key]" />
            </div>
          </div>
          <div v-else class="frg-shot-timeline">
            <article v-for="(shot, i) in state.shots" :key="shot.time" class="frg-shot-card">
              <div class="frg-shot-preview" :class="`scene-${i + 1}`">
                <span class="frg-shot-time">{{ shot.time }}</span
                ><Play :size="30" /><b>{{ shot.title }}</b>
              </div>
              <div class="frg-shot-detail">
                <h4>镜头 {{ String(i + 1).padStart(2, '0') }} · {{ shot.title }}</h4>
                <div class="frg-shot-fields">
                  <div
                    v-for="(label, key) in {
                      shotType: '景别',
                      move: '运镜',
                      transition: '转场',
                      composition: '构图',
                      elements: '画面元素',
                    }"
                    :key="key"
                    class="frg-shot-field"
                    :class="{ wide: key === 'elements' }"
                  >
                    <label :for="`shot-${i}-${key}`">{{ label }}</label
                    ><textarea :id="`shot-${i}-${key}`" v-model="shot[key]" />
                  </div>
                </div>
              </div>
            </article>
          </div>
          <div v-if="index === 0" class="frg-structure-track">
            <div
              v-for="(s, i) in state.shots"
              :key="s.time"
              class="frg-structure-stage"
              :style="{ flex: [3, 4, 5, 10, 6, 4][i] }"
            >
              <b>{{ s.title }}</b
              ><span>{{ s.time }}</span
              ><i />
            </div>
          </div>
        </article>
      </div>
    </section>
    <section class="frg-section">
      <header class="frg-section-head">
        <b>可迁移到当前商品的创作建议</b><small>结合 {{ state.materials.length }} 份商品原料</small>
      </header>
      <div class="frg-migrations">
        <article
          v-for="m in state.materials.length ? fixture.migrationSuggestions : []"
          :key="m.title"
          class="frg-migration"
        >
          <b>{{ m.title }}</b>
          <p>{{ m.text }}</p>
        </article>
        <article v-if="!state.materials.length" class="frg-migration empty">
          <b>待补充商品原料</b>
          <p>返回上传素材补充商品图片后重新拆解。</p>
        </article>
      </div>
    </section>
    <section class="frg-section">
      <header class="frg-section-head">
        <b>解析告警与补充建议</b><small>Mock 风险样例</small>
      </header>
      <div class="frg-warning-list">
        <article
          v-for="w in fixture.analysisWarnings"
          :key="w.title"
          class="frg-warning"
          :class="w.level"
        >
          <AlertTriangle :size="16" />
          <div>
            <b>{{ w.title }}</b>
            <p>{{ w.text }}</p>
          </div>
        </article>
      </div>
    </section>
  </div>
</template>
