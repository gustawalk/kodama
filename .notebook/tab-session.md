# Request tab session

- `src/App.tsx` stores open request IDs and the selected request in localStorage under `kodama.tabSessionsByWorkspace`, keyed by workspace ID. Pin IDs remain separate under `kodama.pinnedByWorkspace`.
- `src/tabSession.ts:restoreTabSession()` restores the saved order, adds any missing pins, and filters IDs against requests in the loaded workspace. With no saved session, it opens legacy pins or the first request.
- Workspace switching saves the outgoing session before replacing the visible tabs. Deleting a workspace removes its saved session.
