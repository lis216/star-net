/**
 * 大文件接收仓库：
 *  - 首选 OPFS Worker 流式落盘（内存占用恒定，支持 GB 级）
 *  - 环境不支持时自动降级为内存分片（仅适合小文件）
 *  - 内置背压：磁盘写入落后太多时通知发送循环暂停
 */

interface MemFile {
  chunks: (Uint8Array | null)[];
  got: number;
}

const memFiles = new Map<string, MemFile>();
const memSupported = new Set<string>(); // 走内存模式的 fileId

let worker: Worker | null = null;
let workerBroken = false;

// create / finish 的等待表
const createWaiters = new Map<string, { resolve: () => void; reject: () => void }>();
const finishWaiters = new Map<string, { resolve: (r: FinishResult | null) => void }>();

// create 未完成期间到达的分片先缓冲，完成后按序落位——
// 否则 OPFS 降级内存的瞬间，先到的分片已经进了 worker，后到的进了内存，文件会缺片
const createInFlight = new Map<string, Promise<void>>();
const pendingWrites = new Map<string, { index: number; bytes: Uint8Array; resolve: () => void }[]>();

// 写入背压
const ackWaiters = new Map<string, () => void>();
let inFlight = 0;

export interface FinishResult {
  blob: Blob;
  verified: boolean;
}

function ensureWorker(): Worker | null {
  if (workerBroken) return null;
  if (worker) return worker;
  try {
    worker = new Worker(new URL('./opfs.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent) => {
      const m: any = e.data;
      if (m.t === 'created') {
        createWaiters.get(m.id)?.resolve();
        createWaiters.delete(m.id);
      } else if (m.t === 'written') {
        const key = `${m.id}:${m.index}`;
        const w = ackWaiters.get(key);
        if (w) {
          ackWaiters.delete(key);
          inFlight = Math.max(0, inFlight - 1);
          w();
        }
      } else if (m.t === 'done') {
        const fw = finishWaiters.get(m.id);
        finishWaiters.delete(m.id);
        if (fw) {
          if (m.ok) {
            void materialize(m.id).then((blob) => fw.resolve(blob ? { blob, verified: !!m.verified } : null));
          } else {
            fw.resolve(null);
          }
        }
      } else if (m.t === 'error') {
        createWaiters.get(m.id)?.reject();
        createWaiters.delete(m.id);
        const fw = finishWaiters.get(m.id);
        finishWaiters.delete(m.id);
        fw?.resolve(null);
      }
    };
    worker.onerror = () => {
      workerBroken = true;
    };
  } catch {
    workerBroken = true;
    worker = null;
  }
  return worker;
}

/** 把 OPFS 里的文件取出来变成可下载/可预览的 File */
async function materialize(id: string): Promise<File | null> {
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('starnet-tx');
    const fh = await dir.getFileHandle(id);
    return await fh.getFile();
  } catch {
    return null;
  }
}

export async function create(id: string, size: number, total: number, chk: boolean, chunkSize: number): Promise<void> {
  const p = doCreate(id, size, total, chk, chunkSize);
  createInFlight.set(id, p);
  try {
    await p;
  } finally {
    // 先取出缓冲再清 in-flight 标记，保证不会有分片从缝隙里溜进错误的存储
    const buffered = pendingWrites.get(id);
    pendingWrites.delete(id);
    createInFlight.delete(id);
    if (buffered) for (const w of buffered) void write(id, w.index, w.bytes).then(w.resolve);
  }
}

async function doCreate(id: string, size: number, total: number, chk: boolean, chunkSize: number): Promise<void> {
  const w = ensureWorker();
  if (w) {
    try {
      await new Promise<void>((resolve, reject) => {
        createWaiters.set(id, { resolve, reject });
        w.postMessage({ t: 'create', id, size, total, chk, cs: chunkSize });
        setTimeout(() => {
          if (createWaiters.has(id)) {
            createWaiters.delete(id);
            reject();
          }
        }, 3000);
      });
      return;
    } catch {
      workerBroken = true; // OPFS 不可用，整体降级
    }
  }
  memFiles.set(id, { chunks: new Array(total).fill(null), got: 0 });
  memSupported.add(id);
}

/** 写入一片，返回写入完成（ack）的 Promise */
export async function write(id: string, index: number, bytes: Uint8Array): Promise<void> {
  if (createInFlight.has(id)) {
    // create 尚未落定（worker 建文件中或即将降级），先缓冲
    await new Promise<void>((resolve) => {
      const list = pendingWrites.get(id) || [];
      list.push({ index, bytes, resolve });
      pendingWrites.set(id, list);
    });
    return;
  }
  if (memSupported.has(id)) {
    const f = memFiles.get(id);
    if (f && !f.chunks[index]) {
      f.chunks[index] = bytes;
      f.got += 1;
    }
    return;
  }
  const w = ensureWorker();
  if (!w) return;
  inFlight += 1;
  await new Promise<void>((resolve) => {
    ackWaiters.set(`${id}:${index}`, resolve);
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    w.postMessage({ t: 'write', id, index, buf }, [buf]);
  });
}

/** 发送侧背压：落盘积压超过 max 片时等待 */
export async function waitDrain(max = 64): Promise<void> {
  let waited = 0;
  while (inFlight > max && waited < 30000) {
    await new Promise((r) => setTimeout(r, 20));
    waited += 20;
  }
}

/** 收尾：等待校验并取出文件。expect 为整链 SHA-256 hex（发送方没算则传 null） */
export async function finish(id: string, expect: string | null): Promise<FinishResult | null> {
  if (memSupported.has(id)) {
    const f = memFiles.get(id);
    memFiles.delete(id);
    memSupported.delete(id);
    if (!f) return null;
    const parts = f.chunks.filter((c): c is Uint8Array => c !== null);
    return { blob: new Blob(parts as BlobPart[]), verified: false };
  }
  const w = ensureWorker();
  if (!w) return null;
  return new Promise<FinishResult | null>((resolve) => {
    finishWaiters.set(id, { resolve });
    w.postMessage({ t: 'finish', id, expect });
    setTimeout(() => {
      if (finishWaiters.has(id)) {
        finishWaiters.delete(id);
        resolve(null);
      }
    }, 10000);
  });
}

export async function discard(id: string): Promise<void> {
  if (memSupported.has(id)) {
    memFiles.delete(id);
    memSupported.delete(id);
    return;
  }
  const w = ensureWorker();
  if (!w) return;
  w.postMessage({ t: 'discard', id });
}
