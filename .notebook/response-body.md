# Response body rendering
> Formatting, syntax color, and search in the response panel

Entry: `src/App.tsx` responseContent memo and response panel.

- `src/App.tsx` parses and pretty prints valid JSON; passes `isJson` to `src/ResponseBody.tsx:ResponseBody()`.
- Responses above one million characters display as plain text, and search navigates at most 1,000 matches so large bodies do not trigger expensive formatting or decoration work. The Rust engine rejects bodies above 10 MiB while reading.
- `src/ResponseBody.tsx:ResponseBody()` creates a read only CodeMirror view; JSON language and highlight style are enabled only for valid JSON.
- `src/App.css` defines the response JSON token colors for light and dark themes.
- `src/ResponseBody.tsx:findResponseMatches()` computes offsets in the formatted body; `ResponseBody()` decorates all matches and scrolls the active match into view.
- The response search input in `src/App.tsx` advances with Enter and goes back with Shift+Enter; navigation wraps around.
- The CodeMirror view replaced a React span renderer in `d486d69` to support large responses; JSON language support must be included explicitly or all tokens display in one color.

Updated: 2026-10-10
