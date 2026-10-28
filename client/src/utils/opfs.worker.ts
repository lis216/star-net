/**
 * OPFS 落盘 Worker：在 Web Worker 内用 FileSystemSyncAccessHandle 边收边写磁盘，
 * 接收大文件时内存占用恒定（只有哈希表），不再把整个文件攒在内存里。
 *
 * 消息协议（主线程 -> Worker）：
 *   { t:'create', id, size, total, chk, cs }   建文件（chk=是否校验链，cs=分片大小）
 *   { t:'write',  id, index, buf }             写入分片（buf 可转移）
 *   { t:'finish', id, expect }                 收尾并校验（expect=整链 SHA-256 hex）
 *   { t:'discard', id }                        丢弃
 *
 * Worker -> 主线程：
 *   { t:'created', id } / { t:'written', id, index }
 *   { t:'done', id, ok, verified } / { t:'error', id, reason }
 */

interface Entry {
  handle: FileSystemSyncAccessHandle;
  cs: number;
  total: number;
  chk: boolean;
  hashes: (ArrayBuffer | null)[];
}

const entries = new Map<string, Entry>();
let dir: FileSystemDirectoryHandle | null = null;
const TX_DIR = 'starnet-tx';

const S = self as any;

async function getDir(): Promise<FileSystemDirectoryHandle> {
  if (!dir) {
    const root: FileSystemDirectoryHandle = await S.navigator.storage.getDirectory();
    dir = await root.getDirectoryHandle(TX_DIR, { create: true });
  }
  return dir!;
}

function toHex(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
  return s;
}

async function digest(buf: ArrayBuffer): Promise<ArrayBuffer | null> {
  try {
    if (!S.crypto?.subtle) return null;
    return await S.crypto.subtle.digest('SHA-256', buf);
  } catch {
    return null;
  }
}

/** 启动时清理上次会话遗留的传输文件（Blob URL 不跨会话，都是死数据） */
async function cleanStale(): Promise<void> {
  try {
    const d = await getDir();
    const names: string[] = [];
    for await (const [name] of (d as any).entries()) names.push(name);
    for (const name of names) {
      if (!entries.has(name)) {
        try { await d.removeEntry(name); } catch { /* noop */ }
      }
    }
  } catch { /* noop */ }
}
void cleanStale();

/**
 * 所有 create/write/finish/discard 串行执行：
 * write 的 SHA-256 是异步的，若不排队，finish 会在最后几片的哈希回填前
 * 抢先校验，误报"校验失败"（内容其实完好）
 */
let queue: Promise<void> = Promise.resolve();

function enqueue(id: string, step: () => Promise<void>): void {
  queue = queue
    .then(step)
    .catch((err: any) => {
      S.postMessage({ t: 'error', id, reason: String(err?.message || err) });
    });
}

S.onmessage = (e: MessageEvent) => {
  const m: any = e.data;
  if (m.t === 'create') {
    enqueue(m.id, async () => {
      const d = await getDir();
      const fh = await d.getFileHandle(m.id, { create: true });
      const handle: FileSystemSyncAccessHandle = await (fh as any).createSyncAccessHandle();
      handle.truncate(0);
      entries.set(m.id, { handle, cs: m.cs, total: m.total, chk: !!m.chk, hashes: new Array(m.total).fill(null) });
      S.postMessage({ t: 'created', id: m.id });
    });
  } else if (m.t === 'write') {
    enqueue(m.id, async () => {
      const en = entries.get(m.id);
      if (en) {
        const buf: ArrayBuffer = m.buf;
        en.handle.write(buf, { at: m.index * en.cs });
        if (en.chk) en.hashes[m.index] = await digest(buf);
      }
      S.postMessage({ t: 'written', id: m.id, index: m.index });
    });
  } else if (m.t === 'finish') {
    enqueue(m.id, async () => {
      const en = entries.get(m.id);
      if (!en) {
        S.postMessage({ t: 'done', id: m.id, ok: false });
        return;
      }
      try { en.handle.flush(); } catch { /* noop */ }
      try { en.handle.close(); } catch { /* noop */ }
      entries.delete(m.id);
      let verified = true;
      if (en.chk && m.expect) {
        for (const h of en.hashes) {
          if (!h) { verified = false; break; }
        }
        if (verified) {
          const cat = new Uint8Array(en.hashes.length * 32);
          en.hashes.forEach((h, i) => cat.set(new Uint8Array(h!), i * 32));
          const chain = await digest(cat.buffer);
          verified = !!chain && toHex(chain) === m.expect;
        }
      }
      S.postMessage({ t: 'done', id: m.id, ok: true, verified });
    });
  } else if (m.t === 'discard') {
    enqueue(m.id, async () => {
      const en = entries.get(m.id);
      if (en) {
        try { en.handle.close(); } catch { /* noop */ }
        entries.delete(m.id);
      }
      try {
        const d = await getDir();
        await d.removeEntry(m.id);
      } catch { /* noop */ }
      S.postMessage({ t: 'written', id: m.id, index: -1 });
    });
  }
};
