<script setup lang="ts">
import { useRoomStore } from '../stores/room';
import { socket } from '../api/socket';
import { useChatStore } from '../stores/chat';
import { copyText } from '../utils/clipboard';

const room = useRoomStore();
const chat = useChatStore();

function requestConnect(): void {
  if (!room.selectedId) return;
  socket.send({ type: 'connect-request', to: room.selectedId });
  room.toast(`已向 ${room.deviceName(room.selectedId)} 发送连接请求`);
  room.selectedId = '';
}

function openP2p(): void {
  if (!room.selectedId) return;
  chat.openSession(room.selectedId);
  room.selectedId = '';
}

function saveName(e: Event): void {
  const v = (e.target as HTMLInputElement).value.trim();
  if (v && v !== room.name) socket.send({ type: 'rename', name: v });
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

async function copyId(): Promise<void> {
  if (!room.selected) return;
  const ok = await copyText(room.selected.id);
  room.toast(ok ? '设备编号已复制' : '复制失败');
}
</script>

<template>
  <aside v-if="room.selected" class="drawer">
    <button class="close" @click="room.selectedId = ''">×</button>
    <div class="head">
      <div class="avatar" :class="{ off: !room.selected.online }">{{ room.selected.name.slice(0, 1) }}</div>
      <div class="headinfo">
        <h2>{{ room.selected.name }}<span v-if="room.selected.id === room.selfId" class="me">（我）</span></h2>
        <p class="status" :class="{ off: !room.selected.online }">
          {{ room.selected.online ? '● 在线' : '○ 离线' }}
        </p>
      </div>
    </div>
    <dl>
      <div class="row">
        <dt>加入时间</dt>
        <dd>{{ fmtTime(room.selected.joinAt) }}</dd>
      </div>
      <div class="row">
        <dt>设备编号</dt>
        <dd class="mono copy" data-tip="点击复制完整编号" @click="copyId">{{ room.selected.id.slice(0, 8) }} ⧉</dd>
      </div>
    </dl>

    <div v-if="room.selected.id === room.selfId" class="field">
      <span>修改名称</span>
      <input :value="room.name" maxlength="24" @change="saveName" />
    </div>

    <template v-else-if="room.selected.online">
      <button class="primary" @click="requestConnect">发起连接请求</button>
      <p class="hint">对方同意后将建立点对点直连，可单独发消息和文件</p>
    </template>
  </aside>
</template>
