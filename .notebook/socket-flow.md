# Socket testing flow

- Saved requests use `kind: websocket | socketio` and optional `socket` settings in `src/types.ts` and `src-tauri/src/model.rs`. Missing fields keep older HTTP workspaces readable.
- `src/SocketWorkbench.tsx` owns each tab's live session ID and event log. Switching tabs hides its component; closing it unmounts the component and invokes `disconnect_socket`. The Rust manager in `src-tauri/src/socket.rs` emits `socket-event` tagged with that ID.
- `src-tauri/src/socket.rs` limits outbound messages to 256 KiB and queues at most 32 WebSocket sends; a full queue returns a send error. Native emission trims large text and previews binary content before sending log events to the frontend.
- `socket.examples` stores named message examples. Loading an example copies its event, format, and payload into the active composer. Sending always reads those active fields, so draft edits can be sent without overwriting a saved example.
- `examples/demo-server.js` serves HTTP, native WebSocket at `/chat/ws`, and Socket.IO at `/socket.io/` on one port. `examples/chat.js` broadcasts valid chat messages between both transports; `examples/demo-chat.kodama.json` imports a request for each.
- The integration test in `examples/chat.test.js` checks both directions, errors, and delivery to two WebSocket clients. Native tests check variable interpolation and import compatibility. Start with `bun examples/demo-server.js`, then import the chat JSON in Settings.
