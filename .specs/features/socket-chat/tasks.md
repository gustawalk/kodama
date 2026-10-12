# Socket Chat Tasks

**Design**: `.specs/features/socket-chat/design.md`
**Status**: In Progress

## Test Coverage Matrix

> Generated from `src-tauri/src/engine.rs`, `examples/demo-server.test.js`, and the repository's Bun and Cargo commands. No additional testing guideline was found.

| Code Layer | Required Test Type | Coverage Expectation | Location Pattern | Run Command |
| --- | --- | --- | --- | --- |
| Native socket behavior | unit | Variable resolution and malformed JSON | `src-tauri/src/socket.rs` | `cargo test --offline` |
| UI integration | build | Request model and editor compile | `src/*.tsx` | `bun run build` |
| Demo protocol | integration | Both directions and invalid message | `examples/chat.test.js` | `bun test examples/chat.test.js` |

## Gate Check Commands

| Gate Level | When to Use | Command |
| --- | --- | --- |
| Targeted | Focused behavior | `bun test examples/chat.test.js` |
| Quick | Native task | `cargo test --offline` |
| Full | Demo integration | `bun test examples/chat.test.js && bun test examples/demo-server.test.js` |
| Build | Phase completion | `bun run build && cargo test --offline` |

## Execution Plan

### Phase 1: Socket feature

```
T1 → T2 → T3
```

## Task Breakdown

### T1: Native socket transport

**What**: Persist socket requests and manage WebSocket and Socket.IO connections in Rust.
**Where**: `src-tauri/src/socket.rs`
**Depends on**: None
**Requirement**: SOCK-01
**Tests**: Native payload resolution test in `socket.rs`.
**Gate**: Quick
**Status**: Complete

### T2: Socket editor and event log

**What**: Add a discoverable socket request type and an editor with live events.
**Where**: `src/SocketWorkbench.tsx`
**Depends on**: T1
**Requirement**: SOCK-02
**Tests**: Build and manual UI check against the demo.
**Gate**: Build
**Status**: Complete

### T3: Demo chat and sample collection

**What**: Add a shared chat across both transports and ready to import requests.
**Where**: `examples/chat.js`
**Depends on**: T2
**Requirement**: SOCK-03
**Tests**: Protocol integration test with both clients and malformed message.
**Gate**: Full
**Status**: Pending
