<script setup lang="ts">
import { ref, watch } from 'vue';
import { useRoomStore } from '../stores/room';
import { joinRoom } from '../logic/wire';
import CosmicBg from './CosmicBg.vue';

const room = useRoomStore();
const key = ref(localStorage.getItem('starnet.key') || '');
const name = ref(localStorage.getItem('starnet.name') || '');
const busy = ref(false);
const fromShare = ref(false);

// 分享链接进入：?key=坐标 自动带入（优先生效，并提示来自邀请）
try {
  const param = new URLSearchParams(location.search).get('key');
  if (param && /^[a-zA-Z0-9]{3,5}$/.test(param)) {
    key.value = param.toUpperCase();
    fromShare.value = true;
  }
} catch {
  /* 无关紧要 */
}

function genKey(): void {
  // 去掉易混淆的 I/L/O/0/1
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const len = 3 + Math.floor(Math.random() * 3); // 3~5 位
  let s = '';
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  key.value = s;
}

async function submit(): Promise<void> {
  if (busy.value) return;
  if (!key.value.trim() || !name.value.trim()) return;
  if (!/^[a-zA-Z0-9]{3,5}$/.test(key.value.trim())) {
    room.joinError = '星系坐标需为 3~5 位字母或数字';
    return;
  }
  busy.value = true;
  joinRoom(key.value, name.value);
  setTimeout(() => {
    busy.value = false;
    if (!room.joined && !room.joinError) room.joinError = '连接服务器失败，请重试';
  }, 5000);
}

watch(
  () => room.joined,
  (v) => {
    if (v) busy.value = false;
  },
);

// 断线自动重连后重新入房
watch(
  () => room.connected,
  (c, old) => {
    if (old && !c && room.joined) {
      room.joined = false;
    }
  },
);
</script>

<template>
  <div class="gate">
    <CosmicBg />
    <div class="stars">
      <div v-for="i in 40" :key="i" class="dot" :style="{
        left: (i * 37 % 100) + '%',
        top: (i * 53 % 100) + '%',
        opacity: 0.2 + (i % 5) * 0.15,
        transform: `scale(${0.6 + (i % 3) * 0.4})`,
      }" />
    </div>
    <div class="card">
      <h1>星网 <span class="en">StarNet</span></h1>
      <p class="sub">输入星系坐标与你的星球名称，点亮属于你的那颗星</p>
      <p v-if="fromShare" class="invite">✦ 已通过邀请链接带入星系坐标，填个名字就能进入</p>
      <label>
        <span>星系坐标</span>
        <div class="row">
          <input v-model="key" placeholder="3~5 位字母+数字，如 A7XK" maxlength="5" @keyup.enter="submit" />
          <button class="ghost" type="button" @click="genKey">生成新坐标</button>
        </div>
      </label>
      <label>
        <span>星球名称</span>
        <input v-model="name" maxlength="24" placeholder="例如：书房台式机" @keyup.enter="submit" />
      </label>
      <button class="primary" :disabled="busy || !key.trim() || !name.trim()" @click="submit">
        {{ busy ? '进入星系中…' : '进入星系' }}
      </button>
      <p v-if="room.joinError" class="err">{{ room.joinError }}</p>
    </div>
  </div>
</template>
