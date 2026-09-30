const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { WebSocketServer, WebSocket } = require("ws");

const PORT = 8080;

/*
 * rooms 的结构：
 *
 * Map {
 *   "room-id" => Map {
 *      "client-id-1" => WebSocket,
 *      "client-id-2" => WebSocket
 *   }
 * }
 */
const rooms = new Map();

function send(ws, message) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

function broadcast(room, message, exceptClientId = null) {
  for (const [clientId, client] of room.entries()) {
    if (clientId !== exceptClientId) {
      send(client, message);
    }
  }
}

function normalizeNickname(value, fallback) {
  const nickname = String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 24);

  return nickname || fallback;
}

function normalizeRoomId(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, "")
    .slice(0, 4);
}

function isValidRoomId(roomId) {
  return /^[0-9A-Z]{4}$/.test(roomId);
}

function leaveRoom(ws, { notify = true } = {}) {
  if (!ws.roomId) return;

  const room = rooms.get(ws.roomId);

  if (room) {
    room.delete(ws.clientId);

    if (notify) {
      // 通知其他人：有人离开了
      broadcast(room, {
        type: "peer-left",
        peerId: ws.clientId,
        nickname: ws.nickname,
      });
    }

    if (room.size === 0) {
      rooms.delete(ws.roomId);
    }
  }

  ws.roomId = null;
}

// 简单提供 index.html 文件
const server = http.createServer((req, res) => {
  const requestUrl = new URL(req.url, "http://localhost");

  if (
    requestUrl.pathname === "/" ||
    requestUrl.pathname === "/index.html"
  ) {
    const filePath = path.join(__dirname, "index.html");

    fs.readFile(filePath, (error, data) => {
      if (error) {
        res.writeHead(500);
        res.end("无法读取 index.html");
        return;
      }

      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
      });

      res.end(data);
    });

    return;
  }

  res.writeHead(404);
  res.end("Not Found");
});

// 创建 WebSocket 信令服务器
const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  // 当前示例中，服务端临时生成用户 ID。
  // 真实项目中通常由登录态、JWT 或 Session 得到用户身份。
  ws.clientId = crypto.randomUUID();
  ws.roomId = null;
  ws.nickname = "";

  console.log(`客户端连接：${ws.clientId}`);

  ws.on("message", (rawData) => {
    let message;

    try {
      message = JSON.parse(rawData.toString());
    } catch {
      send(ws, {
        type: "error",
        message: "消息不是合法 JSON",
      });
      return;
    }

    // 加入房间
    if (message.type === "join") {
      const roomId = normalizeRoomId(message.roomId);

      if (!isValidRoomId(roomId)) {
        send(ws, {
          type: "error",
          message: "房间号必须是 4 位数字或大写字母",
        });
        return;
      }

      // 如果之前加入过其他房间，先离开
      leaveRoom(ws);

      ws.nickname = normalizeNickname(
        message.nickname,
        `用户-${ws.clientId.slice(0, 4)}`
      );

      let room = rooms.get(roomId);

      if (!room) {
        room = new Map();
        rooms.set(roomId, room);
      }

      // 加入前已有的用户列表
      const existingPeers = [...room.entries()].map(
        ([peerId, peer]) => ({
          id: peerId,
          nickname: peer.nickname,
        })
      );

      const existingPeerIds = existingPeers.map((peer) => peer.id);

      ws.roomId = roomId;
      room.set(ws.clientId, ws);

      console.log(`${ws.clientId} 加入房间 ${roomId}`);

      // 告诉新用户：房间里有哪些已存在的人。
      // 新用户将主动向这些人创建 Offer。
      send(ws, {
        type: "peers",
        peerId: ws.clientId,
        nickname: ws.nickname,
        peerIds: existingPeerIds,
        peers: existingPeers,
      });

      // 通知已有用户，仅用于日志展示。
      broadcast(
        room,
        {
          type: "peer-joined",
          peerId: ws.clientId,
          nickname: ws.nickname,
        },
        ws.clientId
      );

      return;
    }

    // 除 join 外，其余消息必须已在房间中
    if (!ws.roomId) {
      send(ws, {
        type: "error",
        message: "请先加入房间",
      });
      return;
    }

    if (message.type === "detach-signal") {
      const room = rooms.get(ws.roomId);

      leaveRoom(ws, {
        notify: false,
      });

      send(ws, {
        type: "signal-detached",
      });

      if (room) {
        broadcast(room, {
          type: "peer-detached",
          peerId: ws.clientId,
          nickname: ws.nickname,
        });
      }

      return;
    }

    const allowedSignalTypes = ["offer", "answer", "candidate"];

    if (!allowedSignalTypes.includes(message.type)) {
      return;
    }

    const room = rooms.get(ws.roomId);
    const target = room?.get(message.to);

    if (!target) {
      send(ws, {
        type: "error",
        message: `目标用户不存在或已经离开：${message.to}`,
      });
      return;
    }

    /*
     * 信令服务器不理解 SDP 或 ICE Candidate 的具体含义，
     * 它只负责把消息从发送方转发给目标用户。
     */
    send(target, {
      type: message.type,
      from: ws.clientId,
      fromNickname: ws.nickname,
      sdp: message.sdp,
      candidate: message.candidate,
    });
  });

  ws.on("close", () => {
    console.log(`客户端断开：${ws.clientId}`);
    leaveRoom(ws);
  });

  ws.on("error", (error) => {
    console.error(`WebSocket 错误：${ws.clientId}`, error.message);
  });
});

server.listen(PORT, () => {
  console.log(`服务器已启动：http://localhost:${PORT}`);
});
