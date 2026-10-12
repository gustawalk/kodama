import { Server as Engine } from "@socket.io/bun-engine";
import { Server } from "socket.io";

export function createChatModule() {
  const engine = new Engine({ path: "/socket.io/" });
  const io = new Server();
  io.bind(engine);
  const namespace = io.of("/chat");
  const websocketClients = new Set();
  const engineWebsocket = engine.handler().websocket;

  const normalize = (value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const text = typeof value.text === "string" ? value.text.trim() : "";
    const name = typeof value.name === "string" ? value.name.trim() : "Guest";
    if (!text || text.length > 500 || !name || name.length > 32) return null;
    return { name, text, sentAt: new Date().toISOString() };
  };
  const broadcast = (message) => {
    namespace.emit("chat:message", message);
    const frame = JSON.stringify({ type: "message", ...message });
    for (const client of websocketClients) client.send(frame);
  };
  namespace.on("connection", (socket) => {
    socket.emit("chat:welcome", {
      message: "Send chat:send with {name, text}",
      online: websocketClients.size + namespace.sockets.size,
    });
    socket.on("chat:send", (value) => {
      const message = normalize(value);
      if (!message) {
        socket.emit("chat:error", { message: "Send {name, text}; text must be 1–500 characters" });
        return;
      }
      broadcast(message);
    });
  });

  return {
    io,
    engine,
    websocket: {
      ...engineWebsocket,
      open(ws) {
        if (ws.data?.kind !== "raw-chat") {
          engineWebsocket.open(ws);
          return;
        }
        websocketClients.add(ws);
        ws.send(
          JSON.stringify({
            type: "welcome",
            message: "Send JSON with {name, text}",
            online: websocketClients.size + namespace.sockets.size,
          }),
        );
      },
      message(ws, frame) {
        if (ws.data?.kind !== "raw-chat") {
          engineWebsocket.message(ws, frame);
          return;
        }
        let value;
        try {
          value = JSON.parse(String(frame));
        } catch {
          value = null;
        }
        const message = normalize(value);
        if (!message) {
          ws.send(
            JSON.stringify({
              type: "error",
              message: "Send {name, text}; text must be 1–500 characters",
            }),
          );
          return;
        }
        broadcast(message);
      },
      close(ws, code, reason) {
        if (ws.data?.kind !== "raw-chat") {
          engineWebsocket.close(ws, code, reason);
          return;
        }
        websocketClients.delete(ws);
      },
    },
  };
}
