export type TabSession = { tabs: string[]; selectedId: string | null };

export function readTabSessions(raw: string | null): Record<string, TabSession> {
  try {
    const saved: unknown = JSON.parse(raw ?? "{}");
    if (!saved || typeof saved !== "object" || Array.isArray(saved)) return {};
    return Object.fromEntries(
      Object.entries(saved).filter((entry): entry is [string, TabSession] => {
        const value = entry[1] as TabSession;
        return (
          !!value &&
          Array.isArray(value.tabs) &&
          value.tabs.every((id) => typeof id === "string") &&
          (value.selectedId === null || typeof value.selectedId === "string")
        );
      }),
    );
  } catch {
    return {};
  }
}

export function restoreTabSession(
  saved: TabSession | undefined,
  pins: string[],
  known: Set<string>,
  firstRequestId: string | null,
): TabSession {
  const tabs = [...new Set([...(saved?.tabs ?? pins), ...pins])].filter((id) => known.has(id));
  if (!saved && !tabs.length && firstRequestId) tabs.push(firstRequestId);
  return {
    tabs,
    selectedId:
      saved?.selectedId && tabs.includes(saved.selectedId) ? saved.selectedId : (tabs[0] ?? null),
  };
}
