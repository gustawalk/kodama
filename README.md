# Kodama

Kodama is a local-first desktop HTTP client for saving, organizing, and running
REST requests. It uses a React web interface in a Tauri 2 desktop window. HTTP
requests and JavaScript scripts run in Rust, outside the WebView.

## Quick start

Requirements: Bun, Rust, and the
[Tauri 2 system prerequisites](https://v2.tauri.app/start/prerequisites/) for
your operating system.

```sh
bun install
bun run tauri dev
```

The starter workspace includes a **Kodama demo** collection. In another
terminal, run:

```sh
bun examples/demo-server.js
```

In Kodama, run **Login** and then **Protected route**. Login's post-response
script saves the returned token to `_.TOKEN`; Protected route uses
`Bearer {{_.TOKEN}}`. Run Login again to replace the token without editing
Protected route. The demo server listens only on `127.0.0.1:8787` and accepts
`demo` / `demo`.

For a production build on the current host:

```sh
bun run tauri build
```

## Features

- Collections, folders, saved requests, tabs, search, duplication, ordering
  controls, and session history.
- HTTP methods, URL and query parameters, enabled headers, Basic and Bearer
  auth, JSON/text bodies, URL-encoded forms, and text multipart fields.
- Response status, headers, formatted JSON/text, timing, size, and binary
  download.
- Per-request timeout (30 seconds by default), up to ten redirects, and normal
  TLS certificate verification.
- Pre-request and post-response JavaScript scripts with limited APIs and runtime
  variables.
- Environments, collection variables, global defaults, and a variable inspector.
- Versioned Kodama JSON import/export with merge or replace. Imported scripts
  remain disabled until individually trusted.
- Local autosave and light/dark themes. Press Ctrl/Cmd+Enter to send and
  Ctrl/Cmd+S to save.

## Variables and scripts

The exact reference syntax is `{{NAME}}` in URL, query, headers, auth fields,
and body. `{{_.TOKEN}}` refers specifically to the runtime/session scope. A
missing reference blocks the request. For unqualified names, precedence is
**runtime > active environment > collection > default**.

Scripts are JavaScript evaluated in a separate Boa engine in Rust. They do not
have browser, filesystem, or network APIs. Each script gets:

- `_`: mutable object containing resolved variables. Changed properties become
  runtime variables only if the script finishes successfully.
- `request`: mutable request object. Pre-request changes are used for the
  outgoing request.
- `response` (post-response only): `status`, `headers`, `text()`, and `json()`.

Example post-response script:

```js
_.TOKEN = response.json().token;
```

The request flow is: choose scopes, run pre-request script, interpolate all
fields, validate, send, run post-response script, then commit staged runtime
changes. If a script fails, its writes are discarded and an error appears in the
response area. Scripts are limited to 64 KiB of source, 100,000 loop iterations,
128 recursion levels, and 1 MiB of response body passed to a post-response
script. This is Kodama's own script API; Postman script compatibility is not
implied.

## Import, export, and local data

Kodama JSON version 1 is the canonical local format. Exports include UUIDs,
collections, folders, requests, variables, environments, auth configuration, and
scripts. To move the login workflow to another computer, export, import, review
and trust the imported Login script, then run Login to populate the new
session's `_.TOKEN`.

Runtime variables are session-only and are never exported. Values marked
**Secret** are masked and stripped from local saves and exports; enter them
again after reopening Kodama. Literal Basic passwords, Bearer tokens, and
Authorization/Cookie header values are also stripped from saves and exports.
Variable references in those fields are preserved. Other request text and
scripts can contain user-entered sensitive content and are exported as written,
so inspect a file before sharing it.

Kodama stores the workspace in Tauri's per-user app-data directory as
`kodama.json`. Writes use a temporary file and rename. Import validates the
format version and UUIDs. Merge keeps current data when UUIDs collide; Replace
uses the imported workspace. Imported scripts never execute during import.

## Current limits

The MVP covers REST over HTTP/HTTPS. It does not yet provide GraphQL, gRPC,
WebSocket, cloud sync, Postman file compatibility, cookie jar management, proxy
settings, multipart file attachments, or an operating-system keychain. On this
release, secret values must be re-entered after restart. The script engine has
operation/size limits but no hard wall-clock kill for every possible JavaScript
expression. Native builds are verified on Linux; Windows and macOS builds
require their respective hosts and Tauri prerequisites.

## Development checks

```sh
bun run build
cd src-tauri && cargo test --lib && cargo check
```

The Rust tests cover variable precedence, unresolved runtime references, script
success/failure and loop limits, export round trip, and the login → protected
request workflow against a local HTTP server.
