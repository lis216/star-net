import { defineStore } from 'pinia';
import { reactive, ref } from 'vue';
import type { ChatMsg, P2pSession } from '../types';
import { socket } from '../api/socket';
import { p2p } from '../webrtc/p2p';
import { useRoomStore } from './room';
import { uid } from '../utils/uid';
import * as fileStore from '../utils/fileStore';
import { packChunkFrame, parseChunkFrame, FRAME_BCAST_CHUNK, FRAME_P2P_CHUNK } from '../utils/frame';
import { pushNotify } from '../utils/notify';

const BCAST_CHUNK = 64 * 1024; // 广播走 WebSocket，单片 64KB（二进制帧）
const P2P_CHUNK = 16 * 1024; // 私聊统一 16KB：直连走 DataChannel 二进制，中转走 JSON base64
const RELAY_HINT_SIZE = 100 * 1024 * 1024; // 超过 100MB 且走中转时提示

interface IncomingFile {
  total: number;
  got: number;
  msg: ChatMsg;
  done: boolean;
  meter: (bytes: number) => { speed: number; eta: number };
  /** 最近一次收到分片的时间，用于停滞检测 */
  lastAt: number;
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function bytesToB64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

function toHex(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
  return s;
}

/** 非安全上下文（局域网 http）下 crypto.subtle 不存在，此时跳过校验 */
function hasSubtle(): boolean {
  return typeof crypto !== 'undefined' && !!crypto.subtle;
}

export const useChatStore = defineStore('chat', () => {
  const room = useRoomStore();

  const bcast = ref<ChatMsg[]>([]);
  const sessions = ref<P2pSession[]>([]);
  const msgsByPeer = reactive<Record<string, ChatMsg[]>>({});
  const activeTab = ref<string>('bcast');

  const incoming = new Map<string, IncomingFile>();
  /** 待确认的 P2P 文件（接收方手动确认模式） */
  const confirming = new Map<string, { scope: 'p2p'; peerId: string; meta: any }>();
  /** 发送方等待接收方确认（accept / reject / cancel） */
  const acceptWaiters = new Map<string, (v: 'accept' | 'reject' | 'cancel') => void>();
  /** 发送取消标记 */
  const abortFlags = new Map<string, true>();

  // 接收端停滞检测：发送端断线/手机息屏冻结时不会发 cancel，分片流会悄悄断掉，
  // 45 秒无新分片即判定传输中断（正常传输哪怕背压也不会停顿这么久）
  setInterval(() => {
    const now = Date.now();
    for (const [fileId, inc] of [...incoming.entries()]) {
      if (inc.done) {
        incoming.delete(fileId);
        continue;
      }
      if (now - inc.lastAt > 45_000) {
        inc.done = true;
        incoming.delete(fileId);
        inc.msg.transfer = 'failed';
        inc.msg.speed = undefined;
        inc.msg.eta = undefined;
        void fileStore.discard(fileId);
        room.toast(`「${inc.msg.fileName || '文件'}」传输中断，接收已取消`);
      }
    }
  }, 10_000);

  /** 自动接收文件开关（P2P 私聊；广播频道始终直接接收） */
  const autoAccept = ref(localStorage.getItem('starnet.autoaccept') === '1');
  function toggleAutoAccept(): void {
    autoAccept.value = !autoAccept.value;
    localStorage.setItem('starnet.autoaccept', autoAccept.value ? '1' : '0');
    room.toast(autoAccept.value ? '已开启自动接收文件' : '文件接收需要手动确认');
  }

  /** 测速器：EMA 平滑，250ms 最小采样间隔 */
  function makeMeter(size: number) {
    let lastT = 0;
    let lastBytes = 0;
    let speed = 0;
    return (bytes: number): { speed: number; eta: number } => {
      const now = performance.now();
      if (lastT && now - lastT >= 250) {
        const inst = ((bytes - lastBytes) * 1000) / (now - lastT);
        speed = speed ? speed * 0.6 + inst * 0.4 : inst;
        lastT = now;
        lastBytes = bytes;
      } else if (!lastT) {
        lastT = now;
        lastBytes = bytes;
      }
      return { speed, eta: speed > 0 ? (size - bytes) / speed : -1 };
    };
  }

  // ---------- 会话 ----------
  function openSession(peerId: string): void {
    if (!sessions.value.some((s) => s.peerId === peerId)) {
      sessions.value.push({ peerId, peerName: room.deviceName(peerId), status: 'connecting' });
      if (!msgsByPeer[peerId]) msgsByPeer[peerId] = [];
    }
    activeTab.value = peerId;
  }

  function closeTab(peerId: string): void {
    sessions.value = sessions.value.filter((s) => s.peerId !== peerId);
    activeTab.value = 'bcast';
  }

  /** 主动断开与某设备的点对点连接 */
  function disconnect(peerId: string): void {
    // 显式通知对方：中转模式没有 DataChannel，对方收不到断开事件
    socket.send({ type: 'p2p-notice', to: peerId, kind: 'ended' });
    p2p.close(peerId);
    sessions.value = sessions.value.filter((s) => s.peerId !== peerId);
    if (activeTab.value === peerId) activeTab.value = 'bcast';
    room.toast(`已断开与 ${room.deviceName(peerId)} 的连接`);
  }

  function setSessionStatus(peerId: string, status: P2pSession['status']): void {
    const s = sessions.value.find((x) => x.peerId === peerId);
    if (s) {
      // 直连建立过再断开 = 对方已离开，会话结束（不再回退服务器中转）
      if (s.status === 'open' && status === 'closed') s.ended = true;
      s.status = status;
      s.peerName = room.deviceName(peerId);
    }
  }

  /** 标记会话结束（对方断开/离开）：置灰发送区，不回退中转 */
  function endSession(peerId: string, silent = false): void {
    const s = sessions.value.find((x) => x.peerId === peerId);
    if (!s || s.ended) return;
    s.ended = true;
    s.status = 'closed';
    if (!silent) room.toast(`${room.deviceName(peerId)} 已离开，会话结束`);
  }

  /** 设备离开星系：结束与其的所有会话（device-leave 已有离场提示，静默标记），并取消在途文件 */
  function endSessionsOf(deviceId: string): void {
    for (const s of sessions.value) {
      if (s.peerId === deviceId) endSession(deviceId, true);
    }
    for (const [fileId, c] of confirming) {
      if (c.peerId === deviceId) {
        confirming.delete(fileId);
        const msg = findFileMsg(fileId);
        if (msg) msg.transfer = 'canceled';
      }
    }
    for (const [fileId, inc] of incoming) {
      if (inc.msg.scope === 'p2p' && inc.msg.peerId === deviceId && !inc.done) {
        inc.done = true;
        incoming.delete(fileId);
        inc.msg.transfer = 'canceled';
        void fileStore.discard(fileId);
      }
    }
  }

  // ---------- 广播 ----------
  function sendBcastText(text: string): void {
    const t = text.trim();
    if (!t) return;
    bcast.value.push({
      scope: 'bcast', peerId: '', from: { id: room.selfId, name: room.name },
      kind: 'text', text: t, ts: Date.now(), self: true,
    });
    socket.send({ type: 'bcast-text', text: t });
  }

  function pushBcastText(from: { id: string; name: string }, text: string, ts: number): void {
    if (from.id === room.selfId) return; // 本地已推送
    bcast.value.push({
      scope: 'bcast', peerId: '', from, kind: 'text', text, ts, self: false,
    });
    pushNotify(`${from.name} · 星系频道`, text);
  }

  // ---------- 文件（广播与 P2P 共用收发逻辑；接收端 OPFS 流式落盘） ----------
  // 注意：msg 必须用 reactive() 包裹——发送/接收过程中会通过 incoming Map 持有的引用
  // 直接改 progress/transfer/blobUrl，只有响应式代理才能触发界面更新
  async function sendFile(scope: 'bcast' | 'p2p', peerId: string, file: File): Promise<void> {
    const fileId = uid();
    const mime = file.type || 'application/octet-stream';
    const msg: ChatMsg = reactive({
      scope, peerId, from: { id: room.selfId, name: room.name },
      kind: 'file', fileId, fileName: file.name, size: file.size, mime,
      ts: Date.now(), self: true,
      blobUrl: URL.createObjectURL(file),
      progress: 0, transfer: scope === 'p2p' ? 'awaiting' : 'sending',
    });
    if (scope === 'bcast') bcast.value.push(msg);
    else {
      if (!msgsByPeer[peerId]) msgsByPeer[peerId] = [];
      msgsByPeer[peerId].push(msg);
    }

    const chunkSize = scope === 'bcast' ? BCAST_CHUNK : P2P_CHUNK;
    const total = Math.max(1, Math.ceil(file.size / chunkSize));
    const useHash = hasSubtle();
    const digests: (ArrayBuffer | null)[] = new Array(total).fill(null);

    // 接收确认：私聊需对方接受后才开始传输（自动接收模式由接收方秒回 accept）
    if (scope === 'p2p') {
      p2p.send(peerId, { kind: 'p2p-file-offer', fileId, fileName: file.name, size: file.size, mime, chk: useHash });
      const verdict = await new Promise<'accept' | 'reject' | 'cancel'>((resolve) => {
        acceptWaiters.set(fileId, resolve);
        setTimeout(() => {
          if (acceptWaiters.has(fileId)) {
            acceptWaiters.delete(fileId);
            resolve('cancel');
          }
        }, 30000);
      });
      if (verdict === 'reject') {
        msg.transfer = 'rejected';
        return;
      }
      if (verdict === 'cancel') {
        msg.transfer = 'canceled';
        return;
      }
      msg.transfer = 'sending';
      if (file.size > RELAY_HINT_SIZE && !p2p.isOpen(peerId)) {
        room.toast('文件较大且当前走服务器中转，传输速度会受限');
      }
    } else {
      if (file.size > RELAY_HINT_SIZE) {
        room.toast('文件较大且走服务器转发，广播速度会受限');
      }
      socket.send({ type: 'bcast-file-offer', fileId, fileName: file.name, size: file.size, mime, chk: useHash });
    }

    const meter = makeMeter(file.size);
    for (let i = 0; i < total; i++) {
      if (abortFlags.has(fileId)) {
        abortFlags.delete(fileId);
        // 通知接收方清理半成品
        if (scope === 'bcast') socket.send({ type: 'bcast-file-cancel', fileId });
        else p2p.send(peerId, { kind: 'p2p-file-cancel', fileId });
        msg.transfer = 'canceled';
        return;
      }
      const buf = await file.slice(i * chunkSize, (i + 1) * chunkSize).arrayBuffer();
      if (useHash) digests[i] = await crypto.subtle.digest('SHA-256', buf);
      const bytes = new Uint8Array(buf);

      // 每一片必须确认真正发出：连接断开的瞬间 socket/p2p 会静默丢数据，
      // 不检查的话发送端假成功、接收端永远等不到收尾（卡片卡在"接收中"没有下载链接）
      let sent: boolean;
      if (scope === 'bcast') {
        sent = room.connected && socket.sendBinary(packChunkFrame(FRAME_BCAST_CHUNK, fileId, i, bytes));
        if (sent) await fileStore.waitDrain(); // 接收端落盘背压
      } else if (p2p.isOpen(peerId)) {
        sent = p2p.sendBinary(peerId, packChunkFrame(FRAME_P2P_CHUNK, fileId, i, bytes));
        if (sent) await p2p.waitDrain(peerId);
      } else {
        // 中转：JSON + base64（服务器 512KB 单条消息上限内）
        sent = p2p.send(peerId, { kind: 'p2p-chunk', fileId, index: i, data: bytesToB64(bytes) });
        if (sent) await fileStore.waitDrain();
      }
      if (!sent) {
        failSend(msg, scope, peerId, fileId);
        return;
      }
      msg.progress = (i + 1) / total;
      const { speed, eta } = meter((i + 1) * chunkSize);
      msg.speed = speed;
      msg.eta = eta;
    }

    let chain: string | undefined;
    if (useHash) {
      const cat = new Uint8Array(total * 32);
      digests.forEach((d, i) => cat.set(new Uint8Array(d!), i * 32));
      chain = toHex(await crypto.subtle.digest('SHA-256', cat.buffer));
    }

    if (scope === 'bcast') {
      if (!room.connected || !socket.send({ type: 'bcast-file-end', fileId, hash: chain })) {
        failSend(msg, scope, peerId, fileId);
        return;
      }
    } else {
      if (!p2p.send(peerId, { kind: 'p2p-file-end', fileId, hash: chain })) {
        failSend(msg, scope, peerId, fileId);
        return;
      }
    }
    msg.transfer = 'done';
    msg.speed = undefined;
    msg.eta = undefined;
  }

  /** 发送通道失效：标记失败，并尽力通知接收端清理半成品（避免其永久卡在"接收中"） */
  function failSend(msg: ChatMsg, scope: 'bcast' | 'p2p', peerId: string, fileId: string): void {
    msg.transfer = 'failed';
    msg.speed = undefined;
    msg.eta = undefined;
    room.toast(`「${msg.fileName || '文件'}」发送中断（连接已断开），请重新发送`);
    try {
      if (scope === 'bcast') socket.send({ type: 'bcast-file-cancel', fileId });
      else p2p.send(peerId, { kind: 'p2p-file-cancel', fileId });
    } catch {
      /* 连接已断，通知不到就只能靠接收端自身的停滞检测兜底 */
    }
  }

  /** 发送方主动取消（等待确认中或传输中） */
  function abortSend(fileId: string): void {
    const msg = findFileMsg(fileId);
    if (!msg || !msg.self) return;
    const waiter = acceptWaiters.get(fileId);
    if (waiter) {
      acceptWaiters.delete(fileId);
      waiter('cancel'); // 尚未开始传输，sendFile 直接落 canceled
      return;
    }
    if (msg.transfer === 'sending') abortFlags.set(fileId, true);
  }

  function findFileMsg(fileId: string): ChatMsg | undefined {
    if (bcast.value.some((m) => m.fileId === fileId)) {
      return bcast.value.find((m) => m.fileId === fileId);
    }
    for (const list of Object.values(msgsByPeer)) {
      const m = list.find((x) => x.fileId === fileId);
      if (m) return m;
    }
    return undefined;
  }

  function onFileOffer(scope: 'bcast' | 'p2p', peerId: string, from: { id: string; name: string }, meta: { fileId: string; fileName: string; size: number; mime: string; chk?: boolean; ts?: number }): void {
    if (findFileMsg(meta.fileId)) return; // 自己发的回声
    const msg: ChatMsg = reactive({
      scope, peerId, from, kind: 'file',
      fileId: meta.fileId, fileName: meta.fileName, size: meta.size, mime: meta.mime,
      ts: meta.ts || Date.now(), self: false,
      progress: 0,
      // 私聊文件需确认（自动接收模式除外）；广播频道语义同群消息，直接接收
      transfer: scope === 'p2p' && !autoAccept.value ? 'confirming' : 'receiving',
    });
    if (scope === 'bcast') bcast.value.push(msg);
    else {
      if (!msgsByPeer[peerId]) msgsByPeer[peerId] = [];
      msgsByPeer[peerId].push(msg);
    }
    const chunkSize = scope === 'bcast' ? BCAST_CHUNK : P2P_CHUNK;
    const total = Math.max(1, Math.ceil(meta.size / chunkSize));
    if (msg.transfer === 'confirming') {
      confirming.set(meta.fileId, { scope: 'p2p', peerId, meta });
      notifyFile(from.name, `发来文件「${meta.fileName}」，等待确认`);
      return;
    }
    if (scope === 'p2p') p2p.send(peerId, { kind: 'p2p-file-accept', fileId: meta.fileId });
    incoming.set(meta.fileId, { total, got: 0, msg, done: false, meter: makeMeter(meta.size), lastAt: Date.now() });
    void fileStore.create(meta.fileId, meta.size, total, !!meta.chk, chunkSize);
  }

  /** 接收方：接受文件 */
  function acceptFile(fileId: string): void {
    const c = confirming.get(fileId);
    if (!c) return;
    confirming.delete(fileId);
    const msg = findFileMsg(fileId);
    if (!msg) return;
    msg.transfer = 'receiving';
    const chunkSize = P2P_CHUNK;
    const total = Math.max(1, Math.ceil((msg.size || 0) / chunkSize));
    incoming.set(fileId, { total, got: 0, msg, done: false, meter: makeMeter(msg.size || 0), lastAt: Date.now() });
    void fileStore.create(fileId, msg.size || 0, total, !!c.meta.chk, chunkSize);
    p2p.send(c.peerId, { kind: 'p2p-file-accept', fileId });
  }

  /** 接收方：拒收文件 */
  function rejectFile(fileId: string): void {
    const c = confirming.get(fileId);
    if (!c) return;
    confirming.delete(fileId);
    p2p.send(c.peerId, { kind: 'p2p-file-reject', fileId });
    const msg = findFileMsg(fileId);
    if (msg) msg.transfer = 'rejected';
  }

  /** 发送方：对方接受/拒收 */
  function onFileVerdict(fileId: string, verdict: 'accept' | 'reject'): void {
    const waiter = acceptWaiters.get(fileId);
    if (waiter) {
      acceptWaiters.delete(fileId);
      waiter(verdict);
    }
  }

  /** 发送方中途取消 / 接收端收到取消：清理半成品 */
  function onFileCancel(fileId: string): void {
    abortFlags.delete(fileId);
    const waiter = acceptWaiters.get(fileId);
    if (waiter) {
      acceptWaiters.delete(fileId);
      waiter('cancel');
    }
    const inc = incoming.get(fileId);
    if (inc && !inc.done) {
      inc.done = true;
      incoming.delete(fileId);
      inc.msg.transfer = 'canceled';
      void fileStore.discard(fileId);
      return;
    }
    const msg = findFileMsg(fileId);
    if (msg && (msg.transfer === 'confirming' || msg.transfer === 'receiving')) {
      confirming.delete(fileId);
      msg.transfer = 'canceled';
    }
  }

  function acceptChunk(fileId: string, index: number, bytes: Uint8Array): void {
    const inc = incoming.get(fileId);
    if (!inc || inc.done) return;
    if (!Number.isInteger(index) || index < 0 || index >= inc.total) return;
    inc.got += 1;
    inc.lastAt = Date.now();
    inc.msg.progress = Math.min(1, inc.got / inc.total);
    const { speed, eta } = inc.meter(inc.got * (inc.msg.size || 0) / inc.total);
    inc.msg.speed = speed;
    inc.msg.eta = eta;
    void fileStore.write(fileId, index, bytes);
  }

  /** 广播二进制分片（服务器转发的其他设备文件；本机回声已被 self 检查挡掉） */
  function onBinaryChunk(fileId: string, index: number, bytes: Uint8Array): void {
    const msg = findFileMsg(fileId);
    if (!msg || msg.self) return;
    if (!incoming.has(fileId)) return;
    acceptChunk(fileId, index, bytes);
  }

  /** 中转 base64 分片 */
  function onChunk(fileId: string, index: number, data: string): void {
    const msg = findFileMsg(fileId);
    if (!msg || msg.self) return;
    if (!incoming.has(fileId)) return;
    acceptChunk(fileId, index, b64ToBytes(data));
  }

  async function onFileEnd(fileId: string, hash?: string): Promise<void> {
    const inc = incoming.get(fileId);
    if (!inc || inc.done) return;
    inc.done = true;
    incoming.delete(fileId);
    const msg = inc.msg;
    // 接收端处于非安全上下文（局域网 http）时没有 crypto.subtle，无法重算哈希，
    // 此时传 null 跳过校验——"无法校验"不能误报为"内容损坏"
    const expect = hash && hasSubtle() ? hash : null;
    const res = await fileStore.finish(fileId, expect);
    msg.transfer = 'done';
    msg.progress = 1;
    msg.speed = undefined;
    msg.eta = undefined;
    if (res) {
      // 必须给 Blob 带上 MIME：内存分片组装的 Blob 和 OPFS 取回的 File 都没有 type，
      // 无类型 blob URL 在 iOS 上下载会被当 text/plain 存成 .txt、文件名也丢失
      const typed = res.blob.type ? res.blob : new Blob([res.blob], { type: msg.mime || 'application/octet-stream' });
      msg.blobUrl = URL.createObjectURL(typed);
      pushNotify(`${msg.from.name}`, `文件「${msg.fileName}」接收完成`);
      if (expect && !res.verified) {
        room.toast(`文件「${msg.fileName}」校验失败，内容可能已损坏`);
      }
    } else {
      room.toast(`文件「${msg.fileName}」接收失败`);
    }
  }

  // ---------- P2P 消息 ----------
  function sendP2pText(peerId: string, text: string): void {
    const t = text.trim();
    if (!t) return;
    if (!msgsByPeer[peerId]) msgsByPeer[peerId] = [];
    msgsByPeer[peerId].push({
      scope: 'p2p', peerId, from: { id: room.selfId, name: room.name },
      kind: 'text', text: t, ts: Date.now(), self: true,
    });
    p2p.send(peerId, { kind: 'p2p-text', text: t });
  }

  function pushP2pText(fromId: string, text: string): void {
    if (!msgsByPeer[fromId]) msgsByPeer[fromId] = [];
    msgsByPeer[fromId].push({
      scope: 'p2p', peerId: fromId, from: { id: fromId, name: room.deviceName(fromId) },
      kind: 'text', text, ts: Date.now(), self: false,
    });
    pushNotify(`${room.deviceName(fromId)} · 私聊`, text);
  }

  return {
    bcast, sessions, msgsByPeer, activeTab, autoAccept,
    openSession, closeTab, disconnect, setSessionStatus, endSession, endSessionsOf,
    toggleAutoAccept,
    sendBcastText, pushBcastText,
    sendFile, abortSend, onFileOffer, acceptFile, rejectFile, onFileVerdict, onFileCancel,
    onChunk, onBinaryChunk, onFileEnd,
    sendP2pText, pushP2pText,
  };
});
