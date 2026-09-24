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

- Collections, folders, saved requests, tabs, search, duplication, drag ordering,
  and expandable session history with URL, timestamp, size, and response access.
- HTTP methods, `:id` path parameters, URL and query parameters, enabled headers, Basic and Bearer
  auth, JSON/text bodies, URL-encoded forms, and text multipart fields.
- Response status, headers, formatted JSON/text, timing, size, and binary
  download. Search and copy response text, and inspect session cookies.
- Per-request timeout (30 seconds by default), up to ten redirects, and normal
  TLS certificate verification.
- Pre-request and post-response JavaScript scripts with limited APIs and runtime
  variables.
- Environments, collection variables, global defaults, and an editable runtime
  variable inspector. Response headers can be saved to runtime variables from
  the Headers response tab.
- Variable suggestions appear while typing `{{...}}`; ten are visible before
  scrolling. Hover a suggestion or variable to see its value.
- JSON is the default body mode for new requests. The body and script editors
  use CodeMirror for syntax highlighting, indentation with Tab, and JSON
  diagnostics. Empty JSON bodies send no body. Use **Format JSON** to pretty-print.
- Versioned Kodama JSON import/export with merge or replace. Imported scripts
  remain disabled until individually trusted.
- Import common cURL commands and copy a saved request as cURL. Import OpenAPI
  3 or Swagger 2 JSON to create requests with paths, parameters, headers, and
  example request bodies.
- Link a collection to an OpenAPI JSON, JavaScript, or TypeScript source file in
  **Collection settings**. Kodama checks the file every five seconds while open.
  Normal sync adds routes and updates untouched imported fields while keeping
  local edits. **Replace collection** restores the whole collection from the
  current source file after confirmation.
- A session cookie jar carries cookies between requests and can be cleared from
  the response Cookies tab.
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
- `response` (post-response only): `status`, `headers`, `text()`, `json()`, and
  `header(name)` for case insensitive response header lookup.

Example post-response script:

```js
_.TOKEN = response.json().token;
_.NEXT = response.header("X-Next-Token");
```

Use `:id` in a URL path, such as `/products/:id`, to create a Path parameters
field in the Params tab. Kodama URL encodes its value before sending. Query
parameters remain separate rows in the same tab. For generated sample data,
use `{{$random.uuid}}`, `{{$random.firstName}}`, `{{$random.lastName}}`,
`{{$random.fullName}}`, `{{$random.email}}`, `{{$random.username}}`,
`{{$random.integer}}`, or `{{$random.boolean}}` in request fields. Values are
generated for each send and can be combined with ordinary variables.

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
**Secret** are masked in the editor until revealed, but persist in the local
workspace file across restarts. Literal Basic passwords, Bearer tokens, and
Authorization/Cookie header values also persist locally. Local data is stored
as plain JSON in your user profile; on Unix, Kodama restricts its app-data
directory to your user and the workspace file to mode `0600`.

Exports omit marked secret values and literal Basic passwords, Bearer tokens,
and Authorization/Cookie header values. These values must be entered after
importing on another computer.
Variable references in those fields are preserved. Other request text and
scripts can contain user-entered sensitive content and are exported as written,
so inspect a file before sharing it.

Kodama stores the workspace in Tauri's per-user app-data directory as
`kodama.json`. Writes use a temporary file and rename. Import validates the
format version and UUIDs. Merge keeps current data when UUIDs collide; Replace
uses the imported workspace. Imported scripts never execute during import.

Source-linked collections store the selected file path locally. Exported
workspaces omit source links and paths; link the source again after importing
on another computer. JavaScript and TypeScript files are parsed as data without
executing their imports or helper functions. A static exported OpenAPI object
is supported; dynamic references such as `env.PORT` become editable collection
variables (for example, `{{PORT}}`). Functions that build the document at
runtime are not evaluated.

## Current limits

The MVP covers REST over HTTP/HTTPS. It does not yet provide GraphQL, gRPC,
WebSocket, cloud sync, Postman file compatibility, proxy settings, or multipart
file attachments. The cookie jar and request history last for the app session.
The script engine has
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
