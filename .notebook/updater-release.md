# Signed desktop updates

- `src/useUpdater.ts` checks Tauri's configured updater endpoint on packaged startup and from Settings > General. The update prompt shows `Update.body` and installation only starts after confirmation.
- `src/App.tsx` has a development-only update preview switch in General. Enabling it arms a sample response; clicking Check for updates shows the sample version and opens the same prompt with installation disabled. The preview never calls the updater plugin.
- `src-tauri/tauri.conf.json` embeds Kodama's updater public key and the GitHub Release `updater.json` endpoint. The corresponding private key is kept outside Git and supplied to CI through `KODAMA_TAURI_SIGNING_PRIVATE_KEY` and `KODAMA_TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
- `.github/workflows/build-desktop.yml` builds signed NSIS, macOS app archive, and AppImage artifacts. `scripts/generate-updater-manifest.mjs` requires a signature and release notes for each platform before publishing the manifest.
- Keep frontend and Rust plugin minor versions aligned. The Tauri bundler rejects mismatched `@tauri-apps/plugin-*` and `tauri-plugin-*` versions.
- `src/App.css` has theme-level `html[data-kodama-theme] [data-slot="alert-dialog-content"]` rules after component styles. Keep update dialog overrides below those rules so its width and interior padding are not replaced by the shared alert dialog styling.
