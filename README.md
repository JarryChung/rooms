# Private Channel

一个基于 WebRTC DataChannel 的浏览器端 P2P 私聊示例。项目使用一个很小的 Node.js WebSocket 服务作为信令服务器，用来交换 SDP、ICE Candidate 和房间成员信息；聊天消息与文件内容在浏览器之间通过 WebRTC 数据通道直连传输。

## 功能

- 4 位房间号加入与分享链接
- 自动生成并保存昵称
- 多人房间内点对点文字聊天
- P2P 文件传输，单文件最大 20 MB
- 图片文件预览与下载
- 多套界面主题
- 调试日志面板
- 建连成功后自动释放信令连接，保持已有 P2P 通道
- 页面失焦时的浏览器通知提示

## 环境要求

- Node.js 18+
- pnpm 10+

## 快速开始

```bash
pnpm install
pnpm start
```

启动后打开：

```text
http://localhost:8080
```

在两个浏览器标签页或两台设备上打开同一个房间链接，即可测试聊天和文件传输。

## Cloudflare Workers 部署

当前仓库已经包含一个 Workers 入口：

```text
src/worker.js      # Workers WebSocket 信令服务
public/index.html  # Workers 静态页面入口
wrangler.jsonc     # Wrangler 配置
```

本地预览：

```bash
pnpm dev:worker
```

部署：

```bash
pnpm deploy:worker
```

Workers 版本使用全局 `Map` 保存房间和 WebSocket 连接，没有使用 Durable Objects。这适合演示或低流量临时房间，但它不是跨实例共享状态：不同边缘节点、不同 Worker isolate、重新部署或 isolate 回收后，内存房间都可能不可见或消失。

## 使用方式

1. 打开页面后输入或使用自动生成的 4 位房间号。
2. 输入昵称，点击“加入”。
3. 点击“分享”复制当前房间链接，发给另一位用户。
4. 对方加入同一房间后，浏览器会通过信令服务器交换 WebRTC 连接信息。
5. P2P 数据通道建立后，可以发送文字消息或选择文件发送。
6. 已经建立连接后，页面会自动释放信令连接；已有聊天和文件传输通道会继续保留。

## 项目结构

```text
.
├── index.html      # 前端页面、样式和 WebRTC/DataChannel 逻辑
├── server.js       # HTTP 静态服务与 WebSocket 信令服务
├── package.json    # 项目依赖
└── pnpm-lock.yaml  # pnpm 锁文件
```

## 工作原理

`server.js` 监听 `8080` 端口，同时提供 `index.html` 和 WebSocket 信令服务。Workers 部署时由 `src/worker.js` 处理 `/ws` 信令连接，并由 `public/index.html` 提供页面。用户加入房间后，服务端会维护房间内的临时连接列表，并在用户之间转发以下信令消息：

- `join`：加入房间
- `peers`：返回房间内已有用户
- `peer-joined` / `peer-left` / `peer-detached`：同步用户状态
- `offer` / `answer` / `candidate`：转发 WebRTC 建连所需信息
- `detach-signal`：从信令房间中移除当前连接

浏览器端在收到房间成员信息后创建 `RTCPeerConnection`，通过信令服务完成协商。连接成功后，文字消息、昵称信息和文件分片都会走 `RTCDataChannel`，不再经过 Node 服务。

## 注意事项

- 本项目用于本地学习和演示，没有实现账号、鉴权、持久化或端到端身份校验。
- 局域网或公网环境下使用时，可能需要配置 HTTPS、TURN/STUN 服务和防火墙规则。
- 当前默认使用 Google 公共 STUN 服务；在受限网络里直连可能失败。
- 文件传输限制为 20 MB，传输过程中不要关闭页面。

## 常见问题

### 页面打不开

确认服务已经启动，并访问 `http://localhost:8080`。

### 两个用户无法连上

先确认双方加入的是同一个 4 位房间号。若跨网络访问，请检查页面地址是否可互通，以及当前网络是否允许 WebRTC P2P 连接。

### 文件发送失败

确认已经至少有一个 P2P 通道处于可用状态，并且文件大小不超过 20 MB。
