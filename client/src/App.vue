<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoomStore } from './stores/room';
import { useChatStore } from './stores/chat';
import { Galaxy } from './galaxy/scene';
import JoinGate from './components/JoinGate.vue';
import ChatPanel from './components/ChatPanel.vue';
import DeviceDrawer from './components/DeviceDrawer.vue';
import ConnectDialog from './components/ConnectDialog.vue';
import CosmicBg from './components/CosmicBg.vue';
import ImageLightbox from './components/ImageLightbox.vue';
import ShareDialog from './components/ShareDialog.vue';
import { notifyEnabled, toggleNotify, restoreNotify } from './utils/notify';

const room = useRoomStore();
const chat = useChatStore();
const canvasEl = ref<HTMLCanvasElement | null>(null);
let galaxy: Galaxy | null = null;

const shareOpen = ref(false);
const bellOn = ref(false);

const links = computed<[string, string][]>(() =>
  chat.sessions.filter((s) => s.status === 'open').map((s) => [room.selfId, s.peerId]),
);

function mountGalaxy(): void {
  if (galaxy || !canvasEl.value) return;
  galaxy = new Galaxy(canvasEl.value, {
    getDevices: () => room.devices,
    getSelfId: () => room.selfId,
    getLinks: () => links.value,
    onSelect: (id) => {
      room.selectedId = id || '';
    },
  });
}

// Canvas 只在进入星系后渲染，必须在 joined 变化后挂载（修复：星球不显示）
watch(
  () => room.joined,
  async (v) => {
    if (v) {
      await nextTick();
      mountGalaxy();
    } else {
      galaxy?.destroy();
      galaxy = null;
    }
  },
);

onMounted(() => {
  restoreNotify();
  bellOn.value = notifyEnabled();
  if (room.joined) mountGalaxy();
});

async function onBell(): Promise<void> {
  bellOn.value = await toggleNotify();
}

onUnmounted(() => galaxy?.destroy());
</script>

<template>
  <div class="app">
    <JoinGate v-if="!room.joined" />

    <template v-else>
      <CosmicBg />
      <canvas ref="canvasEl" class="galaxy" />
      <header class="topbar">
        <span class="logo">✦ <span class="logo-txt">星网 StarNet</span></span>
        <span class="info">
          <span class="count full">在线 {{ room.onlineDevices.length }} / {{ room.devices.length }} 颗星 · </span>
          <span class="count compact">在线 {{ room.onlineDevices.length }}/{{ room.devices.length }} · </span>坐标
          <b>{{ room.key }}</b>
        </span>
        <span class="me">{{ room.name }}</span>
        <button class="share-btn bell" :class="{ on: bellOn }" :data-tip="bellOn ? '关闭后台消息通知' : '开启后台消息通知'" data-tip-pos="bottom" @click="onBell">
          {{ bellOn ? '🔔' : '🔕' }}
        </button>
        <button class="share-btn" data-tip="分享星系链接 / 二维码" data-tip-pos="bottom" @click="shareOpen = true">分享</button>
      </header>
      <div v-if="!room.connected" class="offline">与服务器断开，正在重连…</div>

      <ChatPanel />
      <DeviceDrawer />
      <ConnectDialog />
      <ShareDialog :open="shareOpen" @close="shareOpen = false" />

      <div class="toasts">
        <div v-for="t in room.toasts" :key="t.id" class="toast">{{ t.text }}</div>
      </div>

      <ImageLightbox />
    </template>
  </div>
</template>
