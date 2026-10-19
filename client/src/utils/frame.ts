/**
 * 二进制分片帧协议（客户端）
 *
 * 帧布局：[kind:1B][fileIdLen:1B][fileId:utf8][index:u32 BE][payload...]
 * - kind 1 = p2p-chunk（DataChannel 二进制直发）
 * - kind 2 = bcast-chunk（WebSocket 二进制，服务器原样转发）
 */

export const FRAME_P2P_CHUNK = 1;
export const FRAME_BCAST_CHUNK = 2;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function packChunkFrame(kind: number, fileId: string, index: number, bytes: Uint8Array): Uint8Array {
  const idBytes = encoder.encode(fileId);
  const frame = new Uint8Array(2 + idBytes.length + 4 + bytes.length);
  const view = new DataView(frame.buffer);
  let o = 0;
  frame[o++] = kind;
  frame[o++] = idBytes.length;
  frame.set(idBytes, o);
  o += idBytes.length;
  view.setUint32(o, index);
  o += 4;
  frame.set(bytes, o);
  return frame;
}

export interface ChunkFrame {
  kind: number;
  fileId: string;
  index: number;
  bytes: Uint8Array;
}

export function parseChunkFrame(buf: ArrayBuffer): ChunkFrame | null {
  try {
    if (buf.byteLength < 7) return null;
    const view = new DataView(buf);
    const u8 = new Uint8Array(buf);
    let o = 0;
    const kind = view.getUint8(o); o += 1;
    const idLen = view.getUint8(o); o += 1;
    if (idLen < 1 || idLen > 64 || o + idLen + 4 > u8.length) return null;
    const fileId = decoder.decode(u8.subarray(o, o + idLen)); o += idLen;
    const index = view.getUint32(o); o += 4;
    if (o >= u8.length) return null;
    return { kind, fileId, index, bytes: u8.slice(o) };
  } catch {
    return null;
  }
}
