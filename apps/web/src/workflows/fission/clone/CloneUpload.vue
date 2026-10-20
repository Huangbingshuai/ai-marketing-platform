<script setup lang="ts">
import { Play, Upload, Plus, X, Info } from '@lucide/vue';
import type { CloneMockState } from './clone-mock';
import CloneIcon from './CloneIcon.vue';
defineProps<{
  state: CloneMockState;
  referenceUrl: string;
  previews: Record<string, string>;
  busy: boolean;
}>();
const emit = defineEmits<{
  reference: [files: FileList | null];
  materials: [files: FileList | null];
  remove: [id: string];
  removeReference: [];
  fetch: [];
  preview: [id: string];
  pid: [value: string];
}>();
</script>
<template>
  <div class="frg-body">
    <div class="frg-source-grid">
      <section
        class="frg-card"
        @dragover.prevent
        @drop.prevent="emit('reference', $event.dataTransfer?.files ?? null)"
      >
        <header class="frg-card-head">
          <b>爆款参考视频</b><span class="frg-required">必填</span><span class="grow" /><small
            >单文件</small
          >
        </header>
        <div v-if="state.reference" class="frg-video-card">
          <video v-if="referenceUrl" controls :src="referenceUrl" />
          <button
            v-else
            class="frg-video-placeholder"
            aria-label="查看参考视频演示说明"
            @click="emit('preview', 'reference')"
          >
            <Play :size="38" /><small>爆款参考 · 00:32 · Mock</small>
          </button>
          <div class="frg-video-meta">
            <div>
              <b>{{ state.reference.name }}</b
              ><small
                >{{ state.reference.size }} · {{ state.reference.duration }} ·
                {{ state.reference.resolution }} · {{ state.reference.ratio }}</small
              >
            </div>
            <label class="frg-btn file-button"
              >更换<input
                type="file"
                accept="video/*"
                @change="emit('reference', ($event.target as HTMLInputElement).files)"
            /></label>
            <button class="frg-btn danger" @click="emit('removeReference')">删除</button>
          </div>
        </div>
        <label
          v-else
          class="frg-drop"
          tabindex="0"
          @keydown.enter="($event.currentTarget as HTMLElement).querySelector('input')?.click()"
          ><input
            type="file"
            accept="video/*"
            @change="emit('reference', ($event.target as HTMLInputElement).files)"
          /><span class="frg-drop-icon"><Upload /></span><b>上传爆款参考视频</b>
          <p>支持 MP4 / MOV，建议 60 秒以内</p>
          <em>选择视频或拖拽至此</em></label
        >
      </section>
      <section
        class="frg-card"
        @dragover.prevent
        @drop.prevent="emit('materials', $event.dataTransfer?.files ?? null)"
      >
        <header class="frg-card-head">
          <b>商品原料</b><span class="frg-optional">可选</span><span class="grow" /><small
            >{{ state.materials.length }} 份素材</small
          >
        </header>
        <div class="frg-product-tools">
          <label class="frg-pid-field"
            ><span>商品链接 / PID</span
            ><input
              :value="state.pid"
              placeholder="例如 P-GZLC-2026-001"
              @input="emit('pid', ($event.target as HTMLInputElement).value)" /></label
          ><button
            class="frg-btn primary"
            :disabled="busy || !state.pid.trim()"
            @click="emit('fetch')"
          >
            {{ busy ? '获取中…' : '获取商品素材' }}
          </button>
          <p class="frg-product-hint">
            本地 Mock 提供轮播图、白底图和详情页样例，不访问真实商品链接。
          </p>
        </div>
        <label
          class="frg-material-uploader"
          tabindex="0"
          @keydown.enter="($event.currentTarget as HTMLElement).querySelector('input')?.click()"
          ><input
            type="file"
            multiple
            accept="image/*,video/*"
            @change="emit('materials', ($event.target as HTMLInputElement).files)"
          /><span><Plus :size="20" /></span>
          <div>
            <b>批量上传商品图片或展示视频</b
            ><small>建议包含开箱平铺、完整包装、手持尺寸参照、正侧背面和多角度素材</small>
          </div></label
        >
        <div class="frg-materials">
          <article v-for="m in state.materials" :key="m.id" class="frg-material">
            <button
              class="frg-material-thumb"
              :class="{ video: m.type === 'video' }"
              :aria-label="`预览${m.name}`"
              @click="emit('preview', m.id)"
            >
              <img
                v-if="previews[m.id] && m.type === 'image'"
                :src="previews[m.id]"
                :alt="m.name"
              /><CloneIcon v-else :type="m.type" :size="26" />
            </button>
            <button
              class="frg-material-remove"
              :aria-label="`删除${m.name}`"
              @click="emit('remove', m.id)"
            >
              <X :size="12" />
            </button>
            <div class="frg-material-info">
              <b :title="m.name">{{ m.name }}</b
              ><small>{{ m.category }} · {{ m.size }}</small>
              <div class="frg-material-tags">
                <span v-for="tag in m.tags" :key="tag">{{ tag }}</span>
              </div>
            </div>
          </article>
          <div v-if="!state.materials.length" class="frg-note warn">
            尚未添加商品原料，可先完成参考视频拆解。
          </div>
        </div>
      </section>
    </div>
    <div class="frg-note">
      <Info
        :size="15"
      />参考视频为深度拆解必填项；商品原料可选，添加后将输出可迁移到当前商品的创作建议。
    </div>
  </div>
</template>
