# 星网 StarNet

<p>
  <a href="#项目简介">简介</a> ·
  <a href="#功能特性">功能</a> ·
  <a href="#架构">架构</a> ·
  <a href="#本地开发">开发</a> ·
  <a href="#部署">部署</a> ·
  <a href="#通信协议">协议</a> ·
  <a href="#许可">许可</a>
</p>

[English](./README_EN.md) | 简体中文

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

---

## 项目简介

**星网（StarNet）** 是一个跨网设备互联 Web 应用：同一星系（房间）内的每台在线设备渲染为星图中的一颗星，设备之间可以广播文字/文件/照片，任意两台设备可以建立点对点直连私聊或互传大文件。

- **零注册、零采集**：不读取任何设备信息，只需「星系坐标（3~5 位字母数字）+ 星球名称」即可进入，名称在星系内全局唯一
- **隐私优先**：服务器对聊天内容**只转发、不保存**——文字、文件、私聊全部不留底，新进设备只能看到加入之后的实时消息
- **可视化星图**：Canvas 手绘星系——居中恒星、行星沿四圈椭圆轨道运行（带星环与卫星）、流星划过、P2P 连接后星球间点亮连线

## 功能特性

| 功能 | 说明 |
|---|---|
| 星系广播 | 文字、文件、照片全员可见，图片缩略图 + 点击放大灯箱预览 |
| 点对点直连 | 点击星球发起连接请求，对方同意后建立 WebRTC DataChannel 私聊，可主动断开 |
| 传输降级 | 直连打洞失败（严格 NAT）时自动切换服务器中转，私聊不中断 |
| 大文件传输 | 接收端 OPFS 流式落盘（Worker 内同步句柄），GB 级文件内存占用恒定；单文件上限 2GB |
| 二进制分片 | 分片以紧凑二进制帧传输（较 base64/JSON 省 33% 体积），中转模式自动回退 JSON |
| 完整性校验 | 每片 SHA-256 + 哈希链整体校验；非安全上下文自动跳过 |
| 刷新复活 | 设备刷新/闪断后 60s 内凭 clientId 复活，星球回到原位、名字不丢 |
| 分享星系 | 顶栏一键生成邀请链接（`?key=坐标` 自动带入）与二维码，扫码即进 |
| 多文件发送 | 文件选择器/拖拽支持多文件批量，队列化顺序发送；截图后 Ctrl+V 直接粘贴发送 |
| 接收确认 | 私聊文件需对方确认（接受/拒收，30s 超时取消），支持"自动接收"免确认开关；发送中途可取消并同步通知对方清理 |
| 传输测速 | 收发两侧实时显示 MB/s 速度与预计剩余时间 |
| 会话状态 | 私聊标签实时圆点（绿=直连在线 / 蓝呼吸=握手中 / 琥珀=中转 / 灰=离线），连接模式徽标（WebRTC 直连 / 服务器中转），对方离开自动结束会话并置灰 |
| 后台通知 | 顶栏铃铛开启系统通知，页面在后台时收到消息弹提醒、标题累计未读数（回前台自动清零） |
| PWA | 支持添加到主屏幕/安装为应用（SW 仅作安装条件，不做资源缓存，保持零保存理念） |
| 跨端适配 | 手机/桌面响应式布局，非安全上下文（局域网 http）可正常使用 |

## 技术栈

- **前端**：Vue 3 `<script setup>` + TypeScript + Pinia + Vite，Canvas 2D 星系渲染
- **后端**：Node.js + Express + ws（WebSocket），tsx 直接运行 TS
- **传输**：WebRTC DataChannel（点对点）+ WebSocket（信令/广播/中转）

## 架构

```
starnet/
├── client/                      # 前端（Vue3 + TS + Vite）
│   └── src/
│       ├── App.vue              # 根组件：顶栏 / 星图画布 / 灯箱 / Toast
│       ├── api/socket.ts        # WebSocket 客户端（文本 JSON + 二进制帧、断线重连）
│       ├── webrtc/p2p.ts        # P2P 管理器：DataChannel 直发 / 中转降级 / 背压
│       ├── logic/wire.ts        # 消息路由：服务器事件 & P2P 载荷 → Pinia store
│       ├── stores/
│       │   ├── room.ts          # 房间状态：设备列表、身份记忆、clientId
│       │   └── chat.ts          # 会话与消息：广播/私聊、文件分片收发、SHA-256 链
│       ├── galaxy/scene.ts      # Canvas 星系渲染（恒星/行星/星环/卫星/流星/连线）
│       ├── utils/
│       │   ├── frame.ts         # 二进制分片帧 pack/parse
│       │   ├── opfs.worker.ts   # OPFS 落盘 Worker（FileSystemSyncAccessHandle）
│       │   ├── fileStore.ts     # 大文件接收仓库（OPFS + 内存降级 + 背压）
│       │   └── uid.ts           # 非安全上下文兼容的 UUID
│       ├── ui/lightbox.ts       # 图片灯箱状态（模块级单例）
│       └── components/          # JoinGate / ChatPanel / MessageCard / DeviceDrawer /
│                                # ConnectDialog / CosmicBg / ImageLightbox
└── server/                      # 服务端（Express + ws）
    ├── src/index.ts             # 房间/设备管理、广播转发、信令透传、二进制帧转发、
    │                            # 心跳清理（45s 超时 / 60s 幽灵保留 / 空房间回收）
    └── smoke.mjs                # 冒烟测试（15 项：入房/广播/二进制帧/信令/中转/离开通知等）
```

**数据流**：

```
广播：发送端 ──二进制分片帧──▶ 服务器（只转发不落盘）──▶ 全员
私聊：发送端 ──DataChannel 直发（首选）──▶ 对端
      └─打洞失败─▶ JSON+base64 ──p2p-relay──▶ 服务器转发 ──▶ 对端
信令：offer/answer/ICE 由服务器在两端之间透传
接收：分片 → Worker → OPFS 磁盘（边收边写）→ file-end 校验 → Blob URL 预览/下载
```

## 本地开发

```bash
# 1. 前端
cd client && npm install && npm run dev        # http://localhost:5173

# 2. 服务端
cd server && npm install && npm start          # http://localhost:3000

# 3. 生产构建（服务端托管 client/dist）
cd client && npm run build
```

**使用方式**：打开页面 → 输入星系坐标（3~5 位字母数字，可随机生成）与星球名称 → 进入星系。

- 在线设备即星图上的星球，点击星球可发起连接请求
- 底部聊天面板：左侧为星系广播，建立连接后出现私聊标签页
- 拖拽/选择文件即可发送（广播或私聊均可），图片自动生成预览

**冒烟测试**（需先启动服务端）：

```bash
cd server && node smoke.mjs
```

## 部署

### Docker（推荐）

```bash
# 方式一：源码构建
docker compose up -d --build

# 方式二：导入已导出的镜像包
docker load -i star-net-latest.tar
docker compose up -d
```

`docker-compose.yml` 默认映射 `3000:3000`，修改宿主端口只需改 `ports` 左侧；容器带健康检查与 `restart: unless-stopped`。

### 导出镜像

```bash
docker build -t star-net:latest --platform linux/amd64 .
docker save star-net:latest -o star-net-latest.tar
```

### 公网部署建议

- **务必套 HTTPS**（Nginx/Caddy 反代 + 域名证书）：http 明文环境下浏览器禁用 WebRTC 与 `crypto.subtle`，P2P 直连会全部退化为服务器中转，且无法做完整性校验
- 防火墙/安全组放行映射端口
- 服务器只做转发，不存储任何消息与文件内容，无持久化卷需求

## 通信协议

WebSocket 文本消息（JSON）主要类型：`join` / `room-state` / `device-join|leave|rename` / `bcast-text` / `bcast-file-offer|file-end`（含 `chk` 校验标记与 `hash` 哈希链）/ `connect-request|response` / `rtc-signal` / `p2p-relay` / `ping|pong`。

二进制帧（广播分片走 WS、私聊分片走 DataChannel，布局一致）：

```
[kind:1B][fileIdLen:1B][fileId:utf8][index:u32 BE][payload...]
kind=1 p2p-chunk   kind=2 bcast-chunk
```

- 广播 64KB/片，私聊 16KB/片；服务端单条消息上限 512KB，广播 offer 单文件上限 2GB
- 校验：`sha256(所有分片哈希按序拼接)`，随 `file-end` 下发，接收端重算比对

## 许可

本项目基于 [MIT License](./LICENSE) 开源。

- 任何人可以自由地使用、复制、修改、合并、发布、分发、再许可与销售本软件，唯一要求是在副本中保留原版权声明与许可声明
- 软件按「现状」提供，**不附带任何明示或默示的担保**；作者/版权持有人不对任何使用产生的损失承担责任
- 二次分发或基于本项目的衍生作品，请在显著位置保留原作者版权声明与本许可文本
