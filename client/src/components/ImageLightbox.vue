<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue';
import { lightboxUrl, lightboxName, closeLightbox } from '../ui/lightbox';
import { saveBlobFile } from '../utils/saveFile';

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') closeLightbox();
}
onMounted(() => window.addEventListener('keydown', onKey));
onUnmounted(() => window.removeEventListener('keydown', onKey));

async function saveImage(): Promise<void> {
  if (!lightboxUrl.value) return;
  const name = lightboxName.value || 'image.png';
  // 灯箱里的 blob URL 已带 MIME；无类型时兜底按 png 处理
  const res = await fetch(lightboxUrl.value);
  const raw = await res.blob();
  const mime = raw.type || 'image/png';
  await saveBlobFile(lightboxUrl.value, name, mime);
}
</script>

<template>
  <Teleport to="body">
    <Transition name="lb">
      <div v-if="lightboxUrl" class="lightbox" @click="closeLightbox()">
        <img :src="lightboxUrl" :alt="lightboxName" @click.stop="closeLightbox()" />
        <div class="lb-meta" @click.stop>
          <span class="lb-name">{{ lightboxName }}</span>
          <a href="#" :download="lightboxName || 'image'" class="lb-dl" @click.prevent="saveImage">下载原图</a>
          <button class="lb-close" @click="closeLightbox()">关闭 (Esc)</button>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.lightbox {
  position: fixed;
  inset: 0;
  z-index: 9999;
  background: rgba(4, 6, 14, 0.88);
  backdrop-filter: blur(10px);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  cursor: zoom-out;
  animation: lb-fade 0.18s ease;
}
.lightbox img {
  max-width: 92vw;
  max-height: 84vh;
  object-fit: contain;
  border-radius: 10px;
  box-shadow: 0 18px 70px rgba(0, 0, 0, 0.6);
  animation: lb-zoom 0.2s ease;
}
.lb-meta {
  display: flex;
  align-items: center;
  gap: 14px;
  max-width: 92vw;
  color: #cfd6e4;
  font-size: 13px;
  cursor: default;
}
.lb-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 46vw;
}
.lb-dl,
.lb-close {
  flex: none;
  border: 1px solid rgba(255, 255, 255, 0.25);
  background: rgba(255, 255, 255, 0.08);
  color: #e8ecf5;
  border-radius: 8px;
  padding: 5px 12px;
  font-size: 12px;
  cursor: pointer;
  text-decoration: none;
  transition: background 0.15s;
}
.lb-dl:hover,
.lb-close:hover {
  background: rgba(255, 255, 255, 0.18);
}
.lb-close {
  color: #aeb7c9;
}
@keyframes lb-fade {
  from { opacity: 0; }
  to { opacity: 1; }
}
@keyframes lb-zoom {
  from { transform: scale(0.92); opacity: 0.4; }
  to { transform: scale(1); opacity: 1; }
}
.lb-enter-active,
.lb-leave-active {
  transition: opacity 0.16s ease;
}
.lb-enter-from,
.lb-leave-to {
  opacity: 0;
}
</style>
