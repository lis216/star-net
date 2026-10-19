<script setup lang="ts">
import { useRoomStore } from '../stores/room';
import { useChatStore } from '../stores/chat';
import { socket } from '../api/socket';

const room = useRoomStore();
const chat = useChatStore();

function respond(accept: boolean): void {
  const req = room.requests.shift();
  if (!req) return;
  if (accept) chat.openSession(req.fromId); // 接受方也要打开自己的会话窗口
  socket.send({ type: 'connect-response', to: req.fromId, accept });
}
</script>

<template>
  <div v-if="room.requests.length" class="modal-mask">
    <div class="modal">
      <h3>连接请求</h3>
      <p>「{{ room.requests[0].name }}」想与你建立点对点连接，建立后可单独发消息和文件。</p>
      <div class="actions">
        <button class="ghost" @click="respond(false)">拒绝</button>
        <button class="primary" @click="respond(true)">接受</button>
      </div>
    </div>
  </div>
</template>
