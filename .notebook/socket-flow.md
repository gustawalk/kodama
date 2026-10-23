# Socket testing flow

- Saved requests use `kind: websocket | socketio` and optional `socket` settings in `src/types.ts` and `src-tauri/src/model.rs`. Missing fields keep older HTTP workspaces readable.
- `src/SocketWorkbench.tsx` owns each tab's live session ID and event log. Switching tabs hides its component; closing it unmounts the component and invokes `disconnect_socket`. The Rust manager in `src-tauri/src/socket.rs` emits `socket-event` tagged with that ID.
- `src-tauri/src/socket.rs` limits outbound messages to 256 KiB and queues at most 32 WebSocket sends; a full queue returns a send error. Native emission trims large text and previews binary content before sending log events to the frontend.
- `socket.examples` stores saved messages. The dropdown loads event/format/payload into the composer; Save as new opens a name dialog, Update replaces only the selected preset, and draft edits stay independent. Socket.IO auth uses the same variable-aware `CodeEditor` as payloads.
- `examples/demo-server.js` serves HTTP, native WebSocket at `/chat/ws`, and Socket.IO at `/socket.io/` on one port. `examples/chat.js` broadcasts valid chat messages between both transports; `examples/demo-chat.kodama.json` imports a request for each.
- The integration test in `examples/chat.test.js` checks both directions, errors, and delivery to two WebSocket clients. Native tests check variable interpolation and import compatibility. Start with `bun examples/demo-server.js`, then import the chat JSON in Settings.

- Duplication and collection import conflict checks in `src/App.tsx` include saved-message and schedule IDs; duplicated requests regenerate these nested UUIDs.
- `socket.autoSenders` persists named enabled/interval/event/format/payload settings; absent arrays default to empty in Rust. Storage validates their UUIDs, intervals, names, and formats.
- `src/SocketAutoSenders.tsx` edits schedules in a dialog. `SocketWorkbench` serializes session-scoped `sync_socket_auto_senders` calls for configuration and current variable scopes; it never runs timers. Tab visibility does not affect schedules.
- `src-tauri/src/socket.rs:AutoSession::reconcile()` retains unchanged tasks (including suspended ones), restarts changed tasks, and aborts disabled/deleted tasks. Each task reads the latest input scopes at each tick and overrides only its message fields. Native timers wait a full interval and skip missed ticks; a failed send suspends its task until config changes or a fresh connection.
- `SocketManager::remove()` removes the connection and scheduler. All close/error/explicit disconnect paths use it; task drops abort timers. `OutgoingMessage` carries auto-sender provenance through WebSocket queue failures.
- Socket.IO's library connect call returns before namespace acknowledgement. The native command waits for the `open` callback with a shared handshake deadline before registering the client, starting schedules, and announcing Connected. Close/error callbacks also reject the pending handshake.
- `SocketEvent` carries optional `autoSenderId`/`autoSenderName`; the UI preserves them through pending/paused buffers and copied logs. No extra synthetic sent log is added by the scheduler. Resume captures the buffered array before clearing its ref, so deferred React updates cannot discard paused events.

- Log scrolling in `SocketWorkbench` consumes a one-time event ID from a newly flushed manual `sent` entry. Automatic sends, incoming replies, statuses, tab activation, and resuming a paused log do not request scrolling. `overflow-anchor: none` keeps the browser from following appended entries independently. The composer action is labeled Send event.
- `src/SocketWorkbench.css` hides background workbench scrollbars while a Radix dialog overlay is mounted, including exit animations. This avoids lingering WebKit overlay scrollbars appearing over the dialog; portaled dialog scrollbars are unaffected.

Updated: 2026-10-22. Validation: paused-time Rust scheduler tests, storage round-trip checks, demo cross-protocol integration tests, and a Playwright UI pass using mocked IPC (native scheduler tested separately).
