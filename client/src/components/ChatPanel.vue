<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoomStore } from '../stores/room';
import { useChatStore } from '../stores/chat';
import MessageCard from './MessageCard.vue';
import type { P2pSession } from '../types';

const room = useRoomStore();
const chat = useChatStore();

const collapsed = ref(false);
const draft = ref('');
const inputEl = ref<HTMLTextAreaElement | null>(null);
const fileInput = ref<HTMLInputElement | null>(null);
const listEl = ref<HTMLElement | null>(null);
const dragging = ref(false);
const confirmClose = ref<{ peerId: string; name: string } | null>(null);

function askClose(s: P2pSession): void {
  // 已结束的会话没有连接可断，直接关标签
  if (s.ended) {
    chat.closeTab(s.peerId);
    return;
  }
  confirmClose.value = { peerId: s.peerId, name: s.peerName };
}

function doClose(): void {
  if (!confirmClose.value) return;
  chat.disconnect(confirmClose.value.peerId);
  confirmClose.value = null;
}

const activeList = computed<any[]>(() => {
  if (chat.activeTab === 'bcast') return chat.bcast;
  return chat.msgsByPeer[chat.activeTab] || [];
});

const activePeer = computed(() => chat.sessions.find((s) => s.peerId === chat.activeTab));
const isEnded = computed(() => chat.activeTab !== 'bcast' && !!activePeer.value?.ended);

function scrollBottom(): void {
  if (listEl.value) listEl.value.scrollTop = listEl.value.scrollHeight;
}

// 新消息或最后一条消息状态变化（图片接收完成、blobUrl 就绪）时滚到底
watch(
  () => {
    const l = activeList.value;
    const last = l[l.length - 1];
    return [l.length, last?.transfer, last?.blobUrl];
  },
  async () => {
    await nextTick();
    requestAnimationFrame(scrollBottom);
  },
);

function send(): void {
  if (isEnded.value) {
    room.toast('对方已离开，无法继续发送');
    return;
  }
  const t = draft.value.trim();
  if (!t) return;
  if (chat.activeTab === 'bcast') chat.sendBcastText(t);
  else chat.sendP2pText(chat.activeTab, t);
  draft.value = '';
  nextTick(autoGrow);
}

/** 回车发送；Shift+回车换行；中文输入法选词回车不触发发送 */
function onEnterKey(e: KeyboardEvent): void {
  if (e.isComposing || e.keyCode === 229) return;
  e.preventDefault();
  send();
}

/** 输入框高度自适应，单行封顶（超出部分框内滚动） */
function autoGrow(): void {
  const el = inputEl.value;
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 39) + 'px';
}

function pickFile(): void {
  fileInput.value?.click();
}

function onFiles(e: Event): void {
  const input = e.target as HTMLInputElement;
  handleFiles(input.files);
  input.value = '';
}

function onDrop(e: DragEvent): void {
  dragging.value = false;
  handleFiles(e.dataTransfer?.files);
}

function handleFiles(files: FileList | File[] | null | undefined): void {
  if (!files || !files.length) return;
  if (isEnded.value) {
    room.toast('对方已离开，无法发送文件');
    return;
  }
  const list = Array.from(files);
  if (list.length > 1) room.toast(`正在依次发送 ${list.length} 个文件`);
  const scope = chat.activeTab === 'bcast' ? 'bcast' : 'p2p';
  const peerId = scope === 'bcast' ? '' : chat.activeTab;
  // 顺序发送，避免多个大文件并发挤占背压队列
  void (async () => {
    for (const f of list) {
      if (scope === 'p2p' && (activePeer.value?.ended || !room.devices.some((d) => d.id === peerId))) {
        room.toast('对方已离开，剩余文件取消发送');
        return;
      }
      await chat.sendFile(scope as 'bcast' | 'p2p', peerId, f);
    }
  })();
}

// 剪贴板粘贴图片/文件直接发送
function onPaste(e: ClipboardEvent): void {
  const items = e.clipboardData?.files;
  if (!items || !items.length) return; // 纯文本走默认粘贴
  const imgs = Array.from(items).filter((f) => f.kind === 'file');
  if (!imgs.length) return;
  e.preventDefault();
  const scope = chat.activeTab === 'bcast' ? 'bcast' : 'p2p';
  const peerId = scope === 'bcast' ? '' : chat.activeTab;
  const list = imgs.length > 1 ? imgs : [imgs[0]];
  void (async () => {
    for (const f of list) {
      const name = f.name && f.name !== 'image.png' ? f : new File([f], `截图_${Date.now()}.png`, { type: f.type || 'image/png' });
      await chat.sendFile(scope as 'bcast' | 'p2p', peerId, name);
    }
  })();
}

// 图片解码完成晚于布局，捕获阶段监听 load 事件兜底滚动（img load 不冒泡）
onMounted(() => listEl.value?.addEventListener('load', scrollBottom, true));
onUnmounted(() => listEl.value?.removeEventListener('load', scrollBottom, true));
</script>

<template>
  <div class="chat" :class="{ collapsed }">
    <div class="tabs">
      <template v-if="!collapsed">
        <button class="tab" :class="{ active: chat.activeTab === 'bcast' }" @click="chat.activeTab = 'bcast'">
          星系频道
        </button>
        <button
          v-for="s in chat.sessions"
          :key="s.peerId"
          class="tab"
          :class="{ active: chat.activeTab === s.peerId }"
          @click="chat.activeTab = s.peerId"
        >
          <span class="tname" :class="'s-' + s.status">{{ s.peerName }}</span>
          <span class="xtab" title="断开并关闭会话" @click.stop="askClose(s)">×</span>
        </button>
      </template>
      <button class="fold" @click="collapsed = !collapsed">{{ collapsed ? '💬 聊天 ▲' : '▼ 收起' }}</button>
    </div>

    <div
      v-show="!collapsed"
      class="body"
      @dragover.prevent="dragging = true"
      @dragleave="dragging = false"
      @drop.prevent="onDrop"
    >
      <div v-if="chat.activeTab !== 'bcast'" class="mode-bar">
        <span v-if="activePeer?.ended" class="mode-chip ended">对方已离开，会话已结束</span>
        <span v-else-if="activePeer?.status === 'open'" class="mode-chip direct">⚡ WebRTC 直连</span>
        <span v-else-if="activePeer?.status === 'connecting'" class="mode-chip linking">◐ 正在建立直连 · 暂经服务器中转</span>
        <span v-else class="mode-chip relay">☁ 服务器中转</span>
        <button
          v-if="!activePeer?.ended"
          class="auto-btn"
          :class="{ active: chat.autoAccept }"
          data-tip="开启后私聊文件免确认直接接收"
          @click="chat.toggleAutoAccept()"
        >
          自动接收 {{ chat.autoAccept ? '开' : '关' }}
        </button>
      </div>
      <div ref="listEl" class="list">
        <div v-if="dragging" class="dropmask">松开发送文件</div>
        <MessageCard v-for="(m, i) in activeList" :key="i" :msg="m" />
        <div v-if="!activeList.length" class="empty">
          {{ chat.activeTab === 'bcast' ? '向整个星系发送第一条消息吧' : '点对点会话已就绪，发条消息试试' }}
        </div>
      </div>

      <div class="composer">
        <button
          v-if="chat.activeTab !== 'bcast' && !isEnded"
          class="disconnect"
          data-tip="断开与该设备的点对点连接"
          @click="chat.disconnect(chat.activeTab)"
        >
          断开
        </button>
        <button class="attach" :disabled="isEnded" data-tip="发送文件 / 照片（可多选）" @click="pickFile">📎</button>
        <textarea
          ref="inputEl"
          v-model="draft"
          rows="1"
          :placeholder="chat.activeTab === 'bcast' ? '发送到星系频道…' : isEnded ? '对方已离开…' : `发送给 ${activePeer?.peerName || ''}…`"
          @keydown.enter.exact="onEnterKey"
          @paste="onPaste"
          @input="autoGrow"
        ></textarea>
        <button class="send" :disabled="!draft.trim() || isEnded" @click="send">发送</button>
        <input ref="fileInput" type="file" multiple hidden @change="onFiles" />
      </div>
    </div>

    <div v-if="confirmClose" class="confirm-mask" @click.self="confirmClose = null">
      <div class="confirm-box">
        <p>是否断开与 <b>{{ confirmClose.name }}</b> 的连接？</p>
        <div class="confirm-btns">
          <button @click="confirmClose = null">取消</button>
          <button class="danger" @click="doClose">断开</button>
        </div>
      </div>
    </div>
  </div>
</template>
