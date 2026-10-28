<script setup lang="ts">
import { computed } from 'vue';
import type { ChatMsg } from '../types';
import { openLightbox } from '../ui/lightbox';
import { copyText } from '../utils/clipboard';
import { saveBlobFile } from '../utils/saveFile';
import { useRoomStore } from '../stores/room';
import { useChatStore } from '../stores/chat';

const props = defineProps<{ msg: ChatMsg }>();
const room = useRoomStore();
const chat = useChatStore();

const isImage = computed(() => !!props.msg.mime?.startsWith('image/'));
const isVideo = computed(() => !!props.msg.mime?.startsWith('video/'));
const isAudio = computed(() => !!props.msg.mime?.startsWith('audio/'));

const TRANSFER_NOTE: Record<string, string> = {
  rejected: '对方拒收了该文件',
  timeout: '对方未响应，传输已取消',
  canceled: '文件传输已取消',
};

const inFlight = computed(() =>
  props.msg.transfer === 'sending' || props.msg.transfer === 'receiving',
);

async function copyMsg(): Promise<void> {
  const ok = await copyText(props.msg.text || '');
  room.toast(ok ? '已复制到剪贴板' : '复制失败');
}

/** 手机端 blob 下载不可靠（iOS 会存成 .txt），统一走分享面板/兜底下载 */
async function saveMsg(): Promise<void> {
  if (!props.msg.blobUrl) return;
  const ok = await saveBlobFile(props.msg.blobUrl, props.msg.fileName || 'file', props.msg.mime);
  if (!ok) room.toast('保存失败，请重试');
}

function fmtSize(n?: number): string {
  if (!n && n !== 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function fmtSpeed(n?: number): string {
  if (!n || n <= 0) return '';
  return fmtSize(n) + '/s';
}

function fmtEta(n?: number): string {
  if (n === undefined || n < 0) return '';
  if (n < 60) return `剩余 ${Math.ceil(n)}s`;
  const m = Math.floor(n / 60);
  if (m < 60) return `剩余 ${m}分${Math.ceil(n % 60)}s`;
  return `剩余 ${Math.floor(m / 60)}时${m % 60}分`;
}

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' });
}
</script>

<template>
  <div class="msg" :class="{ self: msg.self }">
    <div class="meta">{{ msg.self ? '我' : msg.from.name }} · {{ fmtTime(msg.ts) }}</div>

    <div v-if="msg.kind === 'text'" class="bubble copyable" @click="copyMsg">{{ msg.text }}<i class="copy-chip" aria-hidden="true"><span class="ci">⧉</span> 复制</i></div>

    <div v-else class="file">
      <template v-if="msg.blobUrl">
        <img v-if="isImage" :src="msg.blobUrl" :alt="msg.fileName" class="preview zoomable" @click="openLightbox(msg.blobUrl!, msg.fileName || '')" />
        <video v-else-if="isVideo" :src="msg.blobUrl" controls class="preview" />
        <audio v-else-if="isAudio" :src="msg.blobUrl" controls />
        <a v-else :href="msg.blobUrl" :download="msg.fileName" class="filebox" @click.prevent="saveMsg">
          <span class="icon">📄</span>
          <span class="fmeta">
            <span class="fname">{{ msg.fileName }}</span>
            <span class="fsize">{{ fmtSize(msg.size) }} · 点击下载</span>
          </span>
        </a>
        <a v-if="isImage || isVideo" :href="msg.blobUrl" :download="msg.fileName" class="dl" @click.prevent="saveMsg">
          {{ msg.fileName }} · {{ fmtSize(msg.size) }} · 下载
        </a>
      </template>

      <template v-else>
        <div class="filebox" :class="{ pending: msg.transfer !== 'done' }">
          <span class="icon">📄</span>
          <span class="fmeta">
            <span class="fname">{{ msg.fileName }}</span>
            <span class="fsize">{{ fmtSize(msg.size) }}</span>
          </span>
        </div>
      </template>

      <!-- 等待对方确认 -->
      <div v-if="msg.self && msg.transfer === 'awaiting'" class="xfer-note">等待对方接收…</div>

      <!-- 传输中：进度 + 速度/剩余时间 + 取消 -->
      <template v-if="inFlight">
        <div class="progress">
          <div class="bar" :style="{ width: Math.round((msg.progress || 0) * 100) + '%' }" />
          <span class="ptext">
            {{ msg.self ? '发送中' : '接收中' }} {{ Math.round((msg.progress || 0) * 100) }}%
          </span>
        </div>
        <div class="xfer-sub">
          <span class="xfer-speed">
            {{ [fmtSpeed(msg.speed), fmtEta(msg.eta)].filter(Boolean).join(' · ') }}
          </span>
          <button v-if="msg.self && msg.transfer === 'sending'" class="abort" @click="chat.abortSend(msg.fileId!)">取消</button>
        </div>
      </template>

      <!-- 接收方确认 -->
      <template v-else-if="msg.transfer === 'confirming'">
        <div class="xfer-note">对方发来文件，是否接收？</div>
        <div class="confirm-btns inline">
          <button @click="chat.rejectFile(msg.fileId!)">拒收</button>
          <button class="danger" @click="chat.acceptFile(msg.fileId!)">接收</button>
        </div>
      </template>

      <!-- 终态提示 -->
      <div v-else-if="msg.transfer && TRANSFER_NOTE[msg.transfer]" class="xfer-note muted">
        {{ TRANSFER_NOTE[msg.transfer] }}
      </div>
    </div>
  </div>
</template>
