<script setup lang="ts">
import { ArrowRight, Eye, EyeOff, LoaderCircle, LockKeyhole } from '@lucide/vue';
import { ref } from 'vue';
import richiLogo from '../../assets/richi-logo-color.png';
import { ApiClientError } from '../../api/http-client';
import { login } from './auth-state';

defineProps<{ checking: boolean; startupError: string }>();
defineEmits<{ retry: [] }>();
const username = ref('');
const password = ref('');
const visible = ref(false);
const busy = ref(false);
const error = ref('');
const submit = async (): Promise<void> => {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    await login({ username: username.value.trim(), password: password.value });
  } catch (cause) {
    error.value = cause instanceof ApiClientError ? cause.message : '暂时无法连接系统，请稍后重试';
    password.value = '';
    visible.value = false;
  } finally {
    busy.value = false;
  }
};
</script>

<template>
  <main class="login-page">
    <header class="login-brand">
      <img :src="richiLogo" alt="瑞池传媒" />
      <div><strong>AI 营销素材智能生成系统</strong><span>RICH MEDIA · AI MARKETING</span></div>
    </header>
    <div class="login-layout">
      <section class="login-story" aria-label="瑞池内容工作台">
        <p class="story-kicker"><span /> RICH MEDIA STUDIO</p>
        <h1>让好创意，<br />成为好作品<span>。</span></h1>
        <p class="story-copy">从商品资料到视频成片，<br />让每一步创作，都在同一个工作台发生。</p>
        <div class="studio-art" aria-hidden="true">
          <div class="art-header"><span>STUDIO / 01</span><span>CONTENT IN MOTION</span></div>
          <div class="art-stage">
            <div class="frame frame-back"><span>CREATE</span><i /></div>
            <div class="frame frame-main">
              <div class="frame-corner">R / M</div>
              <div class="frame-disc" />
              <span class="frame-caption">A NEW<br />PERSPECTIVE.</span
              ><span class="frame-time">00:00:12</span>
            </div>
            <div class="frame frame-front">
              <span>MAKE<br />IT REAL.</span>
              <div class="front-line" />
            </div>
          </div>
          <div class="art-timeline">
            <span>01</span>
            <div class="timeline-track"><i /><i /><i /><i /><i /><b /></div>
            <span>03</span>
          </div>
        </div>
        <div class="story-bottom">
          <span>效果类</span><i /><span>定制类</span><i /><span>裂变类</span>
        </div>
      </section>
      <section class="login-panel" aria-labelledby="login-title">
        <div class="form-topline"><span>工作台登录</span><LockKeyhole :size="15" /></div>
        <h2 id="login-title">欢迎回来</h2>
        <p class="form-description">登录账号，继续你的创作。</p>
        <div v-if="checking" class="login-status" role="status">
          <LoaderCircle class="spin" :size="22" />正在连接工作台…
        </div>
        <div v-else-if="startupError" class="login-status" role="alert">
          <p>{{ startupError }}</p>
          <button class="retry-button" type="button" @click="$emit('retry')">重新连接</button>
        </div>
        <form v-else @submit.prevent="submit">
          <label for="login-username">用户名</label>
          <input
            id="login-username"
            v-model="username"
            name="username"
            autocomplete="username"
            placeholder="请输入用户名"
            required
            maxlength="120"
            :disabled="busy"
            @input="error = ''"
          />
          <label for="login-password">密码</label>
          <div class="password-field">
            <input
              id="login-password"
              v-model="password"
              name="password"
              :type="visible ? 'text' : 'password'"
              autocomplete="current-password"
              placeholder="请输入密码"
              required
              maxlength="256"
              :disabled="busy"
              @input="error = ''"
            />
            <button
              type="button"
              :aria-label="visible ? '隐藏密码' : '显示密码'"
              :aria-pressed="visible"
              :disabled="busy"
              @click="visible = !visible"
            >
              <EyeOff v-if="visible" :size="18" /><Eye v-else :size="18" />
            </button>
          </div>
          <div class="form-feedback" aria-live="polite">
            <p v-if="error" role="alert">{{ error }}</p>
          </div>
          <button
            class="login-submit"
            type="submit"
            :disabled="busy || !username.trim() || !password"
          >
            <LoaderCircle v-if="busy" class="spin" :size="18" /><span>{{
              busy ? '正在登录…' : '登录工作台'
            }}</span
            ><ArrowRight v-if="!busy" :size="18" />
          </button>
          <p class="account-note">内部工作台 · 请使用已分配的账号</p>
        </form>
        <div class="form-footnote"><span /> 专注创作，有序协作</div>
      </section>
    </div>
    <footer class="login-footer">
      <span>瑞池传媒 RICH MEDIA</span><span>让内容创造价值</span>
    </footer>
  </main>
</template>

<style scoped>
.login-page {
  --blue: #2766ed;
  min-height: 100svh;
  padding: 36px 5.5vw 24px;
  color: #17233a;
  background: #f8fafc;
  display: flex;
  flex-direction: column;
}
.login-brand {
  display: flex;
  align-items: center;
  gap: 12px;
}
.login-brand img {
  width: 42px;
  height: 42px;
  border-radius: 10px;
  object-fit: cover;
  object-position: center top;
}
.login-brand div {
  display: grid;
  gap: 4px;
}
.login-brand strong {
  font-size: 16px;
  font-weight: 650;
}
.login-brand div > span {
  font-size: 8px;
  letter-spacing: 0.19em;
  color: #8b97a9;
  font-weight: 700;
}
.login-layout {
  width: min(1110px, 100%);
  flex: 1;
  align-self: center;
  display: grid;
  grid-template-columns: 1.25fr 1fr;
  gap: 100px;
  align-items: center;
  padding: 60px 0 48px;
}
.story-kicker {
  display: flex;
  align-items: center;
  gap: 9px;
  font-size: 10px;
  color: #697a94;
  letter-spacing: 0.18em;
  font-weight: 600;
  margin: 0 0 23px;
}
.story-kicker > span {
  width: 18px;
  height: 2px;
  background: var(--blue);
}
h1 {
  margin: 0;
  font-size: clamp(34px, 3.2vw, 48px);
  font-weight: 600;
  letter-spacing: -0.035em;
  line-height: 1.4;
}
h1 > span {
  color: var(--blue);
}
.story-copy {
  margin: 20px 0 28px;
  color: #7c8799;
  font-size: 14px;
  line-height: 1.9;
}
.studio-art {
  width: 100%;
  max-width: 480px;
  border: 1px solid #e1e6ee;
  background: #f0f3f8;
  border-radius: 14px;
  overflow: hidden;
}
.art-header {
  display: flex;
  justify-content: space-between;
  padding: 16px 20px;
  font-size: 8px;
  color: #8a96a8;
  letter-spacing: 0.12em;
}
.art-stage {
  position: relative;
  height: 220px;
  overflow: hidden;
}
.frame {
  position: absolute;
  border-radius: 5px;
  overflow: hidden;
}
.frame-back {
  width: 150px;
  height: 175px;
  top: 21px;
  left: 21px;
  background: #d5deeb;
  transform: rotate(-9deg);
  border: 5px solid #fff;
}
.frame-back > span {
  position: absolute;
  font-size: 12px;
  top: 16px;
  left: 12px;
  color: #6a7d99;
  letter-spacing: 0.07em;
}
.frame-back i {
  position: absolute;
  width: 95px;
  height: 95px;
  border: 18px solid #b4c5db;
  border-radius: 50%;
  top: 63px;
  left: 33px;
}
.frame-main {
  width: 220px;
  height: 205px;
  left: 28%;
  top: 3px;
  background: #243e66;
  color: #fff;
  box-shadow: 0 16px 28px #17233a18;
}
.frame-corner {
  position: absolute;
  top: 13px;
  left: 15px;
  font-size: 9px;
  letter-spacing: 0.2em;
  color: #c4cfde;
}
.frame-disc {
  position: absolute;
  width: 160px;
  height: 160px;
  border: 25px solid #607da9;
  border-radius: 50%;
  top: -49px;
  right: -42px;
}
.frame-caption {
  position: absolute;
  left: 20px;
  bottom: 32px;
  font-size: 24px;
  line-height: 1.13;
  letter-spacing: -0.04em;
  font-weight: 550;
}
.frame-time {
  position: absolute;
  left: 20px;
  bottom: 14px;
  font-size: 8px;
  letter-spacing: 0.14em;
  color: #aebed6;
}
.frame-front {
  width: 112px;
  height: 151px;
  background: #e7b26e;
  right: 16px;
  bottom: 14px;
  transform: rotate(9deg);
  border: 5px solid #fff;
  box-shadow: 0 8px 20px #17233a15;
}
.frame-front > span {
  position: absolute;
  top: 15px;
  left: 10px;
  color: #543e29;
  font-size: 22px;
  line-height: 1.1;
  letter-spacing: -0.04em;
  font-weight: 650;
}
.front-line {
  position: absolute;
  left: 10px;
  right: 10px;
  bottom: 20px;
  height: 1px;
  background: #543e2970;
}
.art-timeline {
  display: flex;
  gap: 12px;
  align-items: center;
  padding: 18px 20px 21px;
  color: #94a0b1;
  font-size: 8px;
}
.timeline-track {
  position: relative;
  display: flex;
  gap: 4px;
  flex: 1;
  height: 17px;
}
.timeline-track i {
  flex: 1;
  background: #d1dcec;
  border-radius: 2px;
}
.timeline-track i:nth-child(2) {
  flex: 1.6;
  background: #7892b8;
}
.timeline-track i:nth-child(3) {
  background: #e8c79d;
}
.timeline-track b {
  position: absolute;
  left: 39%;
  top: -4px;
  bottom: -4px;
  width: 1px;
  background: #2766ed;
}
.story-bottom {
  display: flex;
  align-items: center;
  gap: 17px;
  margin-top: 24px;
  font-size: 11px;
  color: #8090a5;
  letter-spacing: 0.05em;
}
.story-bottom i {
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: #c7d0de;
}
.login-panel {
  padding: 42px 38px 28px;
  border: 1px solid #e2e8f0;
  border-radius: 18px;
  background: #fff;
  box-shadow: 0 16px 50px #233e6407;
}
.form-topline {
  display: flex;
  justify-content: space-between;
  color: #94a0b1;
  font-size: 11px;
  letter-spacing: 0.06em;
  margin-bottom: 32px;
}
h2 {
  margin: 0;
  font-size: 27px;
  font-weight: 600;
  letter-spacing: -0.04em;
}
.form-description {
  color: #8a96a8;
  font-size: 13px;
  margin: 12px 0 33px;
}
form label {
  display: block;
  font-size: 12px;
  color: #44536a;
  margin: 0 0 10px;
  font-weight: 550;
}
form input {
  display: block;
  width: 100%;
  height: 48px;
  padding: 0 14px;
  border: 1px solid #dfe5ee;
  border-radius: 8px;
  background: #fff;
  color: #17233a;
  font-size: 13px;
  outline: none;
  transition:
    border-color 0.15s,
    box-shadow 0.15s;
}
form input::placeholder {
  color: #adb6c4;
}
form input:focus {
  border-color: #6893ee;
  box-shadow: 0 0 0 3px #2766ed0d;
}
form > input {
  margin-bottom: 23px;
}
.password-field {
  position: relative;
}
.password-field input {
  padding-right: 46px;
}
.password-field button {
  position: absolute;
  right: 4px;
  top: 4px;
  width: 40px;
  height: 40px;
  border: 0;
  background: transparent;
  color: #95a0af;
  display: grid;
  place-items: center;
  border-radius: 5px;
}
.password-field button:hover {
  color: #2766ed;
  background: #f4f7fc;
}
.form-feedback {
  min-height: 39px;
  padding: 10px 0;
}
.form-feedback p {
  margin: 0;
  color: #bd3c3c;
  font-size: 12px;
  line-height: 1.6;
}
.login-submit {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 48px;
  gap: 10px;
  border: 0;
  border-radius: 8px;
  color: #fff;
  background: var(--blue);
  font-size: 13px;
  font-weight: 550;
  transition: background 0.15s;
}
.login-submit:hover {
  background: #2059d4;
}
.login-submit:disabled {
  background: #91ace2;
  cursor: default;
}
.account-note {
  text-align: center;
  font-size: 11px;
  color: #9aa5b4;
  margin: 19px 0 0;
}
.form-footnote {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  border-top: 1px solid #f0f2f6;
  margin-top: 34px;
  padding-top: 23px;
  color: #a5adba;
  font-size: 10px;
}
.form-footnote > span {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: #9aabc4;
}
.login-status {
  min-height: 250px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  gap: 15px;
  color: #8090a5;
  font-size: 13px;
}
.retry-button {
  padding: 10px 20px;
  border: 1px solid #dfe5ee;
  border-radius: 7px;
  background: white;
  color: #2766ed;
}
.login-footer {
  display: flex;
  justify-content: space-between;
  font-size: 10px;
  color: #a0aabb;
  letter-spacing: 0.05em;
}
button:focus-visible {
  outline: 2px solid #2766ed;
  outline-offset: 3px;
}
.spin {
  animation: spin 1s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
@media (min-width: 1700px) {
  .login-layout {
    gap: 130px;
    width: 1180px;
  }
  .art-stage {
    height: 240px;
  }
  .frame-main {
    top: 13px;
  }
  .frame-back {
    top: 31px;
  }
  .frame-front {
    bottom: 24px;
  }
}
@media (max-width: 1000px) {
  .login-layout {
    gap: 45px;
    grid-template-columns: 1fr 1fr;
  }
  .login-panel {
    padding: 32px 25px 25px;
  }
  .frame-main {
    left: 20%;
    width: 190px;
  }
  .frame-front {
    right: 8px;
    width: 95px;
  }
  .frame-front > span {
    font-size: 19px;
  }
}
@media (max-width: 720px) {
  .login-page {
    padding: 25px 22px 20px;
  }
  .login-brand strong {
    font-size: 13px;
  }
  .login-brand img {
    width: 35px;
    height: 35px;
  }
  .login-layout {
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 30px;
    padding: 44px 0;
  }
  .login-story {
    width: min(380px, 100%);
  }
  .story-kicker {
    font-size: 8px;
    margin-bottom: 12px;
  }
  h1 {
    font-size: 30px;
    line-height: 1.35;
  }
  h1 br {
    display: none;
  }
  .story-copy,
  .studio-art,
  .story-bottom {
    display: none;
  }
  .login-panel {
    width: min(380px, 100%);
    padding: 28px 25px 24px;
  }
  .form-topline {
    margin-bottom: 24px;
  }
  h2 {
    font-size: 24px;
  }
  .form-description {
    margin-bottom: 28px;
  }
  .login-footer {
    font-size: 8px;
  }
}
@media (prefers-reduced-motion: reduce) {
  .spin {
    animation: none;
  }
  form input,
  .login-submit {
    transition: none;
  }
}
</style>
