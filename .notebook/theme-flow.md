# Theme flow
> App-wide palette selection and persistence

Entry: `src/App.tsx` theme state and Appearance controls.

- `src/themes.ts:savedTheme()` validates the `kodama.theme` localStorage value; registry supplies labels, modes, and picker swatches.
- `src/App.tsx` writes `data-kodama-theme` and `.dark` to `<html>`; CodeMirror and Sonner receive the palette's light/dark mode.
- `src/themes.css` defines document palette tokens and maps them to the app, dialogs, Radix menus, CodeMirror, and shadcn semantic colors.
- Portal content does not inherit `.app` variables; keep palette tokens on `<html>` when adding new portaled UI.

Updated: 2026-09-25
