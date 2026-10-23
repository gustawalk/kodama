# Patch notes

<details open>
<summary>Kodama 1.5.0</summary>

- Schedule multiple recurring WebSocket and Socket.IO events with independent payloads and intervals. Enabled schedules start on connection and keep running across tab switches.
- Identify automatic sends and their errors with an Auto tag and schedule name, including in copied event logs.
- Edit Socket.IO auth JSON with syntax highlighting, indentation, and variable suggestions.
- Reuse saved events through a simpler dropdown with Save as new, Update, and Delete actions.
- Keep your place in the event log during automatic sends and incoming replies. Only manually sent events scroll the log to the bottom, using the renamed Send event button.
- Preserve buffered events when resuming a paused log, and keep duplicated socket presets and schedules compatible with workspace saving and imports.
- Hide the completed Saved locally status and prevent background scrollbars from lingering over socket dialogs.

</details>

<details>
<summary>Kodama 1.4.0</summary>

- Save WebSocket and Socket.IO requests, connect, send JSON or text, and inspect timestamped events in a live log.
- Save named socket message examples and edit JSON with the same editor used for REST requests.
- Try both protocols with the included cross-protocol chat server and sample collection.
- Send repeat REST requests faster through a reused HTTP client. Responses over 10 MiB now show a size-limit error to keep memory use bounded.
- Keep busy socket sessions responsive with bounded send queues and event logs.

</details>

<details>
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

Before pushing a `vX.Y.Z` tag, add `docs/releases/vX.Y.Z.md` with the changes users should see in Kodama's update prompt. Keep the patch note list here and the in-app history in sync, with only the newest `<details>` open. The main README links to this history instead of duplicating it. Keep `package.json`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`, and `src-tauri/tauri.conf.json` at `X.Y.Z`. The release workflow requires a nonempty notes file and updater signatures for the Windows, Linux, and macOS assets.
