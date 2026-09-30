const MAX_ROOM_PEERS = 8;
const MAX_SIGNAL_CHARS = 256 * 1024;
const WS_OPEN = 1;
const ALLOWED_SIGNAL_TYPES = new Set(["offer", "answer", "candidate"]);

const localContext = {
  rooms: new Map(),
  socketState: new WeakMap(),
};

/*
 * This is intentionally process-local state.
 *
 * On Cloudflare Workers this Map lives only inside the currently running
 * isolate. It is fine for demos and small best-effort deployments, but it is
 * not shared across isolates, data centers, deploys, or isolate restarts.
 */
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

function getState(context, ws) {
  return context.socketState.get(ws);
}

function leaveRoom(context, ws, { notify = true } = {}) {
  const state = getState(context, ws);

  if (!state?.roomId) return;

  const room = context.rooms.get(state.roomId);

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
      context.rooms.delete(state.roomId);
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

function handleJoin(context, ws, message) {
  const state = getState(context, ws);
  const roomId = normalizeRoomId(message.roomId);

  if (!isValidRoomId(roomId)) {
    send(ws, {
      type: "error",
      message: "房间号必须是 4 位数字或大写字母",
    });
    return;
  }

  if (state.expectedRoomId && roomId !== state.expectedRoomId) {
    send(ws, {
      type: "error",
      message: "房间号与信令连接不匹配，请刷新页面后重试",
    });
    return;
  }

  leaveRoom(context, ws);

  state.nickname = normalizeNickname(
    message.nickname,
    `用户-${state.clientId.slice(0, 4)}`
  );

  let room = context.rooms.get(roomId);

  if (!room) {
    room = new Map();
    context.rooms.set(roomId, room);
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
    nickname: getState(context, peer)?.nickname || "未知用户",
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

function handleSignal(context, ws, message) {
  const state = getState(context, ws);

  if (!state?.roomId) {
    send(ws, {
      type: "error",
      message: "请先加入房间",
    });
    return;
  }

  if (message.type === "detach-signal") {
    const room = context.rooms.get(state.roomId);
    const peerId = state.clientId;
    const nickname = state.nickname;

    leaveRoom(context, ws, {
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

  const room = context.rooms.get(state.roomId);
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

function handleWebSocket(request, context, expectedRoomId = null) {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return new Response("Expected WebSocket upgrade", {
      status: 426,
    });
  }

  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);

  server.accept();

  context.socketState.set(server, {
    clientId: crypto.randomUUID(),
    expectedRoomId,
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
      handleJoin(context, server, message);
      return;
    }

    handleSignal(context, server, message);
  });

  server.addEventListener("close", () => {
    leaveRoom(context, server);
    context.socketState.delete(server);
  });

  server.addEventListener("error", () => {
    leaveRoom(context, server);
    context.socketState.delete(server);
  });

  return new Response(null, {
    status: 101,
    webSocket: client,
  });
}

export class Room {
  constructor() {
    this.context = {
      rooms: new Map(),
      socketState: new WeakMap(),
    };
  }

  fetch(request) {
    const url = new URL(request.url);
    const roomId = normalizeRoomId(url.searchParams.get("r"));

    if (!isValidRoomId(roomId)) {
      return new Response("Missing or invalid room id", {
        status: 400,
      });
    }

    return handleWebSocket(request, this.context, roomId);
  }
}

export default {
  fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/ws") {
      const roomId = normalizeRoomId(url.searchParams.get("r"));

      if (env.ROOMS && isValidRoomId(roomId)) {
        const id = env.ROOMS.idFromName(roomId);
        return env.ROOMS.get(id).fetch(request);
      }

      return handleWebSocket(request, localContext);
    }

    return env.ASSETS.fetch(request);
  },
};
