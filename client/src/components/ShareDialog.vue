<script setup lang="ts">
import { computed, ref } from 'vue';
import QRCode from 'qrcode';
import { useRoomStore } from '../stores/room';
import { copyText } from '../utils/clipboard';

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ (e: 'close'): void }>();

const room = useRoomStore();
const qrData = ref('');
const copied = ref(false);

const shareLink = computed(() => {
  const origin = location.origin;
  return `${origin}/?key=${encodeURIComponent(room.key)}`;
});

const qrReady = computed(() => !!qrData.value);

async function ensureQr(): Promise<void> {
  if (qrData.value || !props.open) return;
  try {
    qrData.value = await QRCode.toDataURL(shareLink.value, {
      width: 440,
      margin: 2,
      errorCorrectionLevel: 'M',
      color: { dark: '#101624', light: '#ffffff' },
    });
  } catch {
    qrData.value = '';
  }
}

function onEnter(): void {
  qrData.value = '';
  void ensureQr();
}

async function copy(): Promise<void> {
  const ok = await copyText(shareLink.value);
  copied.value = ok;
  if (ok) {
    room.toast('邀请链接已复制');
    setTimeout(() => (copied.value = false), 2000);
  } else {
    room.toast('复制失败，请手动长按/选中链接复制');
  }
}
</script>

<template>
  <Teleport to="body">
    <Transition name="share-fade">
      <div v-if="open" class="share-mask" @click="emit('close')">
        <div class="share-card" @click.stop @vnode-mounted="onEnter">
          <h3>分享星系</h3>
          <p class="share-sub">把链接或二维码发给朋友，扫码即可进入「{{ room.key }}」星系</p>

          <div class="qr-box">
            <img v-if="qrReady" :src="qrData" alt="星系邀请二维码" />
            <div v-else class="qr-loading">生成中…</div>
          </div>
          <p class="qr-tip">扫码进入星系</p>

          <div class="link-row">
            <input readonly :value="shareLink" @focus="($event.target as HTMLInputElement).select()" />
            <button class="copy" :class="{ ok: copied }" @click="copy">{{ copied ? '已复制' : '复制' }}</button>
          </div>

          <p class="share-note">对方进入后需填写自己的星球名称；星系坐标已在链接中。</p>

          <button class="close" @click="emit('close')">关闭</button>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.share-mask {
  position: fixed;
  inset: 0;
  z-index: 9000;
  background: rgba(3, 5, 12, 0.7);
  backdrop-filter: blur(6px);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
}
.share-card {
  width: min(360px, 94vw);
  max-height: 90vh;
  overflow: auto;
  background: linear-gradient(160deg, rgba(24, 30, 52, 0.96), rgba(13, 17, 32, 0.96));
  border: 1px solid rgba(150, 170, 220, 0.22);
  border-radius: 16px;
  padding: 22px 22px 18px;
  text-align: center;
  box-shadow: 0 24px 70px rgba(0, 0, 0, 0.55);
  animation: share-pop 0.18s ease;
}
@keyframes share-pop {
  from { transform: scale(0.94) translateY(8px); opacity: 0; }
  to { transform: scale(1) translateY(0); opacity: 1; }
}
h3 {
  margin: 0 0 6px;
  font-size: 17px;
  color: #eef2fb;
}
.share-sub {
  margin: 0 0 14px;
  font-size: 12.5px;
  color: #9aa6c0;
}
.qr-box {
  width: 200px;
  height: 200px;
  margin: 0 auto;
  border-radius: 12px;
  background: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}
.qr-box img {
  width: 100%;
  height: 100%;
  display: block;
}
.qr-loading {
  color: #667;
  font-size: 13px;
}
.qr-tip {
  margin: 8px 0 14px;
  font-size: 12px;
  color: #8d99b5;
}
.link-row {
  display: flex;
  gap: 8px;
}
.link-row input {
  flex: 1;
  min-width: 0;
  background: rgba(255, 255, 255, 0.07);
  border: 1px solid rgba(150, 170, 220, 0.25);
  border-radius: 9px;
  color: #dfe6f4;
  font-size: 12px;
  padding: 9px 10px;
  outline: none;
}
.link-row .copy {
  flex: none;
  border: none;
  border-radius: 9px;
  padding: 0 16px;
  font-size: 13px;
  cursor: pointer;
  color: #0d1220;
  background: linear-gradient(135deg, #9db4ff, #c3a8ff);
  transition: filter 0.15s;
}
.link-row .copy:hover {
  filter: brightness(1.1);
}
.link-row .copy.ok {
  background: linear-gradient(135deg, #79e6b0, #9de8c9);
}
.share-note {
  margin: 12px 0 0;
  font-size: 11.5px;
  color: #7e8aa6;
  line-height: 1.5;
}
.close {
  margin-top: 14px;
  width: 100%;
  border: 1px solid rgba(150, 170, 220, 0.25);
  background: rgba(255, 255, 255, 0.06);
  color: #c4cee2;
  border-radius: 9px;
  padding: 9px;
  font-size: 13px;
  cursor: pointer;
}
.close:hover {
  background: rgba(255, 255, 255, 0.12);
}
.share-fade-enter-active,
.share-fade-leave-active {
  transition: opacity 0.16s ease;
}
.share-fade-enter-from,
.share-fade-leave-to {
  opacity: 0;
}
</style>
