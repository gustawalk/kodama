import type { ApiRequest, Collection, CollectionSource, Entry } from "./types";

type SourceDetails = Pick<CollectionSource, "path" | "stamp" | "placeholders" | "dependencies">;
export type SyncSummary = { added: number; updated: number; preserved: number; retained: number };
const clone = <T,>(value: T): T => structuredClone(value);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const withoutGeneratedIds = (value: unknown): unknown => Array.isArray(value)
  ? value.map(withoutGeneratedIds)
  : value && typeof value === "object"
    ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== "id" && key !== "sourceKey").map(([key, item]) => [key, withoutGeneratedIds(item)]))
    : value;
const takeSource = <T,>(current: T, before: T, incoming: T): T => same(current, before) ? incoming : current;
const rowSame = (a: Entry, b: Entry) => a.key === b.key && a.value === b.value && a.enabled === b.enabled;

function mergeRows(current: Entry[], before: Entry[], incoming: Entry[]): Entry[] {
  const used = new Set<string>();
  const result: Entry[] = [];
  for (const next of incoming) {
    const old = before.find((row) => row.key === next.key);
    const local = current.find((row) => !used.has(row.id) && (row.id === old?.id || row.key === next.key));
    if (!local && old) continue; // The user removed this row.
    if (!local) { result.push(next); continue; }
    used.add(local.id);
    if (!old) { result.push(local); continue; }
    result.push({
      id: local.id,
      key: takeSource(local.key, old.key, next.key),
      value: takeSource(local.value, old.value, next.value),
      enabled: takeSource(local.enabled, old.enabled, next.enabled),
    });
  }
  for (const local of current) {
    if (used.has(local.id)) continue;
    const old = before.find((row) => row.id === local.id || row.key === local.key);
    if (!old || !rowSame(local, old)) result.push(local);
  }
  return result;
}

function mergeRequest(current: ApiRequest, before: ApiRequest | undefined, incoming: ApiRequest): ApiRequest {
  if (!before) return { ...current, sourceKey: incoming.sourceKey };
  return {
    ...current,
    sourceKey: incoming.sourceKey,
    name: takeSource(current.name, before.name, incoming.name),
    method: takeSource(current.method, before.method, incoming.method),
    url: takeSource(current.url, before.url, incoming.url),
    folderId: takeSource(current.folderId, before.folderId, incoming.folderId),
    query: mergeRows(current.query, before.query, incoming.query),
    pathParams: mergeRows(current.pathParams ?? [], before.pathParams ?? [], incoming.pathParams ?? []),
    headers: mergeRows(current.headers, before.headers, incoming.headers),
    auth: {
      kind: takeSource(current.auth.kind, before.auth.kind, incoming.auth.kind),
      username: takeSource(current.auth.username, before.auth.username, incoming.auth.username),
      password: takeSource(current.auth.password, before.auth.password, incoming.auth.password),
      token: takeSource(current.auth.token, before.auth.token, incoming.auth.token),
    },
    body: {
      kind: takeSource(current.body.kind, before.body.kind, incoming.body.kind),
      text: takeSource(current.body.text, before.body.text, incoming.body.text),
      fields: mergeRows(current.body.fields, before.body.fields, incoming.body.fields),
    },
  };
}

const routePath = (url: string) => url.replace(/^\{\{[^{}]+\}\}(?=\/)/, "https://source.invalid").replace(/\{\{[^{}]+\}\}/g, "value").replace(/^https?:\/\/[^/]+/i, "").split(/[?#]/, 1)[0];

export function syncCollectionSource(current: Collection, imported: Collection, details: SourceDetails, mode: "merge" | "replace"): { collection: Collection; summary: SyncSummary } {
  const summary: SyncSummary = { added: 0, updated: 0, preserved: 0, retained: 0 };
  const next = mode === "replace"
    ? { ...clone(imported), id: current.id }
    : clone(current);
  const oldBaseline = current.source?.path === details.path ? current.source.baseline ?? {} : {};
  const baseline: Record<string, ApiRequest> = mode === "replace" ? {} : { ...oldBaseline };
  const folderIds = new Map<string, string>();
  if (mode === "merge") {
    for (const folder of imported.folders) {
      let existing = next.folders.find((item) => item.name === folder.name && item.parentId === null);
      if (!existing) {
        const linked = imported.requests.find((request) => {
          const local = next.requests.find((item) => item.sourceKey === request.sourceKey);
          return request.folderId === folder.id && !!local?.folderId && oldBaseline[request.sourceKey ?? ""]?.folderId === local.folderId;
        });
        const local = linked && next.requests.find((item) => item.sourceKey === linked.sourceKey);
        existing = local?.folderId ? next.folders.find((item) => item.id === local.folderId) : undefined;
      }
      if (!existing) {
        existing = clone(folder);
        next.folders.push(existing);
      }
      folderIds.set(folder.id, existing.id);
    }
    for (const variable of imported.variables) {
      if (!next.variables.some((item) => item.name === variable.name)) next.variables.push(clone(variable));
    }
  } else {
    for (const folder of imported.folders) folderIds.set(folder.id, folder.id);
  }
  const seen = new Set<string>();
  for (const generated of imported.requests) {
    const key = generated.sourceKey ?? `${generated.method} ${routePath(generated.url)}`;
    seen.add(key);
    const mapped = { ...clone(generated), sourceKey: key, folderId: generated.folderId ? folderIds.get(generated.folderId) ?? null : null };
    if (mode === "replace") {
      baseline[key] = clone(mapped);
      summary.added++;
      continue;
    }
    const linked = next.requests.find((item) => item.sourceKey === key);
    const compatible = next.requests.filter((item) => !item.sourceKey && item.method === mapped.method && routePath(item.url) === routePath(mapped.url));
    const existing = linked ?? (compatible.length === 1 ? compatible[0] : undefined);
    if (!existing) {
      next.requests.push(mapped);
      baseline[key] = clone(mapped);
      summary.added++;
      continue;
    }
    const old = oldBaseline[key];
    const merged = mergeRequest(existing, old, mapped);
    const index = next.requests.findIndex((item) => item.id === existing.id);
    next.requests[index] = merged;
    baseline[key] = { ...clone(mapped), id: existing.id };
    if (!same(existing, merged)) summary.updated++;
    if (old && !same(withoutGeneratedIds(existing), withoutGeneratedIds(old))) summary.preserved++;
  }
  if (mode === "merge") summary.retained = Object.keys(oldBaseline).filter((key) => !seen.has(key)).length;
  next.source = { path: details.path, stamp: details.stamp, dependencies: details.dependencies, placeholders: details.placeholders, lastSyncedAt: new Date().toISOString(), baseline };
  return { collection: next, summary };
}
