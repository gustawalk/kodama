import { test, expect } from "bun:test";
import { io } from "socket.io-client";
import { createDemoServer } from "./demo-server.js";

const waitFor = (subscribe, timeout = 3000) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Chat event timed out")), timeout);
    subscribe((value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });

test("WebSocket and Socket.IO clients share the demo chat, with clear errors", async () => {
  const { server, chat } = createDemoServer(0);
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/chat/ws`);
  const socket = io(`http://127.0.0.1:${server.port}/chat`, {
    transports: ["websocket"],
    reconnection: false,
  });
  try {
    const welcome = await waitFor((done) =>
      ws.addEventListener("message", (event) => done(JSON.parse(event.data)), { once: true }),
    );
    expect(welcome.type).toBe("welcome");
    await waitFor((done) => socket.once("connect", done));
    const fromSocketIo = waitFor((done) =>
      ws.addEventListener("message", (event) => done(JSON.parse(event.data)), { once: true }),
    );
    const ownEcho = waitFor((done) => socket.once("chat:message", done));
    socket.emit("chat:send", { name: "Ada", text: "Hello from Socket.IO" });
    expect(await fromSocketIo).toMatchObject({
      type: "message",
      name: "Ada",
      text: "Hello from Socket.IO",
    });
    expect(await ownEcho).toMatchObject({ name: "Ada", text: "Hello from Socket.IO" });
    const fromWebSocket = waitFor((done) => socket.once("chat:message", done));
    const ownWebSocketEcho = waitFor((done) =>
      ws.addEventListener("message", (event) => done(JSON.parse(event.data)), { once: true }),
    );
    ws.send(JSON.stringify({ name: "Lin", text: "Hello from WebSocket" }));
    expect(await fromWebSocket).toMatchObject({ name: "Lin", text: "Hello from WebSocket" });
    expect(await ownWebSocketEcho).toMatchObject({
      type: "message",
      name: "Lin",
      text: "Hello from WebSocket",
    });
    const invalid = waitFor((done) => socket.once("chat:error", done));
    socket.emit("chat:send", { name: "Ada", text: "" });
    expect((await invalid).message).toContain("1–500");
    const invalidWebSocket = waitFor((done) =>
      ws.addEventListener("message", (event) => done(JSON.parse(event.data)), { once: true }),
    );
    ws.send(JSON.stringify({ name: "Lin", text: "x".repeat(501) }));
    expect(await invalidWebSocket).toMatchObject({
      type: "error",
      message: expect.stringContaining("1–500"),
    });
  } finally {
    ws.close();
    socket.disconnect();
    await chat.io.close();
    server.stop(true);
  }
});
