const MAX_ROOM_PEERS = 8;
const MAX_SIGNAL_CHARS = 256 * 1024;
const WS_OPEN = 1;
const ALLOWED_SIGNAL_TYPES = new Set(["offer", "answer", "candidate"]);

/*
 * This is intentionally process-local state.
 *
 * On Cloudflare Workers this Map lives only inside the currently running
 * isolate. It is fine for demos and small best-effort deployments, but it is
 * not shared across isolates, data centers, deploys, or isolate restarts.
 */
const rooms = new Map();
const socketState = new WeakMap();

function send(ws, message) {
  if (ws.readyState === WS_OPEN) {
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

function getState(ws) {
  return socketState.get(ws);
}

function leaveRoom(ws, { notify = true } = {}) {
  const state = getState(ws);

  if (!state?.roomId) return;

  const room = rooms.get(state.roomId);

  if (room) {
    room.delete(state.clientId);

    if (notify) {
      broadcast(room, {
        type: "peer-left",
        peerId: state.clientId,
        nickname: state.nickname,
      });
    }

    if (room.size === 0) {
      rooms.delete(state.roomId);
    }
  }

  state.roomId = null;
}

function getEventText(data) {
  if (typeof data === "string") {
    return data;
  }

  if (data instanceof ArrayBuffer) {
    return new TextDecoder().decode(data);
  }

  return "";
}

function handleJoin(ws, message) {
  const state = getState(ws);
  const roomId = normalizeRoomId(message.roomId);

  if (!isValidRoomId(roomId)) {
    send(ws, {
      type: "error",
      message: "房间号必须是 4 位数字或大写字母",
    });
    return;
  }

  leaveRoom(ws);

  state.nickname = normalizeNickname(
    message.nickname,
    `用户-${state.clientId.slice(0, 4)}`
  );

  let room = rooms.get(roomId);

  if (!room) {
    room = new Map();
    rooms.set(roomId, room);
  }

  if (room.size >= MAX_ROOM_PEERS) {
    send(ws, {
      type: "error",
      message: `房间人数已达上限：${MAX_ROOM_PEERS}`,
    });
    return;
  }

  const existingPeers = [...room.entries()].map(([peerId, peer]) => ({
    id: peerId,
    nickname: getState(peer)?.nickname || "未知用户",
  }));

  const existingPeerIds = existingPeers.map((peer) => peer.id);

  state.roomId = roomId;
  room.set(state.clientId, ws);

  send(ws, {
    type: "peers",
    peerId: state.clientId,
    nickname: state.nickname,
    peerIds: existingPeerIds,
    peers: existingPeers,
  });

  broadcast(
    room,
    {
      type: "peer-joined",
      peerId: state.clientId,
      nickname: state.nickname,
    },
    state.clientId
  );
}

function handleSignal(ws, message) {
  const state = getState(ws);

  if (!state?.roomId) {
    send(ws, {
      type: "error",
      message: "请先加入房间",
    });
    return;
  }

  if (message.type === "detach-signal") {
    const room = rooms.get(state.roomId);
    const peerId = state.clientId;
    const nickname = state.nickname;

    leaveRoom(ws, {
      notify: false,
    });

    send(ws, {
      type: "signal-detached",
    });

    if (room) {
      broadcast(room, {
        type: "peer-detached",
        peerId,
        nickname,
      });
    }

    return;
  }

  if (!ALLOWED_SIGNAL_TYPES.has(message.type)) {
    return;
  }

  const room = rooms.get(state.roomId);
  const target = room?.get(String(message.to || ""));

  if (!target) {
    send(ws, {
      type: "error",
      message: `目标用户不存在或已经离开：${message.to}`,
    });
    return;
  }

  send(target, {
    type: message.type,
    from: state.clientId,
    fromNickname: state.nickname,
    sdp: message.sdp,
    candidate: message.candidate,
  });
}

function handleWebSocket(request) {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return new Response("Expected WebSocket upgrade", {
      status: 426,
    });
  }

  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);

  server.accept();

  socketState.set(server, {
    clientId: crypto.randomUUID(),
    roomId: null,
    nickname: "",
  });

  server.addEventListener("message", (event) => {
    const text = getEventText(event.data);

    if (!text || text.length > MAX_SIGNAL_CHARS) {
      send(server, {
        type: "error",
        message: "信令消息过大或格式不正确",
      });
      return;
    }

    let message;

    try {
      message = JSON.parse(text);
    } catch {
      send(server, {
        type: "error",
        message: "消息不是合法 JSON",
      });
      return;
    }

    if (message.type === "join") {
      handleJoin(server, message);
      return;
    }

    handleSignal(server, message);
  });

  server.addEventListener("close", () => {
    leaveRoom(server);
    socketState.delete(server);
  });

  server.addEventListener("error", () => {
    leaveRoom(server);
    socketState.delete(server);
  });

  return new Response(null, {
    status: 101,
    webSocket: client,
  });
}

export default {
  fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/ws") {
      return handleWebSocket(request);
    }

    return env.ASSETS.fetch(request);
  },
};
