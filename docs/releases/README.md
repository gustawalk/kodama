# Patch notes

<details open>
<summary>Kodama 1.3.1</summary>

- Restore syntax highlighting for JSON response bodies while keeping search responsive for large responses.

</details>

<details>
<summary>Kodama 1.3.0</summary>

- Rename, remove, or duplicate the selected request with F2, Delete, and Ctrl/Cmd+D.
- Restyle the environments, authorization, and collection dropdowns to follow the active theme, with brighter hover states and a checkmark on the selected option.

</details>

<details>
<summary>Kodama 1.2.0</summary>

- Show the installed app version in the sidebar.
- Show a pulsing Kodama logo while the workspace loads.
- Keep response search usable with responses over 100,000 lines.

</details>

<details>
<summary>Kodama 1.1.0</summary>

- Rename collections from their right-click menu; double-clicking a collection no longer opens the rename dialog.
- Select and edit text across variable references in JSON request bodies and scripts.
- Start resizing the sidebar only when the pointer press begins on its divider.
- Open the patch note history from Settings > General, with the newest version expanded and older versions collapsed.

</details>

<details>
<summary>Kodama 1.0.0</summary>

- Restore open request tabs, including pinned tabs, when Kodama starts again.
- Check for signed updates from Settings > General or automatically at startup.
- Review release notes and choose when to install an available update.
- Refined the version panel and update prompt for clearer release information.

</details>

<details>
<summary>Kodama 0.1.0</summary>

- Added signed in-app update checks when Kodama opens and a manual check in Settings > General.
- Updates now show release notes and require your confirmation before installation.
- Open request tabs, including ordinary and pinned tabs, are restored after restarting Kodama.

</details>

## Preparing a release

Before pushing a `vX.Y.Z` tag, add `docs/releases/vX.Y.Z.md` with the changes users should see in Kodama's update prompt. Keep the patch note lists here and in the README in sync, with only the newest `<details>` open. Keep `package.json`, `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json` at `X.Y.Z`. The release workflow requires a nonempty notes file and updater signatures for the Windows, Linux, and macOS assets.
