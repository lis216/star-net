import express from 'express';
import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const HEARTBEAT_TIMEOUT = 45_000;
const GHOST_TTL = 60_000; // 离线设备保留 60s，供刷新后凭 clientId 复活（星星回到原位）

interface Device {
  id: string;
  clientId: string | null; // 浏览器持久标识，用于刷新后复活同一设备
  name: string;
  joinAt: number;
  lastSeen: number;
  ws: WebSocket | null;
}

interface Room {
  key: string;
  devices: Map<string, Device>;
}

const rooms = new Map<string, Room>();

function getRoom(key: string): Room {
  let room = rooms.get(key);
  if (!room) {
    room = { key, devices: new Map() };
    rooms.set(key, room);
  }
  return room;
}

function deviceView(d: Device) {
  return { id: d.id, name: d.name, online: !!d.ws, joinAt: d.joinAt };
}

function deviceList(room: Room) {
  return [...room.devices.values()].map(deviceView);
}

function sendTo(ws: WebSocket | null, msg: unknown): void {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function broadcast(room: Room, msg: unknown, exceptId?: string): void {
  for (const d of room.devices.values()) {
    if (d.id !== exceptId) sendTo(d.ws, msg);
  }
}

function validKey(key: unknown): key is string {
  return typeof key === 'string' && /^[a-zA-Z0-9]{3,5}$/.test(key.trim());
}

function validName(name: unknown): name is string {
  return typeof name === 'string' && name.trim().length >= 1 && name.trim().length <= 24;
}

const app = express();
app.use(express.static(path.join(__dirname, '../../client/dist')));
app.get(/^(?!\/ws$).*/, (_req, res) => {
  res.sendFile(path.join(__dirname, '../../client/dist/index.html'));
});

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 512 * 1024 });

wss.on('connection', (ws: WebSocket) => {
  let device: Device | null = null;
  let room: Room | null = null;

  const leave = () => {
    if (!device || !room) return;
    device.ws = null;
    device.lastSeen = Date.now();
    broadcast(room, { type: 'device-leave', id: device.id });
    // 不立即删除：保留幽灵设备一段时间，刷新/闪断后凭 clientId 复活（客户端只显示在线设备，不受影响）
    device = null;
    room = null;
  };

  ws.on('close', leave);
  ws.on('error', () => leave());

  ws.on('message', (raw) => {
    // ---- 二进制帧（广播文件分片）：[kind:1B][fileIdLen:1B][fileId][index:u32BE][payload...] ----
    // 服务器只校验头部并原样转发，不理解内容
    let text: any;
    let isJson = true;
    try {
      text = JSON.parse(raw.toString());
    } catch {
      isJson = false;
    }
    if (!isJson) {
      const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);
      if (buf.length >= 8 && buf.length <= 132 * 1024) {
        const idLen = buf[1];
        const kind = buf[0];
        // kind 2 = bcast-chunk，转发给房间内其他设备
        if (kind === 2 && idLen >= 1 && idLen <= 64 && 2 + idLen + 4 < buf.length && device && room) {
          device.lastSeen = Date.now();
          for (const d of room.devices.values()) {
            if (d.id !== device.id && d.ws && d.ws.readyState === WebSocket.OPEN) {
              d.ws.send(buf);
            }
          }
        }
      }
      return;
    }
    const msg = text;
    if (!msg || typeof msg.type !== 'string') return;

    // ---- 入房 ----
    if (msg.type === 'join') {
      if (!validKey(msg.key) || !validName(msg.name)) {
        sendTo(ws, { type: 'join-error', reason: !validKey(msg.key) ? '星系坐标无效（3~5 位字母或数字）' : '名称无效（1-24 字）' });
        return;
      }
      leave(); // 若已在其他房间，先退出
      room = getRoom(msg.key.trim());
      const name = msg.name.trim();
      // 星球名称全星系唯一（含离线幽灵，防止蹭名）
      const wanted = typeof msg.clientId === 'string' && msg.clientId ? msg.clientId : '';
      const existing = wanted ? [...room.devices.values()].find((d) => !d.ws && d.clientId === wanted) : undefined;
      const nameTaken = [...room.devices.values()].some((d) => d !== existing && d.name === name);
      if (nameTaken) {
        sendTo(ws, { type: 'join-error', reason: `星球名称「${name}」已被本星系使用，请换一个` });
        device = null;
        room = null;
        return;
      }
      let id: string;
      if (existing) {
        id = existing.id;
        existing.name = name;
        existing.ws = ws;
        existing.lastSeen = Date.now();
        device = existing;
      } else {
        id = crypto.randomUUID();
        device = { id, clientId: wanted || null, name, joinAt: Date.now(), lastSeen: Date.now(), ws };
        room.devices.set(id, device);
      }
      sendTo(ws, {
        type: 'room-state',
        selfId: id,
        devices: deviceList(room),
      });
      broadcast(room, { type: 'device-join', device: deviceView(device) }, id);
      return;
    }

    if (!device || !room) return;
    device.lastSeen = Date.now();

    switch (msg.type) {
      case 'ping':
        sendTo(ws, { type: 'pong', ts: Date.now() });
        break;

      case 'rename': {
        if (!validName(msg.name)) return;
        const newName = msg.name.trim();
        const taken = [...room.devices.values()].some((d) => d !== device && d.name === newName);
        if (taken) {
          sendTo(ws, { type: 'rename-error', reason: `星球名称「${newName}」已被本星系使用` });
          return;
        }
        device.name = newName;
        broadcast(room, { type: 'device-rename', id: device.id, name: device.name });
        break;
      }

      case 'bcast-text': {
        if (typeof msg.text !== 'string' || !msg.text.trim() || msg.text.length > 4000) return;
        broadcast(room, { type: 'bcast-text', from: { id: device.id, name: device.name }, text: msg.text, ts: Date.now() });
        break;
      }

      case 'bcast-file-offer': {
        if (typeof msg.fileId !== 'string' || typeof msg.fileName !== 'string') return;
        if (typeof msg.size !== 'number' || msg.size < 0 || msg.size > 2 * 1024 * 1024 * 1024) return;
        // 文件不进历史：内容只在实时传输，入历史会造成"刷新后有记录但看不了"的死记录
        broadcast(room, {
          type: 'bcast-file-offer',
          from: { id: device.id, name: device.name },
          fileId: msg.fileId,
          fileName: String(msg.fileName).slice(0, 120),
          size: msg.size,
          mime: typeof msg.mime === 'string' ? msg.mime : 'application/octet-stream',
          chk: !!msg.chk,
          ts: Date.now(),
        });
        break;
      }

      case 'bcast-chunk': {
        if (typeof msg.fileId !== 'string' || typeof msg.index !== 'number') return;
        if (typeof msg.data !== 'string' || msg.data.length > 200_000) return;
        broadcast(room, { type: 'bcast-chunk', fileId: msg.fileId, index: msg.index, data: msg.data });
        break;
      }

      case 'bcast-file-end': {
        if (typeof msg.fileId !== 'string') return;
        broadcast(room, { type: 'bcast-file-end', fileId: msg.fileId, hash: typeof msg.hash === 'string' ? msg.hash : undefined });
        break;
      }

      case 'bcast-file-cancel': {
        if (typeof msg.fileId !== 'string') return;
        broadcast(room, { type: 'bcast-file-cancel', fileId: msg.fileId });
        break;
      }

      case 'connect-request': {
        const target = room.devices.get(msg.to);
        if (!target || !target.ws) {
          sendTo(ws, { type: 'connect-error', to: msg.to, reason: '对方不在线' });
          return;
        }
        sendTo(target.ws, { type: 'connect-request', from: { id: device.id, name: device.name } });
        break;
      }

      case 'connect-response': {
        const target = room.devices.get(msg.to);
        if (!target || !target.ws) return;
        sendTo(target.ws, { type: 'connect-response', from: device.id, accept: !!msg.accept });
        break;
      }

      case 'rtc-signal': {
        const target = room.devices.get(msg.to);
        if (!target || !target.ws || typeof msg.signal !== 'object') return;
        sendTo(target.ws, { type: 'rtc-signal', from: device.id, signal: msg.signal });
        break;
      }

      case 'p2p-relay': {
        const target = room.devices.get(msg.to);
        if (!target || !target.ws || typeof msg.payload !== 'object') return;
        sendTo(target.ws, { type: 'p2p-relay', from: device.id, payload: msg.payload });
        break;
      }

      // 私聊逻辑事件（如断开通知）：中转模式没有 DataChannel，断开只能靠显式通知
      case 'p2p-notice': {
        if (typeof msg.to !== 'string' || typeof msg.kind !== 'string') return;
        const target = room.devices.get(msg.to);
        if (!target || !target.ws) return;
        sendTo(target.ws, { type: 'p2p-notice', from: device.id, kind: msg.kind });
        break;
      }
    }
  });
});

// 心跳清理：超时断开；幽灵设备过期移除；空房间回收
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    for (const d of [...room.devices.values()]) {
      if (d.ws && now - d.lastSeen > HEARTBEAT_TIMEOUT) {
        d.ws.close();
      } else if (!d.ws && now - d.lastSeen > GHOST_TTL) {
        room.devices.delete(d.id);
      }
    }
    if (room.devices.size === 0) rooms.delete(room.key);
  }
}, 10_000);

server.listen(PORT, () => {
  console.log(`[StarNet] server listening on http://localhost:${PORT}`);
});
