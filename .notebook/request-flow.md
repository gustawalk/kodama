# Request execution and imports

- `src/types.ts:newRequest()` defines frontend request defaults; `src-tauri/src/model.rs:ApiRequest` mirrors the saved JSON format. New fields need a serde default so old workspaces still load.
- `src/App.tsx:send()` passes the active scopes and runtime values to `src-tauri/src/lib.rs:send_request()`, which calls `src-tauri/src/engine.rs:execute_with_jar()`.
- `src-tauri/src/engine.rs:interpolate()` resolves ordinary, runtime, and random templates. `resolve_path_params()` fills `:name` URL segments from saved path parameter rows before URL parsing.
- `src/requestPreview.ts:previewRequestUrl()` mirrors current variable, path parameter, and query values for the editor's read-only preview. It does not run pre-request scripts or generate random values.
- `src-tauri/src/script.rs:run_script()` builds the restricted response object. Header values arrive as key/value pairs and `response.header(name)` performs case insensitive lookup.
- `src/openapi.ts:importOpenApi()` converts OpenAPI 3 and Swagger 2 JSON to a Kodama collection. `src-tauri/src/storage.rs:import_openapi_file()` only picks and reads the file.
- `src/App.tsx:startRequestDrag()` keeps the source request in a ref and also writes a text payload; `moveRequestTo()` reads the ref first. This avoids depending on custom drag MIME data in WebView2.
