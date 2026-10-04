# Signed desktop updates

- `src/useUpdater.ts` checks Tauri's configured updater endpoint on packaged startup and from Settings > General. The update prompt shows `Update.body` and installation only starts after confirmation.
- `src-tauri/tauri.conf.json` embeds Kodama's updater public key and the GitHub Release `updater.json` endpoint. The corresponding private key is kept outside Git and supplied to CI through `KODAMA_TAURI_SIGNING_PRIVATE_KEY` and `KODAMA_TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
- `.github/workflows/build-desktop.yml` builds signed NSIS, macOS app archive, and AppImage artifacts. `scripts/generate-updater-manifest.mjs` requires a signature and release notes for each platform before publishing the manifest.
- Keep frontend and Rust plugin minor versions aligned. The Tauri bundler rejects mismatched `@tauri-apps/plugin-*` and `tauri-plugin-*` versions.
