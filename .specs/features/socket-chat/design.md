# Socket Chat Design

Kodama keeps saved requests in the existing collection array. The optional `kind` and `socket` fields preserve old HTTP workspaces. The Rust backend owns connection state and emits events tagged with a unique tab session ID. WebSocket uses `tokio-tungstenite`; Socket.IO uses `rust_socketio`. UI components subscribe to events, keep a bounded session log, and close connections on unmount. The demo uses Bun's native WebSocket server and the official Socket.IO Bun engine on the same loopback port.

Connection settings resolve Kodama variables before a handshake. Payloads resolve variables at send time. Each open tab has an independent connection; switching tabs leaves it connected. Closing a tab or workspace disconnects it. Socket.IO uses an explicit path and namespace. Reconnect is manual.

Named message examples live in the optional `socket.examples` array. Loading one copies its event, format, and payload into the active composer fields; the active fields remain the source for sending. Older socket requests without examples keep loading through Serde defaults.
