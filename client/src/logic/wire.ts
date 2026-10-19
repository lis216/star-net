import { socket } from '../api/socket';
import { p2p } from '../webrtc/p2p';
import { useRoomStore } from '../stores/room';
import { useChatStore } from '../stores/chat';
import { parseChunkFrame, FRAME_BCAST_CHUNK, FRAME_P2P_CHUNK } from '../utils/frame';

let inited = false;

/** 把 WebSocket 消息接到 Pinia store 上，应用启动时调用一次 */
export function initWire(): void {
  if (inited) return;
  inited = true;
  const room = useRoomStore();
  const chat = useChatStore();

  // ---- P2P 数据回调 ----
  p2p.onPayload = (peerId, payload) => {
    switch (payload?.kind) {
      case 'p2p-text':
        chat.pushP2pText(peerId, String(payload.text ?? ''));
        break;
      case 'p2p-file-offer':
        chat.onFileOffer('p2p', peerId, { id: peerId, name: room.deviceName(peerId) }, payload);
        break;
      case 'p2p-chunk':
        chat.onChunk(payload.fileId, payload.index, payload.data);
        break;
      case 'p2p-file-end':
        chat.onFileEnd(payload.fileId, payload.hash);
        break;
      case 'p2p-file-accept':
        chat.onFileVerdict(payload.fileId, 'accept');
        break;
      case 'p2p-file-reject':
        chat.onFileVerdict(payload.fileId, 'reject');
        break;
      case 'p2p-file-cancel':
        chat.onFileCancel(payload.fileId);
        break;
    }
  };
  // P2P 直连二进制分片
  p2p.onBinary = (peerId, buf) => {
    const f = parseChunkFrame(buf);
    if (f && f.kind === FRAME_P2P_CHUNK) chat.onBinaryChunk(f.fileId, f.index, f.bytes);
  };
  p2p.onStatusChange = (peerId, status) => {
    if (status === 'open') {
      chat.setSessionStatus(peerId, 'open');
      room.toast(`与 ${room.deviceName(peerId)} 的点对点通道已建立`);
      return;
    }
    if (status === 'failed') {
      // 初始打洞失败：会话仍存活（走服务器中转），用 relay 状态而非 closed
      chat.setSessionStatus(peerId, 'relay');
      room.toast(`与 ${room.deviceName(peerId)} 的直连失败，已切换服务器中转`);
      return;
    }
    chat.setSessionStatus(peerId, 'closed');
    const ended = chat.sessions.find((s) => s.peerId === peerId)?.ended;
    if (ended) {
      room.toast(`${room.deviceName(peerId)} 已离开，会话结束`);
    } else {
      room.toast(`与 ${room.deviceName(peerId)} 的连接已断开`);
    }
  };

  // ---- 连接生命周期 ----
  socket.onOpen = () => {
    room.connected = true;
    socket.send({ type: 'join', key: room.key, name: room.name, clientId: room.clientId });
  };
  socket.onClose = () => {
    room.connected = false;
  };

  // ---- 服务器消息 ----
  socket.on('room-state', (m) => {
    room.selfId = m.selfId;
    room.devices = (m.devices || []).filter((d: any) => d.online); // 只显示在线设备
    for (const d of m.devices || []) room.rememberName(d.id, d.name);
    room.joined = true;
    room.joinError = '';
  });

  socket.on('join-error', (m) => {
    room.joinError = String(m.reason || '加入失败');
    room.joined = false;
  });

  socket.on('device-join', (m) => {
    room.upsertDevice(m.device);
    if (m.device.id !== room.selfId) room.toast(`${m.device.name} 加入了星系`);
  });

  socket.on('device-leave', (m) => {
    room.toast(`${room.deviceName(m.id)} 离开了星系`);
    room.removeDevice(m.id);
    chat.endSessionsOf(m.id); // 其私聊会话标记结束（中转/直连均适用）
  });

  // 对方主动断开私聊（中转模式下没有 DataChannel 断开事件，靠此通知）
  socket.on('p2p-notice', (m) => {
    if (m.kind === 'ended') chat.endSession(m.from);
  });

  socket.on('device-rename', (m) => {
    room.renameDevice(m.id, m.name);
  });

  socket.on('rename-error', (m) => {
    room.toast(String(m.reason || '改名失败'));
  });

  socket.on('bcast-text', (m) => chat.pushBcastText(m.from, m.text, m.ts));

  socket.on('bcast-file-offer', (m) =>
    chat.onFileOffer('bcast', '', m.from, {
      fileId: m.fileId, fileName: m.fileName, size: m.size, mime: m.mime, chk: m.chk, ts: m.ts,
    }),
  );
  socket.on('bcast-chunk', (m) => chat.onChunk(m.fileId, m.index, m.data));
  socket.on('bcast-file-end', (m) => chat.onFileEnd(m.fileId, m.hash));
  socket.on('bcast-file-cancel', (m) => chat.onFileCancel(m.fileId));

  // 广播二进制分片（服务器转发的 kind=2 帧）
  socket.onBinary = (data) => {
    const f = parseChunkFrame(data);
    if (f && f.kind === FRAME_BCAST_CHUNK) chat.onBinaryChunk(f.fileId, f.index, f.bytes);
  };

  socket.on('connect-request', (m) => {
    room.requests.push({ fromId: m.from.id, name: m.from.name });
    room.toast(`${m.from.name} 请求与你建立连接`);
  });

  socket.on('connect-response', (m) => {
    if (m.accept) {
      chat.openSession(m.from);
      p2p.initiate(m.from).catch(() => room.toast('建立连接失败'));
    } else {
      room.toast(`${room.deviceName(m.from)} 拒绝了连接请求`);
    }
  });

  socket.on('connect-error', (m) => {
    room.toast(String(m.reason || '连接失败'));
  });

  socket.on('rtc-signal', (m) => {
    chat.openSession(m.from); // 兜底：无论时序如何，收到信令即确保会话窗口存在
    p2p.handleSignal(m.from, m.signal).catch(() => room.toast('信令处理失败'));
  });

  socket.on('p2p-relay', (m) => {
    p2p.onPayload(m.from, m.payload);
  });
}

/** 发起入房 */
export function joinRoom(key: string, name: string): void {
  const room = useRoomStore();
  room.joinError = '';
  room.saveIdentity(key.trim(), name.trim());
  socket.connect();
}
