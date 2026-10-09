# Response body rendering
> Formatting, syntax color, and search in the response panel

Entry: `src/App.tsx` responseContent memo and response panel.

- `src/App.tsx` parses and pretty prints valid JSON; passes `isJson` to `src/ResponseBody.tsx:ResponseBody()`.
- `src/ResponseBody.tsx:ResponseBody()` creates a read only CodeMirror view; JSON language and highlight style are enabled only for valid JSON.
- `src/App.css` defines the response JSON token colors for light and dark themes.
- `src/ResponseBody.tsx:findResponseMatches()` computes offsets in the formatted body; the active match selects and scrolls the CodeMirror view.
- The CodeMirror view replaced a React span renderer in `d486d69` to support large responses; JSON language support must be included explicitly or all tokens display in one color.

Updated: 2026-10-08
