type Handler = (msg: any) => void;

class SocketClient {
  private ws: WebSocket | null = null;
  private handlers = new Map<string, Handler[]>();
  private retry = 0;
  private closedByUser = false;
  /** 保活定时器：服务端 45s 没收到消息就断开连接，空闲时必须定期发 ping */
  private keepAlive: ReturnType<typeof setInterval> | null = null;

  onOpen: (() => void) | null = null;
  onClose: (() => void) | null = null;
  /** 收到服务器二进制帧（广播文件分片），由 wire 模块接管 */
  onBinary: ((data: ArrayBuffer) => void) | null = null;

  get wsUrl(): string {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    return `${proto}://${location.host}/ws`;
  }

  connect(): void {
    this.closedByUser = false;
    this.cleanup();
    const ws = new WebSocket(this.wsUrl);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    ws.onopen = () => {
      this.retry = 0;
      this.startKeepAlive();
      this.onOpen?.();
    };

    ws.onmessage = (e) => {
      if (e.data instanceof ArrayBuffer) {
        this.onBinary?.(e.data);
        return;
      }
      let msg: any;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      const list = this.handlers.get(msg.type);
      if (list) for (const h of [...list]) h(msg);
    };

    ws.onclose = () => {
      this.ws = null;
      this.stopKeepAlive();
      this.onClose?.();
      if (!this.closedByUser) {
        this.retry += 1;
        const delay = Math.min(1000 * 2 ** Math.min(this.retry, 4), 15000);
        setTimeout(() => this.connect(), delay);
      }
    };

    ws.onerror = () => {
      try {
        ws.close();
      } catch {
        /* noop */
      }
    };
  }

  /** 每 15s 发一次应用层 ping（远小于服务端 45s 超时），空闲连接不再被误杀 */
  private startKeepAlive(): void {
    this.stopKeepAlive();
    this.keepAlive = setInterval(() => {
      this.send({ type: 'ping' });
    }, 15_000);
  }

  private stopKeepAlive(): void {
    if (this.keepAlive) {
      clearInterval(this.keepAlive);
      this.keepAlive = null;
    }
  }

  private cleanup(): void {
    this.stopKeepAlive();
    if (this.ws) {
      this.closedByUser = true;
      try {
        this.ws.close();
      } catch {
        /* noop */
      }
      this.ws = null;
    }
  }

  send(obj: unknown): boolean {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
      return true;
    }
    return false;
  }

  /** 发送二进制帧（广播文件分片） */
  sendBinary(data: Uint8Array): boolean {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(data);
      return true;
    }
    return false;
  }

  on(type: string, h: Handler): void {
    const list = this.handlers.get(type) || [];
    list.push(h);
    this.handlers.set(type, list);
  }
}

export const socket = new SocketClient();
