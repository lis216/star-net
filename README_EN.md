# StarNet

<p>
  <a href="#overview">Overview</a> ·
  <a href="#features">Features</a> ·
  <a href="#architecture">Architecture</a> ·
  <a href="#local-development">Development</a> ·
  <a href="#deployment">Deployment</a> ·
  <a href="#wire-protocol">Protocol</a> ·
  <a href="#license">License</a>
</p>

English | [简体中文](./README.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

---

## Overview

**StarNet** is a web app for cross-network device connectivity: every online device in the same "galaxy" (room) is rendered as a star on a live star map. Devices can broadcast text / files / photos to everyone, and any two devices can establish a peer-to-peer connection for private chat or large file transfer.

- **No sign-up, no device info collected** — you only need a "galaxy key" (3–5 alphanumeric chars) and a star name (globally unique within the galaxy)
- **Privacy first** — the server **only relays, never stores**: no chat history, no files, no persistence. Newcomers only see live messages sent after they join
- **Visual galaxy** — a hand-drawn Canvas star map: a central sun, planets orbiting on four elliptical rings (with planetary rings and moons), shooting stars, and glowing links between connected peers

## Features

| Feature | Description |
|---|---|
| Galaxy broadcast | Text / files / photos visible to all, image thumbnails + click-to-zoom lightbox |
| Peer-to-peer direct link | Click a star to send a connection request; on accept, a WebRTC DataChannel opens; either side can disconnect |
| Transport fallback | If NAT hole-punching fails, traffic silently falls back to server relay — chat never breaks |
| Large file transfer | Receiver streams chunks straight to disk via OPFS (sync access handle in a Worker); constant memory even for GB-sized files; up to 2 GB per file |
| Binary chunking | Chunks travel as compact binary frames (33% smaller than base64/JSON); relay mode falls back to JSON automatically |
| Integrity check | Per-chunk SHA-256 + hash-chain verification over the whole file; skipped automatically on insecure origins |
| Refresh recovery | A device that refreshes or blips offline revives within 60 s via its clientId — same star, same position, same name |
| Share the galaxy | One click in the top bar generates an invite link (`?key=` prefills the key) and a QR code — scan to join |
| Batch sending | Multi-select files in the picker or drop several at once; queued sequential sending. Paste screenshots straight from the clipboard (Ctrl+V) |
| Receive confirmation | P2P files require the recipient's consent (accept / reject, 30 s timeout), with an optional auto-accept toggle; the sender can abort mid-transfer and both sides are cleaned up |
| Transfer telemetry | Live MB/s speed and estimated time remaining on both ends |
| Session status | Live dots on private tabs (green = direct online / pulsing blue = handshaking / amber = relay / gray = offline), connection-mode badge (WebRTC direct / server relay), and automatic session end + gray-out when the peer leaves |
| Background alerts | Bell toggle in the top bar enables system notifications while the tab is in the background, plus an unread counter in the title |
| PWA | Installable to the home screen (the service worker exists only to satisfy install criteria — no asset caching, keeping the zero-retention promise) |
| Responsive UI | Works on mobile and desktop, including insecure LAN origins (`http://192.168.x.x`) |

## Tech Stack

- **Frontend**: Vue 3 `<script setup>` + TypeScript + Pinia + Vite; Canvas 2D galaxy rendering
- **Backend**: Node.js + Express + ws (WebSocket), run directly with tsx
- **Transport**: WebRTC DataChannel (P2P) + WebSocket (signaling / broadcast / relay)

## Architecture

```
starnet/
├── client/                      # Frontend (Vue3 + TS + Vite)
│   └── src/
│       ├── App.vue              # Root: top bar / galaxy canvas / lightbox / toasts
│       ├── api/socket.ts        # WebSocket client (JSON text + binary frames, auto-reconnect)
│       ├── webrtc/p2p.ts        # P2P manager: DataChannel direct / relay fallback / backpressure
│       ├── logic/wire.ts        # Message routing: server events & P2P payloads → Pinia stores
│       ├── stores/
│       │   ├── room.ts          # Room state: devices, identity memory, clientId
│       │   └── chat.ts          # Sessions & messages: broadcast/private, file chunks, SHA-256 chain
│       ├── galaxy/scene.ts      # Canvas galaxy (sun / planets / rings / moons / meteors / links)
│       ├── utils/
│       │   ├── frame.ts         # Binary chunk frame pack/parse
│       │   ├── opfs.worker.ts   # OPFS writer worker (FileSystemSyncAccessHandle)
│       │   ├── fileStore.ts     # Large-file receiver store (OPFS + memory fallback + backpressure)
│       │   └── uid.ts           # UUID fallback for insecure contexts
│       ├── ui/lightbox.ts       # Image lightbox state (module-level singleton)
│       └── components/          # JoinGate / ChatPanel / MessageCard / DeviceDrawer /
│                                # ConnectDialog / CosmicBg / ImageLightbox
└── server/                      # Backend (Express + ws)
    ├── src/index.ts             # Room/device management, broadcast relay, signaling pass-through,
    │                            # binary frame relay, heartbeat cleanup (45s timeout / 60s ghost /
    │                            # empty-room GC)
    └── smoke.mjs                # Smoke tests (15 checks: join / broadcast / binary frames /
                                 # signaling / relay / leave notice / …)
```

**Data flow**:

```
Broadcast:  sender ──binary chunk frames──▶ server (relay only, no storage) ──▶ everyone
Private:    sender ──DataChannel direct (preferred)──▶ peer
            └─hole-punch fail─▶ JSON+base64 ──p2p-relay──▶ server ──▶ peer
Signaling:  offer/answer/ICE passed through the server between the two peers
Receive:    chunk → Worker → OPFS disk (write-as-you-receive) → file-end verify → Blob URL
```

## Local Development

```bash
# 1. Frontend
cd client && npm install && npm run dev        # http://localhost:5173

# 2. Backend
cd server && npm install && npm start          # http://localhost:3000

# 3. Production build (backend serves client/dist)
cd client && npm run build
```

**Usage**: open the page → enter a galaxy key (3–5 alphanumeric chars, or generate one) and a star name → join.

- Online devices appear as stars; click a star to send a connection request
- Bottom chat panel: the leftmost tab is the galaxy broadcast; private tabs appear once a connection is established
- Drag or pick a file to send (broadcast or private), images get instant previews

**Smoke tests** (start the server first):

```bash
cd server && node smoke.mjs
```

## Deployment

### Docker (recommended)

```bash
# Option A: pull the image directly (recommended)
docker pull ghcr.io/lis216/star-net:latest

# Option B: build from source
docker compose up -d --build

# Option C: load a pre-exported image tarball
docker load -i star-net-latest.tar
docker compose up -d
```

`docker-compose.yml` maps `3000:3000` by default — change the host side of `ports` as needed. The container ships with a health check and `restart: unless-stopped`.

### Export the image

```bash
docker build -t star-net:latest --platform linux/amd64 .
docker save star-net:latest -o star-net-latest.tar
```

### Public-internet notes

- **Always put HTTPS in front** (Nginx/Caddy reverse proxy + certificate): on plain http, browsers disable WebRTC and `crypto.subtle`, forcing all P2P traffic through the server relay and disabling integrity checks
- Open the mapped port in your firewall / security group
- The server only relays and stores nothing — no volumes or persistence required

## Wire Protocol

WebSocket text messages (JSON): `join` / `room-state` / `device-join|leave|rename` / `bcast-text` / `bcast-file-offer|file-end` (with `chk` flag and `hash` chain) / `connect-request|response` / `rtc-signal` / `p2p-relay` / `ping|pong`.

Binary frames (broadcast chunks over WS, private chunks over DataChannel, same layout):

```
[kind:1B][fileIdLen:1B][fileId:utf8][index:u32 BE][payload...]
kind=1 p2p-chunk   kind=2 bcast-chunk
```

- Broadcast chunks are 64 KB, private chunks 16 KB; server per-message cap 512 KB, broadcast offer cap 2 GB per file
- Integrity: `sha256(concat of per-chunk digests in order)` sent with `file-end`, recomputed and compared by the receiver

## License

This project is open-sourced under the [MIT License](./LICENSE).

- Anyone is free to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the software — the only requirement is to keep the original copyright notice and license text in all copies
- The software is provided "as is", **without warranty of any kind**; the authors/copyright holders are not liable for any damages arising from its use
- Derivative works and redistributions should retain the original copyright notice and license text in a prominent place
