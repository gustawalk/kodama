# Performance audit — 2026-10-13

## Measurements

- Against the local Bun demo `/health` endpoint, a temporary Rust probe made 200 sequential warm requests through `engine::execute_with_jar` and 200 through a reused `reqwest::Client`, alternating their order. In an optimized release build, median wall times were **10.876 ms** and **0.123 ms** respectively (p95 **13.714 ms** and **0.166 ms**). This comparison excludes Tauri IPC and frontend rendering; the reused-client control also excludes Kodama's request preparation.
- A debug probe isolated client creation: a fresh `reqwest::Client` plus send took **9.872 ms** median, of which `Client::builder().build()` took **9.248 ms**. Kodama's full request path took **10.621 ms** median in that run. Client construction is the dominant measured local overhead.
- The current release desktop build with an empty isolated workspace idled at **291.8 MiB total PSS** across Kodama and its WebKit child processes on Linux. Over ten seconds, Kodama used **0.1% of one CPU core** and the WebKit children rounded to **0.0%**. This is a baseline, not a loaded-workspace peak or a cross-platform estimate.
- A Bun synthetic `structuredClone` probe of a store with one collection took **0.26 ms** median for 100 requests, **2.78 ms** for 1,000, and **14.26 ms** for 5,000. It excludes React rendering and uses Bun rather than the desktop WebKit engine, so it only indicates scaling direction.

## Code paths to revisit

1. `src-tauri/src/engine.rs:290` constructs a new `reqwest::Client` for each send. Preserve shared cookies and per-request timeouts while reusing a client; measure both local and HTTPS paths before shipping a change.
2. `src-tauri/src/engine.rs:410` reads every response fully, then copies bytes for UTF-8 conversion. `src/App.tsx:808` parses and pretty-prints the complete response. Large bodies can occupy several copies across Rust, IPC, React state, and CodeMirror.
3. `src/SocketWorkbench.tsx:84` updates React state per event and keeps 500 events without a byte cap; `src/SocketWorkbench.tsx:579` parses and formats each visible payload during render. `src-tauri/src/socket.rs:190` uses an unbounded outbound channel. High message rates or large payloads can grow CPU and memory use.
4. `src/App.tsx:840` clones the full store on each request edit, including each editor keystroke. Search and sidebar derivations depending on the collection array also rerun. Consider scoped immutable updates or a request-local editing draft when large workspaces become a supported use case.
5. `src-tauri/src/engine.rs:372` starts the displayed elapsed timer after client setup and request preparation; it stops before the post-response script. The shown time is narrower than user-perceived send-to-render latency.

The probe source was temporary and removed after measurement. No product code changed during this audit.

## Follow-up — 2026-10-14

- The desktop session now reuses a `reqwest::Client` and its connection pool. Clearing cookies replaces both the jar and client; each request still sets its own timeout. The displayed elapsed time now starts before client acquisition and ends after response processing.
- A temporary debug-build probe against the same local `/health` endpoint alternated 200 warm requests through a fresh client and 200 through a shared client. Fresh-client median/p95 was **11.074/12.687 ms**; shared-client median/p95 was **0.437/0.508 ms**. This measures the Rust request path, not Tauri IPC, frontend rendering, or remote server latency. The probe was removed afterward.
- The socket event log now formats payloads on arrival, batches visible state updates into animation frames, and limits each retained payload to 16,384 characters and each queue to 500 events. Larger payloads show a truncation notice in the log. This bounds retained log memory, but the transport can still deliver a large message before the log truncates it.
- Full HTTP response buffering, large-workspace cloning, and the socket backend's unbounded outbound queue remain candidates for later work. They need explicit product limits or workload measurements before changing behavior.
