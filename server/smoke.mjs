// 冒烟测试：模拟两台设备加入同一星系，验证在线状态、广播文本、广播文件分片、改名、P2P 信令转发
import WebSocket from 'ws';

const URL = 'ws://localhost:3000/ws';
const KEY = 'SM7K';

function client(name) {
  const ws = new WebSocket(URL);
  const inbox = [];
  const waiters = [];
  const binInbox = [];
  const binWaiters = [];
  ws.on('message', (raw, isBinary) => {
    if (isBinary) {
      const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      binInbox.push(buf);
      for (let i = binWaiters.length - 1; i >= 0; i--) {
        if (binWaiters[i].pred(buf)) {
          clearTimeout(binWaiters[i].timer);
          binWaiters[i].resolve(buf);
          binWaiters.splice(i, 1);
        }
      }
      return;
    }
    const msg = JSON.parse(raw.toString());
    inbox.push(msg);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].pred(msg)) {
        clearTimeout(waiters[i].timer);
        waiters[i].resolve(msg);
        waiters.splice(i, 1);
      }
    }
  });
  ws.on('open', () => {
    ws.send(JSON.stringify({ type: 'join', key: KEY, name, clientId: `smoke-${name}` }));
  });
  const wait = (pred, label, timeout = 4000) =>
    new Promise((resolve, reject) => {
      const hit = inbox.find(pred);
      if (hit) return resolve(hit);
      const timer = setTimeout(() => reject(new Error(`timeout: ${label}`)), timeout);
      waiters.push({ pred, resolve, timer });
    });
  const waitBin = (pred, label, timeout = 4000) =>
    new Promise((resolve, reject) => {
      const hit = binInbox.find(pred);
      if (hit) return resolve(hit);
      const timer = setTimeout(() => reject(new Error(`timeout: ${label}`)), timeout);
      binWaiters.push({ pred, resolve, timer });
    });
  const send = (o) => ws.send(JSON.stringify(o));
  return { ws, name, inbox, wait, waitBin, send };
}

const results = [];
const check = (label, ok) => {
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) process.exitCode = 1;
};

const a = client('Alpha');
const b = client('Beta');

try {
const stateA = await a.wait((m) => m.type === 'room-state', 'A room-state');
check('A 收到 room-state 且 selfId 有效', typeof stateA.selfId === 'string' && stateA.selfId.length > 10);

const stateB = await b.wait((m) => m.type === 'room-state', 'B room-state');
check('B 收到 room-state', !!stateB.selfId);

// 双方都在对方的设备表 / 事件里可见（加入顺序不定，兼容两种路径）
async function seesEachOther() {
  const has = (state, id) => (state.devices || []).some((d) => d.id === id);
  const aKnowsB = has(stateA, stateB.selfId) || a.inbox.some((m) => m.type === 'device-join' && m.device?.id === stateB.selfId);
  const bKnowsA = has(stateB, stateA.selfId) || b.inbox.some((m) => m.type === 'device-join' && m.device?.id === stateA.selfId);
  if (!aKnowsB) await a.wait((m) => m.type === 'device-join' && m.device?.id === stateB.selfId, 'A sees B join');
  if (!bKnowsA) await b.wait((m) => m.type === 'device-join' && m.device?.id === stateA.selfId, 'B sees A join');
  return true;
}
check('双方互相可见', await seesEachOther());

  // 广播文本
  a.send({ type: 'bcast-text', text: 'hello from alpha' });
  const txt = await b.wait((m) => m.type === 'bcast-text' && m.text === 'hello from alpha', 'B receives bcast text');
  check('B 收到广播文本且带发送者', txt.from.name === 'Alpha');

  // 改名
  a.send({ type: 'rename', name: 'Alpha-2' });
  const rn = await b.wait((m) => m.type === 'device-rename' && m.name === 'Alpha-2', 'B sees rename');
  check('B 收到改名广播', !!rn);

  // 广播文件（3 个分片）
  const fileId = 'file-1';
  b.send({ type: 'bcast-file-offer', fileId, fileName: 'photo.png', size: 30, mime: 'image/png' });
  await a.wait((m) => m.type === 'bcast-file-offer' && m.fileId === fileId, 'A receives offer');
  for (let i = 0; i < 3; i++) b.send({ type: 'bcast-chunk', fileId, index: i, data: 'QUJD' });
  b.send({ type: 'bcast-file-end', fileId });
  const end = await a.wait((m) => m.type === 'bcast-file-end' && m.fileId === fileId, 'A receives file end');
  check('A 收到文件分片完成通知', end.fileId === fileId);
  check('A 收到全部 3 个分片', a.inbox.filter((m) => m.type === 'bcast-chunk' && m.fileId === fileId).length === 3);

  // 发送取消通知转发（客户端发送方中途 abort 时通知接收方清理）
  a.send({ type: 'bcast-file-cancel', fileId: 'file-x' });
  const cancel = await b.wait((m) => m.type === 'bcast-file-cancel' && m.fileId === 'file-x', 'B receives file cancel');
  check('B 收到文件取消通知', cancel.fileId === 'file-x');

  // 二进制帧广播（客户端真实使用的通道）：A 发 kind=2 帧，B 应收到原样转发
  const bFrameId = 'binf-1';
  const head = Buffer.concat([Buffer.from([2, bFrameId.length]), Buffer.from(bFrameId), (() => { const b = Buffer.alloc(4); b.writeUInt32BE(7); return b; })()]);
  const payload = Buffer.from('BINARY-CHUNK-DATA');
  a.ws.send(Buffer.concat([head, payload]));
  const gotBin = await b.waitBin(
    (buf) => buf[0] === 2 && buf[1] === bFrameId.length && buf.subarray(2, 2 + bFrameId.length).toString() === bFrameId,
    'B receives binary bcast chunk',
  );
  check('二进制广播分片原样转发', gotBin.subarray(gotBin.length - payload.length).equals(payload));

  // P2P 信令透传：B 向 A 发起
  const aId = stateA.selfId;
  b.send({ type: 'connect-request', to: aId });
  const req = await a.wait((m) => m.type === 'connect-request', 'A receives connect request');
  check('A 收到连接请求且带名称', req.from.name === 'Beta');

  a.send({ type: 'connect-response', to: req.from.id, accept: true });
  await b.wait((m) => m.type === 'connect-response' && m.accept === true, 'B receives accept');
  check('B 收到同意响应', true);

  b.send({ type: 'rtc-signal', to: aId, signal: { type: 'offer', sdp: 'fake-sdp' } });
  const sig = await a.wait((m) => m.type === 'rtc-signal' && m.signal?.type === 'offer', 'A receives rtc offer');
  check('A 收到透传的 WebRTC Offer', sig.signal.sdp === 'fake-sdp');

  // 服务器中转（P2P 降级通道）
  b.send({ type: 'p2p-relay', to: aId, payload: { kind: 'p2p-text', text: 'relay hi' } });
  const relay = await a.wait((m) => m.type === 'p2p-relay' && m.payload?.text === 'relay hi', 'A receives relayed text');
  check('P2P 降级中转可达', relay.from && typeof relay.from === 'string');

  // P2P 断开通知（中转模式无 DataChannel，靠显式 notice）
  b.send({ type: 'p2p-notice', to: aId, kind: 'ended' });
  const notice = await a.wait((m) => m.type === 'p2p-notice' && m.kind === 'ended', 'A receives p2p-notice');
  check('P2P 断开通知转发且带来源', notice.from === stateB.selfId);

  // 离线广播
  b.ws.close();
  const leaveA = await a.wait((m) => m.type === 'device-leave', 'A sees B leave', 5000);
  check('A 收到离线通知', !!leaveA);
} catch (e) {
  check(e.message, false);
  const summary = {};
  for (const m of a.inbox) summary[m.type] = (summary[m.type] || 0) + 1;
  console.log('A inbox:', JSON.stringify(summary));
  const summaryB = {};
  for (const m of b.inbox) summaryB[m.type] = (summaryB[m.type] || 0) + 1;
  console.log('B inbox:', JSON.stringify(summaryB));
} finally {
  try { a.ws.close(); } catch {}
  results.forEach((r) => console.log(r));
  process.exit(process.exitCode || 0);
}
