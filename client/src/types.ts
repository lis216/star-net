export interface DeviceView {
  id: string;
  name: string;
  online: boolean;
  joinAt: number;
}

export interface ChatMsg {
  scope: 'bcast' | 'p2p';
  peerId: string; // p2p 会话对端 id，bcast 为 ''
  from: { id: string; name: string };
  kind: 'text' | 'file';
  text?: string;
  fileId?: string;
  fileName?: string;
  size?: number;
  mime?: string;
  ts: number;
  self: boolean;
  blobUrl?: string;
  progress?: number; // 0..1
  transfer?: 'awaiting' | 'sending' | 'confirming' | 'receiving' | 'done' | 'rejected' | 'timeout' | 'canceled' | 'failed';
  speed?: number; // 传输速度 B/s
  eta?: number; // 预计剩余秒数
}

export interface P2pSession {
  peerId: string;
  peerName: string;
  /** connecting=握手中 open=WebRTC直连 relay=服务器中转（会话存活） closed=已断开 */
  status: 'connecting' | 'open' | 'relay' | 'closed';
  /** 直连建立过但已断开（对方离开）：会话结束，不再回退服务器中转，禁用发送 */
  ended?: boolean;
}

