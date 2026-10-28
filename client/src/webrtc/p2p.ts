import { socket } from '../api/socket';

interface PeerConn {
  pc: RTCPeerConnection;
  dc: RTCDataChannel | null;
  status: 'connecting' | 'open' | 'closed';
}

const ICE_SERVERS: RTCIceServer[] = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
];

class P2PManager {
  private conns = new Map<string, PeerConn>();

  /** 收到对端数据（DataChannel 或服务器中转），由 wire 模块注入 */
  onPayload: (peerId: string, payload: any) => void = () => {};
  /** 收到对端二进制帧（文件分片），由 wire 模块注入 */
  onBinary: (peerId: string, buf: ArrayBuffer) => void = () => {};
  /** 连接状态变化：open / closed / failed */
  onStatusChange: (peerId: string, status: 'open' | 'closed' | 'failed') => void = () => {};

  /** 当前 DataChannel 是否已打开（可直发） */
  isOpen(peerId: string): boolean {
    const conn = this.conns.get(peerId);
    return !!conn && !!conn.dc && conn.dc.readyState === 'open';
  }

  /** 双方同意后由发起方调用：创建 offer */
  async initiate(peerId: string): Promise<void> {
    if (!this.conns.has(peerId)) this.createPc(peerId);
    const conn = this.conns.get(peerId)!;
    const dc = conn.pc.createDataChannel('starnet', { ordered: true });
    this.wireDc(peerId, dc);
    const offer = await conn.pc.createOffer();
    await conn.pc.setLocalDescription(offer);
    socket.send({ type: 'rtc-signal', to: peerId, signal: { type: 'offer', sdp: conn.pc.localDescription!.sdp } });
  }

  private createPc(peerId: string): PeerConn {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const conn: PeerConn = { pc, dc: null, status: 'connecting' };
    this.conns.set(peerId, conn);

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        socket.send({ type: 'rtc-signal', to: peerId, signal: { type: 'ice', candidate: e.candidate } });
      }
    };
    pc.ondatachannel = (e) => this.wireDc(peerId, e.channel);
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        conn.status = 'closed';
        this.onStatusChange(peerId, 'failed');
      }
    };
    return conn;
  }

  private wireDc(peerId: string, dc: RTCDataChannel): void {
    const conn = this.conns.get(peerId);
    if (!conn) return;
    conn.dc = dc;
    dc.binaryType = 'arraybuffer';
    dc.onopen = () => {
      conn.status = 'open';
      this.onStatusChange(peerId, 'open');
    };
    dc.onclose = () => {
      const wasOpen = conn.status === 'open';
      conn.status = 'closed';
      this.onStatusChange(peerId, wasOpen ? 'closed' : 'failed');
    };
    dc.onmessage = (e) => {
      if (e.data instanceof ArrayBuffer) {
        this.onBinary(peerId, e.data);
        return;
      }
      try {
        this.onPayload(peerId, JSON.parse(e.data));
      } catch {
        /* 非 JSON 忽略 */
      }
    };
  }

  async handleSignal(from: string, signal: { type: string; sdp?: string; candidate?: RTCIceCandidateInit }): Promise<void> {
    if (signal.type === 'offer' && signal.sdp) {
      if (!this.conns.has(from)) this.createPc(from);
      const conn = this.conns.get(from)!;
      await conn.pc.setRemoteDescription({ type: 'offer', sdp: signal.sdp });
      const answer = await conn.pc.createAnswer();
      await conn.pc.setLocalDescription(answer);
      socket.send({ type: 'rtc-signal', to: from, signal: { type: 'answer', sdp: conn.pc.localDescription!.sdp } });
    } else if (signal.type === 'answer' && signal.sdp) {
      const conn = this.conns.get(from);
      if (!conn) return;
      if (conn.pc.signalingState === 'have-local-offer') {
        await conn.pc.setRemoteDescription({ type: 'answer', sdp: signal.sdp });
      }
    } else if (signal.type === 'ice' && signal.candidate) {
      const conn = this.conns.get(from);
      if (!conn) return;
      try {
        await conn.pc.addIceCandidate(signal.candidate);
      } catch {
        /* 忽略无效候选 */
      }
    }
  }

  /** 主动断开：本地清理连接，不触发状态回调（对端会收到 close 事件走正常断线流程） */
  close(peerId: string): void {
    const conn = this.conns.get(peerId);
    if (!conn) return;
    if (conn.dc) {
      conn.dc.onclose = null;
      conn.dc.onmessage = null;
      try { conn.dc.close(); } catch { /* */ }
    }
    conn.pc.onconnectionstatechange = null;
    try { conn.pc.close(); } catch { /* */ }
    this.conns.delete(peerId);
  }

  /** 发送：DataChannel 可用则直发，否则经服务器中转（对端无感知）。返回是否真正发出 */
  send(peerId: string, payload: unknown): boolean {
    const conn = this.conns.get(peerId);
    if (conn && conn.dc && conn.dc.readyState === 'open') {
      conn.dc.send(JSON.stringify(payload));
      return true;
    }
    return socket.send({ type: 'p2p-relay', to: peerId, payload });
  }

  /** 直发二进制帧（仅 DataChannel 打开时有效） */
  sendBinary(peerId: string, frame: Uint8Array): boolean {
    const conn = this.conns.get(peerId);
    if (conn && conn.dc && conn.dc.readyState === 'open') {
      conn.dc.send(frame);
      return true;
    }
    return false;
  }

  /** DataChannel 背压等待 */
  waitDrain(peerId: string): Promise<void> {
    const conn = this.conns.get(peerId);
    return new Promise((resolve) => {
      const tick = () => {
        if (!conn || !conn.dc || conn.dc.readyState !== 'open' || conn.dc.bufferedAmount < 4 << 20) {
          resolve();
        } else {
          setTimeout(tick, 30);
        }
      };
      tick();
    });
  }
}

export const p2p = new P2PManager();
