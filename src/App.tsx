import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import type React from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast, Toaster } from "sonner";
import { ChevronDown, ChevronRight, Eye, EyeOff, GripVertical, Pencil, Settings2, Trash2 } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { VariableField, type ResolvedVariable } from "./VariableField";
import { exportCurl, importCurl } from "./curl";
import { importOpenApi } from "./openapi";
import { previewRequestUrl } from "./requestPreview";
import { parseOpenApiSource, type SourceFile } from "./sourceParser";
import { syncCollectionSource, type SyncSummary } from "./sourceSync";
import type {
  ApiRequest,
  Collection,
  Entry,
  RunResult,
  Store,
  Variable,
  WorkspaceData,
} from "./types";
import {
  demoWorkspaceData,
  emptyStore,
  entry,
  newCollection,
  newRequest,
  uid,
  variable,
} from "./types";
import "./App.css";

type Panel = "params" | "headers" | "auth" | "body" | "pre" | "post";
const CodeEditor = lazy(() => import("./CodeEditor").then((module) => ({ default: module.CodeEditor })));
type Sidebar = "requests" | "environments" | "variables" | "history";
type ContextMenuState =
  | { kind: "request"; x: number; y: number; requestId: string; collectionId: string }
  | { kind: "tab"; x: number; y: number; requestId: string }
  | { kind: "collection"; x: number; y: number; collectionId: string }
  | { kind: "folder"; x: number; y: number; collectionId: string; folderId: string };
const copy = <T,>(value: T): T => structuredClone(value);
const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
const findRequest = (store: Store, id: string | null) =>
  store.collections.flatMap((collection) =>
    collection.requests.map((request) => ({ collection, request }))
  ).find((item) => item.request.id === id);
const pathParamNames = (url: string) => [...new Set([...url.split(/[?#]/, 1)[0].matchAll(/\/:([A-Za-z_][\w]*)\b/g)].map((match) => match[1]))];
const collectionIds = (
  item: Collection,
) => [
  item.id,
  ...item.variables.map((value) => value.id),
  ...item.folders.map((value) => value.id),
  ...item.requests.flatMap((value) => [
    value.id,
    ...value.query.map((row) => row.id),
    ...(value.pathParams ?? []).map((row) => row.id),
    ...value.headers.map((row) => row.id),
    ...value.body.fields.map((row) => row.id),
  ]),
];
function mergeWorkspace(current: Store, imported: Store) {
  const next = copy(current);
  const ids = new Set([
    ...next.defaults.map((value) => value.id),
    ...next.collections.flatMap(collectionIds),
    ...next.environments.flatMap(
      (item) => [item.id, ...item.variables.map((value) => value.id)],
    ),
  ]);
  let skipped = 0;
  const add = (entityIds: string[]) => {
    if (entityIds.some((id) => ids.has(id))) {
      skipped++;
      return false;
    }
    entityIds.forEach((id) => ids.add(id));
    return true;
  };
  imported.collections.forEach((item) => {
    if (add(collectionIds(item))) next.collections.push(item);
  });
  imported.environments.forEach((item) => {
    if (add([item.id, ...item.variables.map((value) => value.id)])) {
      next.environments.push(item);
    }
  });
  (imported.defaults ?? []).forEach((item) => {
    if (add([item.id])) next.defaults.push(item);
  });
  return { next, skipped };
}

function withDefaultEnvironment(store: Store): Store {
  const hasSelection = store.environments.some((item) => item.id === store.activeEnvironmentId);
  if (hasSelection || !store.environments.length) return store;
  return { ...store, activeEnvironmentId: store.environments[0].id };
}

function Entries(
  { rows, onChange, name, variables }: {
    rows: Entry[];
    onChange: (rows: Entry[]) => void;
    name: string;
    variables: Record<string, ResolvedVariable>;
  },
) {
  const edit = (id: string, field: keyof Entry, value: string | boolean) =>
    onChange(
      rows.map((row) => row.id === id ? { ...row, [field]: value } : row),
    );
  return (
    <div className="entries">
      <div className="entries-head">
        <span></span>
        <span>{name}</span>
        <span>Value</span>
        <span></span>
      </div>
      {rows.map((row) => (
        <div className={`entry-row${row.enabled ? "" : " inactive"}`} key={row.id}>
          <input
            aria-label="Enabled"
            title={row.enabled ? "Included in request" : "Excluded from request"}
            type="checkbox"
            checked={row.enabled}
            onChange={(event) => edit(row.id, "enabled", event.target.checked)}
          />
          <VariableField
            label={name}
            variables={variables}
            value={row.key}
            placeholder={name}
            onChange={(value) => edit(row.id, "key", value)}
          />
          <VariableField
            label="Value"
            variables={variables}
            value={row.value}
            placeholder="Value or {{NAME}}"
            onChange={(value) => edit(row.id, "value", value)}
          />
          <button
            className="icon"
            aria-label="Remove row"
            onClick={() => onChange(rows.filter((item) => item.id !== row.id))}
          >
            ×
          </button>
        </div>
      ))}
      <button
        className="text-button"
        onClick={() => onChange([...rows, entry()])}
      >
        + Add row
      </button>
    </div>
  );
}

function VariableEditor(
  { rows, onChange }: {
    rows: Variable[];
    onChange: (rows: Variable[]) => void;
  },
) {
  const [shown, setShown] = useState<string[]>([]);
  const edit = (id: string, field: keyof Variable, value: string | boolean) =>
    onChange(
      rows.map((row) => row.id === id ? { ...row, [field]: value } : row),
    );
  return (
    <div className="variables-editor">
      {rows.map((row) => (
        <div className="variable-row" key={row.id}>
          <input
            aria-label="Variable name"
            value={row.name}
            placeholder="NAME"
            onChange={(event) => edit(row.id, "name", event.target.value)}
          />
          <input
            aria-label="Variable value"
            type={row.secret && !shown.includes(row.id) ? "password" : "text"}
            value={row.value}
            placeholder="Value"
            onChange={(event) => edit(row.id, "value", event.target.value)}
          />
          <button className="icon" aria-label={shown.includes(row.id) ? "Hide variable value" : "Show variable value"} title={shown.includes(row.id) ? "Hide value" : "Show value"} onClick={() => setShown((previous) => previous.includes(row.id) ? previous.filter((id) => id !== row.id) : [...previous, row.id])}>{shown.includes(row.id) ? <EyeOff size={15} /> : <Eye size={15} />}</button>
          <label className="secret-toggle" title="Secret values stay hidden in variable editors">
            <input
              type="checkbox"
              role="switch"
              aria-label={`Secret variable ${row.name || "unnamed"}`}
              checked={row.secret}
              onChange={(event) => edit(row.id, "secret", event.target.checked)}
            />
            <span className="secret-toggle-track" aria-hidden="true"><span /></span>
            <span>Secret</span>
          </label>
          <button
            className="icon"
            aria-label="Remove variable"
            onClick={() => onChange(rows.filter((item) => item.id !== row.id))}
          >
            ×
          </button>
        </div>
      ))}
      <button
        className="text-button"
        onClick={() => onChange([...rows, variable()])}
      >
        + Add variable
      </button>
    </div>
  );
}

function App() {
  const [workspaceData, setWorkspaceData] = useState<WorkspaceData>(demoWorkspaceData);
  const activeWorkspace = workspaceData.workspaces.find((item) => item.id === workspaceData.activeWorkspaceId) ?? workspaceData.workspaces[0];
  const store = activeWorkspace.store;
  const setStore: React.Dispatch<React.SetStateAction<Store>> = (update) => setWorkspaceData((previous) => ({
    ...previous,
    workspaces: previous.workspaces.map((item) => item.id === previous.activeWorkspaceId
      ? { ...item, store: typeof update === "function" ? update(item.store) : update }
      : item),
  }));
  const [ready, setReady] = useState(false);
  const [saved, setSaved] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tabs, setTabs] = useState<string[]>([]);
  const [panel, setPanel] = useState<Panel>("params");
  const [sidebar, setSidebar] = useState<Sidebar>("requests");
  const [search, setSearch] = useState("");
  const [runtime, setRuntime] = useState<Record<string, string>>({});
  const [response, setResponse] = useState<RunResult | null>(null);
  const [responseView, setResponseView] = useState<"body" | "headers" | "cookies">("body");
  const [cookieText, setCookieText] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<
    { id: string; requestId: string; name: string; method: string; status: number | null; time: number; url: string; size: number; date: string; headerCount: number; response: RunResult | null; error?: string }[]
  >([]);
  const [expandedHistory, setExpandedHistory] = useState<string | null>(null);
  const [incoming, setIncoming] = useState<Store | null>(null);
  const [theme, setTheme] = useState<"dark" | "light">(() =>
    localStorage.getItem("kodama.theme") === "light" ? "light" : "dark"
  );
  const [collapsed, setCollapsed] = useState<string[]>([]);
  const [renameDialog, setRenameDialog] = useState<{ name: string; apply: (name: string) => void } | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deleteDialog, setDeleteDialog] = useState<{ name: string; description?: string; apply: () => void } | null>(null);
  const [responseSearch, setResponseSearch] = useState("");
  const [curlDialog, setCurlDialog] = useState(false);
  const [curlText, setCurlText] = useState("");
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const stored = Number(localStorage.getItem("kodama.sidebarWidth"));
    return Number.isFinite(stored) && stored > 0
      ? Math.max(210, Math.min(540, stored))
      : 280;
  });
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [draggingTabId, setDraggingTabId] = useState<string | null>(null);
  const [tabDropTarget, setTabDropTarget] = useState<{ id: string; after: boolean } | null>(null);
  const draggingRequest = useRef<{ requestId: string; collectionId: string } | null>(null);
  const [headerVariable, setHeaderVariable] = useState<{ name: string; value: string } | null>(null);
  const [configOpen, setConfigOpen] = useState(false);
  const [workspaceDialogOpen, setWorkspaceDialogOpen] = useState(false);
  const [switchingWorkspace, setSwitchingWorkspace] = useState(false);
  const [newWorkspaceName, setNewWorkspaceName] = useState("");
  const [variablesOpen, setVariablesOpen] = useState(false);
  const [configCollectionId, setConfigCollectionId] = useState<string | null>(null);
  const [replaceSourceId, setReplaceSourceId] = useState<string | null>(null);
  const [sourceStatus, setSourceStatus] = useState<Record<string, { busy: boolean; message: string; error: boolean }>>({});
  const sourceCollectionsRef = useRef<Collection[]>([]);
  const syncingSourcesRef = useRef(new Set<string>());
  const pollingSourcesRef = useRef(false);
  const activeWorkspaceRef = useRef(workspaceData.activeWorkspaceId);
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const saveRevisionRef = useRef(0);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    localStorage.setItem("kodama.theme", theme);
    return () => document.documentElement.classList.remove("dark");
  }, [theme]);

  useEffect(() => {
    invoke<WorkspaceData | null>("load_workspaces").then((data) => {
      const next = data ?? demoWorkspaceData();
      next.workspaces = next.workspaces.map((item) => ({ ...item, store: withDefaultEnvironment(item.store) }));
      activeWorkspaceRef.current = next.activeWorkspaceId;
      setWorkspaceData(next);
      const active = next.workspaces.find((item) => item.id === next.activeWorkspaceId) ?? next.workspaces[0];
      const id = active.store.collections[0]?.requests[0]?.id ?? null;
      setSelectedId(id);
      setTabs(id ? [id] : []);
      setReady(true);
    }).catch((err) => {
      setLoadError(`Could not load workspace: ${message(err)}`);
      setSaved(false);
      toast.error(`Could not load workspace: ${message(err)}`);
    });
  }, []);
  useEffect(() => {
    localStorage.setItem("kodama.sidebarWidth", String(sidebarWidth));
  }, [sidebarWidth]);
  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("pointerdown", close);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [contextMenu]);
  const persistWorkspaces = (data: WorkspaceData, revision: number) => {
    saveQueueRef.current = saveQueueRef.current.catch(() => {}).then(async () => {
      await invoke("save_workspaces", { workspaces: data });
      if (saveRevisionRef.current === revision) setSaved(true);
    }).catch((err) => {
      toast.error(`Could not save workspace: ${message(err)}`, { id: "save-error" });
    });
  };
  useEffect(() => {
    if (!ready) return;
    const revision = ++saveRevisionRef.current;
    setSaved(false);
    const timer = window.setTimeout(() => {
      persistWorkspaces(workspaceData, revision);
    }, 400);
    return () => window.clearTimeout(timer);
  }, [workspaceData, ready]);
  useEffect(() => { sourceCollectionsRef.current = store.collections; }, [store.collections]);
  useEffect(() => {
    if (!ready) return;
    let stopped = false;
    const checkSources = async () => {
      if (pollingSourcesRef.current) return;
      pollingSourcesRef.current = true;
      try {
        for (const item of sourceCollectionsRef.current) {
          const source = item.source;
          if (!source?.path || syncingSourcesRef.current.has(item.id)) continue;
          try {
            const stamp = await invoke<string>("source_file_stamp", { path: source.path });
            if (stamp !== source.stamp && !stopped) {
              const file = await invoke<SourceFile>("read_source_file", { path: source.path });
              if (!stopped) await applySourceFile(item.id, file, "merge", false);
            }
          } catch (err) {
            if (!stopped) setSourceStatus((previous) => ({ ...previous, [item.id]: { busy: false, message: message(err), error: true } }));
          }
        }
      } finally { pollingSourcesRef.current = false; }
    };
    void checkSources();
    const timer = window.setInterval(() => { void checkSources(); }, 5000);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [ready, workspaceData.activeWorkspaceId]);

  const current = findRequest(store, selectedId);
  const request = current?.request;
  const collection = current?.collection;
  const configCollection = store.collections.find((item) => item.id === configCollectionId);
  const environment = store.environments.find((item) =>
    item.id === store.activeEnvironmentId
  );
  const resolvedVariables = useMemo(() => {
    const values: Record<
      string,
      { value: string; source: string; secret: boolean }
    > = {};
    store.defaults?.forEach((item) => {
      if (item.name) {
        values[item.name] = {
          value: item.value,
          source: "Default",
          secret: item.secret,
        };
      }
    });
    collection?.variables.forEach((item) => {
      if (item.name) {
        values[item.name] = {
          value: item.value,
          source: "Collection",
          secret: item.secret,
        };
      }
    });
    environment?.variables.forEach((item) => {
      if (item.name) {
        values[item.name] = {
          value: item.value,
          source: "Environment",
          secret: item.secret,
        };
      }
    });
    Object.entries(runtime).forEach(([name, value]) => {
      const item = {
        value,
        source: "Runtime",
        secret: /token|key|secret|password/i.test(name),
      };
      values[name] = item;
      values[`_.${name}`] = item;
    });
    ["uuid", "firstName", "lastName", "fullName", "email", "username", "integer", "boolean"].forEach((name) => {
      values[`$random.${name}`] = { value: "Generated when sent", source: "Random", secret: false };
    });
    return values;
  }, [store.defaults, collection, environment, runtime]);
  const urlPreview = request ? previewRequestUrl(request, resolvedVariables) : "";
  const visibleCollections = useMemo(
    () =>
      store.collections.map((item) => ({
        item,
        requests: item.requests.filter((value) =>
          `${value.name} ${value.method} ${value.url}`.toLowerCase().includes(
            search.toLowerCase(),
          )
        ),
      })).filter(({ item, requests }) =>
        !search || item.name.toLowerCase().includes(search.toLowerCase()) ||
        requests.length
      ),
    [store.collections, search],
  );
  const responseBody = useMemo(() => {
    if (!response || response.binary) return "";
    try {
      return JSON.stringify(JSON.parse(response.body), null, 2);
    } catch {
      const contentType = response.headers.find(([key]) => key.toLowerCase() === "content-type")?.[1] ?? "";
      return /text\/html|application\/xhtml\+xml/i.test(contentType) || /^\s*(?:<!doctype\s+html|<html\b)/i.test(response.body)
        ? response.body.replace(/>\s*</g, ">\n<").trim()
        : response.body;
    }
  }, [response]);
  const responseContentType = response?.headers.find(([key]) => key.toLowerCase() === "content-type")?.[1] ?? "Unknown content type";
  const responseIsHtml = !!response && (/text\/html|application\/xhtml\+xml/i.test(responseContentType) || /^\s*(?:<!doctype\s+html|<html\b)/i.test(response.body));
  const responseMatches = responseSearch ? responseBody.toLowerCase().split(responseSearch.toLowerCase()).length - 1 : 0;
  const highlightedResponse = () => {
    if (!responseSearch) return responseBody;
    const parts: React.ReactNode[] = [];
    const lower = responseBody.toLowerCase();
    const needle = responseSearch.toLowerCase();
    let index = 0;
    while (index < responseBody.length) {
      const found = lower.indexOf(needle, index);
      if (found < 0) { parts.push(responseBody.slice(index)); break; }
      parts.push(responseBody.slice(index, found));
      parts.push(<mark key={found}>{responseBody.slice(found, found + needle.length)}</mark>);
      index = found + needle.length;
    }
    return parts;
  };

  const editStore = (change: (next: Store) => void) =>
    setStore((previous) => {
      const next = copy(previous);
      change(next);
      return next;
    });
  const editCollection = (id: string, change: (next: Collection) => void) =>
    editStore((next) => {
      const target = next.collections.find((item) => item.id === id);
      if (target) change(target);
    });
  const editRequest = (change: (next: ApiRequest) => void) => {
    if (request) {
      editStore((next) => {
        const target = findRequest(next, request.id)?.request;
        if (target) change(target);
      });
    }
  };
  const open = (id: string) => {
    setSelectedId(id);
    setTabs((previous) => previous.includes(id) ? previous : [...previous, id]);
    setResponse(null);
    setError("");
    setSidebar("requests");
  };
  const rename = (original: string, apply: (name: string) => void) => {
    setRenameValue(original);
    setRenameDialog({ name: original, apply });
  };
  const addRequest = (collectionId: string, folderId: string | null = null) => {
    const item = newRequest("New request", folderId);
    editCollection(collectionId, (next) => {
      next.requests.push(item);
    });
    open(item.id);
  };
  const removeRequest = () => {
    if (!request || !collection) return;
    const requestId = request.id;
    const collectionId = collection.id;
    setDeleteDialog({ name: request.name, apply: () => {
      editCollection(collectionId, (next) => {
        next.requests = next.requests.filter((item) => item.id !== requestId);
      });
      setTabs((previous) => previous.filter((id) => id !== requestId));
      setSelectedId(null);
    } });
  };
  const moveRequest = (direction: -1 | 1) => {
    if (!request || !collection) return;
    editCollection(collection.id, (next) => {
      const index = next.requests.findIndex((item) => item.id === request.id);
      const other = index + direction;
      if (index >= 0 && other >= 0 && other < next.requests.length) {
        [next.requests[index], next.requests[other]] = [
          next.requests[other],
          next.requests[index],
        ];
      }
    });
  };

  const startRequestDrag = (event: React.DragEvent, requestId: string, collectionId: string) => {
    draggingRequest.current = { requestId, collectionId };
    event.dataTransfer.setData("text/plain", `kodama-request:${requestId}:${collectionId}`);
    event.dataTransfer.effectAllowed = "move";
  };

  const moveRequestTo = (
    event: React.DragEvent,
    targetCollectionId: string,
    targetFolderId: string | null,
    anchorRequestId?: string,
    insertAfter = false,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    setDragOverId(null);
    try {
      const payload = event.dataTransfer.getData("text/plain");
      const source = draggingRequest.current ?? (payload.startsWith("kodama-request:") ? (() => { const [, requestId, collectionId] = payload.split(":"); return { requestId, collectionId }; })() : null);
      if (!source) return;
      editStore((next) => {
        const sourceCollection = next.collections.find((item) => item.id === source.collectionId);
        const targetCollection = next.collections.find((item) => item.id === targetCollectionId);
        if (!sourceCollection || !targetCollection || source.requestId === anchorRequestId) return;
        const sourceIndex = sourceCollection.requests.findIndex((item) => item.id === source.requestId);
        if (sourceIndex < 0) return;
        const [moving] = sourceCollection.requests.splice(sourceIndex, 1);
        moving.folderId = targetFolderId;
        let insertAt = -1;
        if (anchorRequestId) {
          const anchorIndex = targetCollection.requests.findIndex((item) => item.id === anchorRequestId);
          if (anchorIndex >= 0) insertAt = anchorIndex + (insertAfter ? 1 : 0);
        }
        if (insertAt < 0) {
          for (let index = 0; index < targetCollection.requests.length; index++) {
            if (targetCollection.requests[index].folderId === targetFolderId) insertAt = index + 1;
          }
          if (insertAt < 0) insertAt = targetCollection.requests.length;
        }
        targetCollection.requests.splice(insertAt, 0, moving);
      });
    } catch {
      // Ignore drops without a Kodama request payload.
    } finally {
      draggingRequest.current = null;
    }
  };
  const duplicateRequest = () => {
    if (!request || !collection) return;
    duplicateRequestById(request.id, collection.id);
  };

  const duplicateRequestById = (requestId: string, collectionId: string) => {
    const source = findRequest(store, requestId)?.request;
    if (!source) return;
    const item = copy(source);
    item.id = uid();
    item.name += " copy";
    delete item.sourceKey;
    [...item.query, ...(item.pathParams ?? []), ...item.headers, ...item.body.fields].forEach((row) => {
      row.id = uid();
    });
    editCollection(collectionId, (next) => next.requests.push(item));
    open(item.id);
  };

  const removeRequestById = (requestId: string, collectionId: string) => {
    const target = findRequest(store, requestId)?.request;
    if (!target) return;
    setDeleteDialog({ name: target.name, apply: () => {
      editCollection(collectionId, (next) => {
        next.requests = next.requests.filter((item) => item.id !== requestId);
      });
      const nextTabs = tabs.filter((id) => id !== requestId);
      setTabs(nextTabs);
      if (selectedId === requestId) setSelectedId(nextTabs[nextTabs.length - 1] ?? null);
    } });
  };

  const closeTab = (requestId: string) => {
    const index = tabs.indexOf(requestId);
    const remaining = tabs.filter((id) => id !== requestId);
    setTabs(remaining);
    if (selectedId === requestId) setSelectedId(remaining[Math.max(0, index - 1)] ?? null);
  };

  const closeTabsByRelation = (requestId: string, relation: "others" | "right" | "left") => {
    const index = tabs.indexOf(requestId);
    const remaining = tabs.filter((id, tabIndex) => relation === "others"
      ? id === requestId
      : relation === "right" ? tabIndex <= index : tabIndex >= index);
    setTabs(remaining);
    if (!remaining.includes(selectedId ?? "")) setSelectedId(requestId);
  };

  const resizeSidebar = (delta: number) => setSidebarWidth((width) =>
    Math.max(210, Math.min(Math.min(window.innerWidth * 0.48, 540), width + delta)),
  );

  const showRequestMenu = (event: React.MouseEvent, requestId: string, collectionId: string) => {
    event.preventDefault();
    setContextMenu({
      kind: "request",
      requestId,
      collectionId,
      x: Math.min(event.clientX, window.innerWidth - 230),
      y: Math.min(event.clientY, window.innerHeight - 290),
    });
  };

  const showTabMenu = (event: React.MouseEvent, requestId: string) => {
    event.preventDefault();
    setContextMenu({
      kind: "tab",
      requestId,
      x: Math.min(event.clientX, window.innerWidth - 220),
      y: Math.min(event.clientY, window.innerHeight - 170),
    });
  };

  const showCollectionMenu = (event: React.MouseEvent, collectionId: string) => {
    event.preventDefault();
    setContextMenu({ kind: "collection", collectionId, x: Math.max(8, Math.min(event.clientX, window.innerWidth - 230)), y: Math.max(8, Math.min(event.clientY, window.innerHeight - 180)) });
  };

  const showFolderMenu = (event: React.MouseEvent, collectionId: string, folderId: string) => {
    event.preventDefault();
    setContextMenu({ kind: "folder", collectionId, folderId, x: Math.max(8, Math.min(event.clientX, window.innerWidth - 230)), y: Math.max(8, Math.min(event.clientY, window.innerHeight - 220)) });
  };

  const deleteCollectionById = (collectionId: string) => {
    const target = store.collections.find((item) => item.id === collectionId);
    if (!target) return;
    const requestIds = new Set(target.requests.map((item) => item.id));
    setDeleteDialog({ name: target.name, apply: () => {
      editStore((next) => { next.collections = next.collections.filter((item) => item.id !== collectionId); });
      const remainingTabs = tabs.filter((id) => !requestIds.has(id));
      setTabs(remainingTabs);
      if (selectedId && requestIds.has(selectedId)) setSelectedId(remainingTabs[remainingTabs.length - 1] ?? null);
    } });
  };

  const deleteFolderById = (collectionId: string, folderId: string) => {
    const target = store.collections.find((item) => item.id === collectionId);
    const folder = target?.folders.find((item) => item.id === folderId);
    if (!target || !folder) return;
    const folderIds = new Set([folderId]);
    let changed = true;
    while (changed) {
      changed = false;
      target.folders.forEach((item) => {
        if (item.parentId && folderIds.has(item.parentId) && !folderIds.has(item.id)) { folderIds.add(item.id); changed = true; }
      });
    }
    const requestIds = new Set(target.requests.filter((item) => item.folderId && folderIds.has(item.folderId)).map((item) => item.id));
    setDeleteDialog({ name: `${folder.name} and its contents`, apply: () => {
      editCollection(collectionId, (next) => {
        next.folders = next.folders.filter((item) => !folderIds.has(item.id));
        next.requests = next.requests.filter((item) => !requestIds.has(item.id));
      });
      const remainingTabs = tabs.filter((id) => !requestIds.has(id));
      setTabs(remainingTabs);
      if (selectedId && requestIds.has(selectedId)) setSelectedId(remainingTabs[remainingTabs.length - 1] ?? null);
    } });
  };

  async function send() {
    if (!request || !collection || busy || switchingWorkspace) return;
    setBusy(true);
    setError("");
    setResponse(null);
    const startedAt = performance.now();
    try {
      const sourceFields = [request.url, request.body.text, ...request.query.flatMap((row) => [row.key, row.value]), ...request.pathParams.map((row) => row.value), ...request.headers.flatMap((row) => [row.key, row.value])];
      const unset = request.preScript.trim() ? [] : collection.source?.placeholders.filter((name) => sourceFields.some((field) => field.includes(`{{${name}}}`)) && !resolvedVariables[name]?.value) ?? [];
      if (unset.length) throw new Error(`Set source variable${unset.length === 1 ? "" : "s"} ${unset.join(", ")} in Collection settings before sending`);
      const result = await invoke<RunResult>("send_request", {
        input: {
          request,
          defaults: store.defaults ?? [],
          collectionVariables: collection.variables,
          environmentVariables: environment?.variables ?? [],
          runtimeVariables: runtime,
        },
      });
      setResponse(result);
      setCookieText(await invoke<string>("get_cookies", { url: result.url }).catch(() => ""));
      setRuntime(result.runtimeVariables);
      setHistory((previous) =>
        [{
          id: uid(),
          requestId: request.id,
          name: request.name,
          method: request.method,
          status: result.status,
          time: result.elapsedMs,
          url: result.url,
          size: result.size,
          date: new Date().toISOString(),
          headerCount: result.headers.length,
          response: !result.binary && result.body.length <= 64 * 1024 ? result : null,
        }, ...previous].slice(0, 40)
      );
    } catch (err) {
      const failure = message(err);
      setError(failure);
      setHistory((previous) => [{ id: uid(), requestId: request.id, name: request.name, method: request.method, status: null, time: Math.round(performance.now() - startedAt), url: request.url, size: 0, date: new Date().toISOString(), headerCount: 0, response: null, error: failure }, ...previous].slice(0, 40));
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
        event.preventDefault();
        void send();
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        persistWorkspaces(workspaceData, saveRevisionRef.current);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  });
  async function importFile() {
    try {
      const data = await invoke<Store | null>("import_store");
      if (data) setIncoming(data);
    } catch (err) {
      setError(message(err));
    }
  }
  async function importOpenApiFile() {
    try {
      const document = await invoke<unknown | null>("import_openapi_file");
      if (!document) return;
      const imported = importOpenApi(document);
      setStore((previous) => ({ ...previous, collections: [...previous.collections, ...imported.collections] }));
      const first = imported.collections[0].requests[0];
      if (first) open(first.id);
      toast.success(`Imported ${imported.collections[0].requests.length} requests from OpenAPI`);
    } catch (err) { toast.error(`Could not import OpenAPI: ${message(err)}`); }
  }
  async function applySourceFile(collectionId: string, file: SourceFile, mode: "merge" | "replace", announce: boolean) {
    const targetWorkspaceId = workspaceData.activeWorkspaceId;
    if (syncingSourcesRef.current.has(collectionId)) return;
    syncingSourcesRef.current.add(collectionId);
    setSourceStatus((previous) => ({ ...previous, [collectionId]: { busy: true, message: "Reading source…", error: false } }));
    try {
      const parsed = await parseOpenApiSource(file);
      const imported = importOpenApi(parsed.document).collections[0];
      const used = new Set(imported.requests.flatMap((item) => [item.url, item.body.text, ...item.query.flatMap((row) => [row.key, row.value]), ...item.pathParams.map((row) => row.value), ...item.headers.flatMap((row) => [row.key, row.value])]
        .flatMap((text) => [...text.matchAll(/\{\{\s*([A-Za-z_][\w]*)\s*\}\}/g)].map((match) => match[1]))));
      const placeholders = parsed.placeholders.filter((name) => used.has(name));
      for (const name of placeholders) {
        if (!imported.variables.some((item) => item.name === name)) imported.variables.push({ ...variable(), name });
      }
      if (activeWorkspaceRef.current !== targetWorkspaceId) return;
      const current = sourceCollectionsRef.current.find((item) => item.id === collectionId);
      if (!current) throw new Error("Collection no longer exists");
      const details = { path: file.path, stamp: file.stamp, placeholders };
      const preview = syncCollectionSource(current, imported, details, mode);
      setStore((previous) => ({ ...previous, collections: previous.collections.map((item) =>
        item.id === collectionId ? syncCollectionSource(item, imported, details, mode).collection : item,
      ) }));
      if (mode === "replace") {
        const oldIds = new Set(current.requests.map((item) => item.id));
        const wasSelected = !!selectedId && oldIds.has(selectedId);
        const firstId = preview.collection.requests[0]?.id;
        setTabs((previous) => { const remaining = previous.filter((id) => !oldIds.has(id)); return wasSelected && firstId ? [...remaining, firstId] : remaining; });
        if (wasSelected) { setSelectedId(firstId ?? null); setResponse(null); }
      }
      const summary: SyncSummary = preview.summary;
      const result = mode === "replace"
        ? `Replaced with ${preview.collection.requests.length} source routes`
        : `Synced: ${summary.added} added, ${summary.updated} updated, ${summary.preserved} locally edited`;
      setSourceStatus((previous) => ({ ...previous, [collectionId]: { busy: false, message: result, error: false } }));
      if (announce) toast.success(result);
    } catch (err) {
      const detail = message(err);
      setSourceStatus((previous) => ({ ...previous, [collectionId]: { busy: false, message: detail, error: true } }));
      if (announce) toast.error(`Could not sync source: ${detail}`);
    } finally { syncingSourcesRef.current.delete(collectionId); }
  }
  async function chooseSourceFile(collectionId: string) {
    try {
      const file = await invoke<SourceFile | null>("pick_source_file");
      if (file) await applySourceFile(collectionId, file, "merge", true);
    } catch (err) { toast.error(`Could not open source file: ${message(err)}`); }
  }
  async function syncSourceNow(collectionId: string, mode: "merge" | "replace") {
    const source = sourceCollectionsRef.current.find((item) => item.id === collectionId)?.source;
    if (!source?.path) return;
    try {
      const file = await invoke<SourceFile>("read_source_file", { path: source.path });
      await applySourceFile(collectionId, file, mode, true);
    } catch (err) { toast.error(`Could not read source file: ${message(err)}`); }
  }
  async function exportFile() {
    try {
      const exported = await invoke<boolean>("export_store", { store });
      if (exported) toast.success("Workspace exported");
    } catch (err) {
      toast.error(`Could not export workspace: ${message(err)}`);
    }
  }
  function applyImport(mode: "merge" | "replace") {
    if (!incoming) return;
    if (mode === "replace") {
      setStore(withDefaultEnvironment(incoming));
      setSelectedId(incoming.collections[0]?.requests[0]?.id ?? null);
      setTabs([]);
    } else setStore(withDefaultEnvironment(mergeWorkspace(store, incoming).next));
    setRuntime({});
    setResponse(null);
    setIncoming(null);
  }
  function resetWorkspaceSession(next: Store) {
    const firstId = next.collections[0]?.requests[0]?.id ?? null;
    setSelectedId(firstId);
    setTabs(firstId ? [firstId] : []);
    setRuntime({});
    setResponse(null);
    setHistory([]);
    setExpandedHistory(null);
    setError("");
    setCookieText("");
    setSourceStatus({});
    setConfigOpen(false);
    setConfigCollectionId(null);
    setContextMenu(null);
    setSearch("");
  }
  async function clearWorkspaceCookies() {
    try { await invoke("clear_cookies"); return true; }
    catch (err) { toast.error(`Could not clear session cookies: ${message(err)}`); return false; }
  }
  async function switchWorkspace(id: string) {
    if (busy || switchingWorkspace || id === workspaceData.activeWorkspaceId) { setWorkspaceDialogOpen(false); return; }
    const next = workspaceData.workspaces.find((item) => item.id === id);
    if (!next) return;
    setSwitchingWorkspace(true);
    if (!await clearWorkspaceCookies()) { setSwitchingWorkspace(false); return; }
    activeWorkspaceRef.current = id;
    setWorkspaceData((previous) => ({ ...previous, activeWorkspaceId: id }));
    resetWorkspaceSession(next.store);
    setWorkspaceDialogOpen(false);
    setSwitchingWorkspace(false);
  }
  async function createWorkspace() {
    const name = newWorkspaceName.trim();
    if (!name || busy || switchingWorkspace) return;
    setSwitchingWorkspace(true);
    if (!await clearWorkspaceCookies()) { setSwitchingWorkspace(false); return; }
    const id = uid();
    const next = emptyStore();
    activeWorkspaceRef.current = id;
    setWorkspaceData((previous) => ({ ...previous, activeWorkspaceId: id, workspaces: [...previous.workspaces, { id, name, store: next }] }));
    resetWorkspaceSession(next);
    setNewWorkspaceName("");
    setWorkspaceDialogOpen(false);
    toast.success(`Created ${name}`);
    setSwitchingWorkspace(false);
  }
  async function deleteWorkspace(id: string) {
    if (workspaceData.workspaces.length === 1) return;
    const remaining = workspaceData.workspaces.filter((item) => item.id !== id);
    const wasActive = id === workspaceData.activeWorkspaceId;
    if (wasActive && !await clearWorkspaceCookies()) { setWorkspaceDialogOpen(true); return; }
    if (wasActive) activeWorkspaceRef.current = remaining[0].id;
    setWorkspaceData((previous) => ({ ...previous, workspaces: previous.workspaces.filter((item) => item.id !== id), activeWorkspaceId: wasActive ? remaining[0].id : previous.activeWorkspaceId }));
    if (wasActive) resetWorkspaceSession(remaining[0].store);
    setWorkspaceDialogOpen(true);
  }

  if (loadError) return <div className={`app kodama-${theme}`}><div className="load-failure"><img className="brand-icon brand-logo" src="/icon.svg" alt="" /><h1>Workspace unavailable</h1><p>{loadError}</p><button className="send" onClick={() => window.location.reload()}>Retry loading</button></div></div>;

  return (
    <TooltipProvider><div className={`app kodama-${theme}`}>
      <Toaster theme={theme} position="bottom-right" richColors />
      <header className="topbar">
        <div className="brand">
          <img className="brand-icon brand-logo" src="/icon.svg" alt="" />
          <strong>Kodama</strong>
          <button className="workspace-switcher" onClick={() => setWorkspaceDialogOpen(true)} title="Switch workspace"><span className="workspace-indicator" />{activeWorkspace.name}<ChevronDown size={13} /></button>
        </div>
        <div className="top-actions">
          <span className="saved">{!ready ? "Workspace unavailable" : saved ? "Saved locally" : "Saving…"}</span>
          <button className="subtle" onClick={importFile}>Import</button>
          <button className="subtle" onClick={importOpenApiFile}>Import OpenAPI</button>
          <button className="subtle" onClick={exportFile}>Export</button>
          <button className="subtle" onClick={() => setCurlDialog(true)}>Import cURL</button>
          <button className={`icon config-button${Object.values(sourceStatus).some((item) => item.error) ? " source-error" : ""}`} aria-label="Collection settings" title="Collection settings" onClick={() => { setConfigCollectionId(collection?.id ?? store.collections[0]?.id ?? null); setConfigOpen(true); }}><Settings2 size={17} /></button>
          <button
            className="icon theme"
            aria-label="Toggle theme"
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          >
            {theme === "dark" ? "☼" : "☾"}
          </button>
        </div>
      </header>
      <div className="workspace">
        <aside className="sidebar" style={{ width: sidebarWidth }}>
          <nav className="sidebar-tabs">
            {(["requests", "environments", "variables", "history"] as Sidebar[])
              .map((item) => (
                <button
                  key={item}
                  className={sidebar === item ? "active" : ""}
                  onClick={() => setSidebar(item)}
                >
                  {item === "requests"
                    ? "Explore"
                    : item === "environments"
                    ? "Envs"
                    : item === "variables"
                    ? "Vars"
                    : "History"}
                </button>
              ))}
          </nav>
          {sidebar === "requests" && (
            <div className="sidebar-body">
              <div className="side-heading">
                <strong>Collections</strong>
                <button
                  className="icon"
                  title="New collection"
                  onClick={() =>
                    editStore((next) => {
                      next.collections.push(newCollection());
                    })}
                >
                  ＋
                </button>
              </div>
              <input
                className="search"
                aria-label="Search requests"
                placeholder="Search requests…"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
              {visibleCollections.map(({ item, requests }) => {
                const requestRow = (value: ApiRequest, depth = 0) => (
                  <button
                    key={value.id}
                    draggable
                    className={`request-link${depth ? " nested" : ""}${selectedId === value.id ? " selected" : ""}${dragOverId === `request:${value.id}` ? " drop-target" : ""}`}
                    onClick={() => open(value.id)}
                    onContextMenu={(event) => showRequestMenu(event, value.id, item.id)}
                    onDragStart={(event) => startRequestDrag(event, value.id, item.id)}
                    onDragEnd={() => { draggingRequest.current = null; setDragOverId(null); }}
                    onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; setDragOverId(`request:${value.id}`); }}
                    onDragLeave={() => setDragOverId(null)}
                    onDrop={(event) => {
                      const insertAfter = event.clientY >= event.currentTarget.getBoundingClientRect().top + event.currentTarget.getBoundingClientRect().height / 2;
                      moveRequestTo(event, item.id, value.folderId, value.id, insertAfter);
                    }}
                  >
                    <span className={`method ${value.method.toLowerCase()}`}>{value.method}</span>
                    <span>{value.name}</span>
                  </button>
                );
                const renderFolder = (folder: typeof item.folders[number], depth = 0): React.ReactNode => {
                  const targetId = `folder:${item.id}:${folder.id}`;
                  const isCollapsed = collapsed.includes(folder.id);
                  return <div className={`folder-node${depth ? " child-folder" : ""}`} key={folder.id}>
                    <div
                      className={`folder-heading${dragOverId === targetId ? " drop-target" : ""}`}
                      onContextMenu={(event) => showFolderMenu(event, item.id, folder.id)}
                      onDragOver={(event) => { event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = "move"; setDragOverId(targetId); }}
                      onDragLeave={() => setDragOverId(null)}
                      onDrop={(event) => moveRequestTo(event, item.id, folder.id)}
                    >
                      <button
                        aria-label={`${isCollapsed ? "Expand" : "Collapse"} ${folder.name}`}
                        onClick={() => setCollapsed((previous) => previous.includes(folder.id) ? previous.filter((id) => id !== folder.id) : [...previous, folder.id])}
                        onDoubleClick={() => rename(folder.name, (name) => editCollection(item.id, (next) => {
                          const found = next.folders.find((value) => value.id === folder.id);
                          if (found) found.name = name;
                        }))}
                      >
                        {isCollapsed ? "▸" : "▾"} {folder.name}
                      </button>
                      <button className="icon" title="New request in folder" onClick={() => addRequest(item.id, folder.id)}>＋</button>
                      <button className="icon" title="New subfolder" onClick={() => editCollection(item.id, (next) => next.folders.push({ id: uid(), name: "New folder", parentId: folder.id }))}>▣</button>
                    </div>
                    {!isCollapsed && <>
                      {requests.filter((value) => value.folderId === folder.id).map((value) => requestRow(value, depth + 1))}
                      {item.folders.filter((value) => value.parentId === folder.id).map((child) => renderFolder(child, depth + 1))}
                    </>}
                  </div>;
                };
                const folderIds = new Set(item.folders.map((folder) => folder.id));
                const rootFolders = item.folders.filter((folder) => !folder.parentId || !folderIds.has(folder.parentId));
                return <div className="collection" key={item.id}>
                  <div className="collection-heading">
                    <button
                      className={`collection-name${dragOverId === `root:${item.id}` ? " drop-target" : ""}`}
                      onClick={() =>
                        setCollapsed((previous) =>
                          previous.includes(item.id)
                            ? previous.filter((id) =>
                              id !== item.id
                            )
                            : [...previous, item.id]
                        )}
                      onDoubleClick={() =>
                        rename(item.name, (name) =>
                          editCollection(item.id, (next) => {
                            next.name = name;
                          }))}
                      onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; setDragOverId(`root:${item.id}`); }}
                      onDragLeave={() => setDragOverId(null)}
                      onDrop={(event) => moveRequestTo(event, item.id, null)}
                      onContextMenu={(event) => showCollectionMenu(event, item.id)}
                    >
                      {collapsed.includes(item.id) ? "▸" : "▾"} {item.name}
                    </button>
                    <button
                      className="icon"
                      title="New request"
                      onClick={() => addRequest(item.id)}
                    >
                      ＋
                    </button>
                    <button
                      className="icon"
                      title="New folder"
                      onClick={() =>
                        editCollection(item.id, (next) => {
                          next.folders.push({
                            id: uid(),
                            name: "New folder",
                            parentId: null,
                          });
                        })}
                    >
                      ▣
                    </button>
                  </div>
                  {!collapsed.includes(item.id) && (
                    <>
                      {requests.filter((value) => !value.folderId).map((value) => requestRow(value))}
                      {rootFolders.map((folder) => renderFolder(folder))}
                    </>
                  )}
                </div>;
              })}
            </div>
          )}
          {sidebar === "environments" && (
            <div className="sidebar-body">
              <div className="side-heading">
                <strong>Environments</strong>
                <button
                  className="icon"
                  onClick={() =>
                    editStore((next) => {
                      next.environments.push({
                        id: uid(),
                        name: "New environment",
                        variables: [],
                      });
                      if (!next.activeEnvironmentId) {
                        next.activeEnvironmentId = next.environments[next.environments.length - 1].id;
                      }
                    })}
                >
                  ＋
                </button>
              </div>
              <select
                aria-label="Active environment"
                value={store.activeEnvironmentId ?? ""}
                onChange={(event) =>
                  editStore((next) => {
                    next.activeEnvironmentId = event.target.value || null;
                  })}
              >
                <option value="">No environment</option>
                {store.environments.map((item) => (
                  <option key={item.id} value={item.id}>{item.name}</option>
                ))}
              </select>
              {store.environments.map((item) => (
                <div className="environment-card" key={item.id}>
                  <div className="environment-heading">
                    <strong>{item.name}</strong>
                    <button
                      className="icon"
                      onClick={() =>
                        rename(item.name, (name) =>
                          editStore((next) => {
                            const target = next.environments.find((value) =>
                              value.id === item.id
                            );
                            if (target) {
                              target.name = name;
                            }
                          }))}
                    >
                      ✎
                    </button>
                    <button
                      className="icon"
                      onClick={() =>
                        editStore((next) => {
                          next.environments = next.environments.filter(
                            (value) =>
                              value.id !== item.id,
                          );
                          if (next.activeEnvironmentId === item.id) {
                            next.activeEnvironmentId = next.environments[0]?.id ?? null;
                          }
                        })}
                    >
                      ×
                    </button>
                  </div>
                  <VariableEditor
                    rows={item.variables}
                    onChange={(rows) =>
                      editStore((next) => {
                        const target = next.environments.find((value) =>
                          value.id === item.id
                        );
                        if (target) {
                          target.variables = rows;
                        }
                      })}
                  />
                </div>
              ))}
            </div>
          )}
          {sidebar === "variables" && (
            <div className="sidebar-body">
              <div className="side-heading">
                <strong>Variables</strong>
              </div>
              <p className="hint">
                Runtime &gt; environment &gt; collection. Use{" "}
                <code>{"{{NAME}}"}</code> or <code>{"{{_.TOKEN}}"}</code>{" "}
                for runtime only.
              </p>
              <div className="scope-title">Runtime · this session</div>
              <button className="text-button" onClick={() => setRuntime((previous) => { let index = 1; while (`VAR_${index}` in previous) index++; return { ...previous, [`VAR_${index}`]: "" }; })}>+ Add runtime variable</button>
              {Object.keys(runtime).length
                ? Object.entries(runtime).map(([name, value]) => (
                  <div className="runtime-editor" key={name}>
                    <span>_.</span><input aria-label="Runtime variable name" defaultValue={name} onBlur={(event) => { const nextName = event.target.value.trim().replace(/^_\./, ""); if (!nextName || nextName === name) { event.target.value = name; return; } if (nextName in runtime) { toast.error("Variable already exists"); event.target.value = name; return; } setRuntime((previous) => { const next = { ...previous }; delete next[name]; next[nextName] = value; return next; }); }} />
                    <input aria-label={`Value for ${name}`} value={value} onChange={(event) => setRuntime((previous) => ({ ...previous, [name]: event.target.value }))} />
                    <button
                      className="icon"
                      aria-label={`Remove ${name}`}
                      onClick={() =>
                        setRuntime((previous) => {
                          const next = { ...previous };
                          delete next[name];
                          return next;
                        })}
                    >
                      ×
                    </button>
                  </div>
                ))
                : <p className="hint">Run Login to set TOKEN.</p>}
              {collection && (
                <>
                  <div className="scope-title">
                    {collection.name} · collection
                  </div>
                  <VariableEditor
                    rows={collection.variables}
                    onChange={(rows) =>
                      editCollection(collection.id, (next) => {
                        next.variables = rows;
                      })}
                  />
                </>
              )}
              <div className="scope-title">Defaults</div>
              <VariableEditor
                rows={store.defaults ?? []}
                onChange={(rows) =>
                  editStore((next) => {
                    next.defaults = rows;
                  })}
              />
              <div className="scope-title">Resolved</div>
              {Object.entries(resolvedVariables).map(([name, item]) => (
                <div className="inspector" key={name}>
                  <code>{name}</code>
                  <Tooltip><TooltipTrigger asChild><span tabIndex={0}>{item.secret ? "••••••" : item.value}</span></TooltipTrigger>
                    <TooltipContent>{item.value || "Empty value"} · {item.source}</TooltipContent></Tooltip>
                </div>
              ))}
            </div>
          )}
          {sidebar === "history" && (
            <div className="sidebar-body">
              <div className="side-heading">
                <strong>Recent requests</strong>
                <button className="text-button" onClick={() => setHistory([])}>
                  Clear
                </button>
              </div>
              {history.length
                ? history.map((item) => (
                  <div className="history-record" key={item.id}><button className="history-item" onClick={() => setExpandedHistory((previous) => previous === item.id ? null : item.id)} aria-expanded={expandedHistory === item.id}>
                    <span className={`method ${item.method.toLowerCase()}`}>
                      {item.method}
                    </span>
                    <strong>{item.name}</strong>
                    <span className={item.status !== null && item.status < 400 ? "success" : "failure"}>
                      {item.status ?? "Error"}
                    </span>
                    <small>{item.time} ms</small>
                  </button>{expandedHistory === item.id && <div className="history-detail">
                    <time>{new Date(item.date).toLocaleString()}</time>
                    <code title={item.url}>{item.url}</code>
                    {item.error ? <span className="failure">{item.error}</span> : <span>{(item.size / 1024).toFixed(1)} KB · {item.headerCount} response headers</span>}
                    <div className="history-detail-actions"><button className="subtle small" disabled={!item.response || !findRequest(store, item.requestId)} title={item.response ? "Open saved response" : "Large and binary response bodies are not retained in history"} onClick={() => { if (item.response) { open(item.requestId); setResponse(item.response); } }}>Open response</button><button className="subtle small" onClick={() => { void navigator.clipboard.writeText(item.url).then(() => toast.success("URL copied")); }}>Copy URL</button></div>
                  </div>}</div>
                ))
                : (
                  <p className="hint">
                    Requests sent this session appear here.
                  </p>
                )}
            </div>
          )}
          <div className="sidebar-footer">
            <span className="online-dot"></span> {activeWorkspace.name}{" "}
            <span>v0.1</span>
          </div>
        </aside>
        <div
          className="sidebar-resizer"
          role="separator"
          aria-label="Resize sidebar"
          aria-orientation="vertical"
          aria-valuenow={sidebarWidth}
          tabIndex={0}
          onPointerDown={(event) => {
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
            document.body.classList.add("resizing-sidebar");
          }}
          onPointerMove={(event) => { if (event.buttons === 1) resizeSidebar(event.movementX); }}
          onPointerUp={() => { document.body.classList.remove("resizing-sidebar"); }}
          onLostPointerCapture={() => { document.body.classList.remove("resizing-sidebar"); }}
          onKeyDown={(event) => {
            if (event.key === "ArrowLeft") { event.preventDefault(); resizeSidebar(-20); }
            if (event.key === "ArrowRight") { event.preventDefault(); resizeSidebar(20); }
          }}
        />
        <main className="main">
          <div className="tabs">
            {tabs.map((id) => {
              const item = findRequest(store, id)?.request;
              return item && (
                <button
                  key={id}
                  className={`tab${selectedId === id ? " active" : ""}${draggingTabId === id ? " dragging" : ""}${tabDropTarget?.id === id && draggingTabId !== id ? (tabDropTarget.after ? " drop-after" : " drop-before") : ""}`}
                  title="Drag to reorder tabs"
                  onClick={() => open(id)}
                  draggable
                  onDragStart={(event) => { setDraggingTabId(id); event.dataTransfer.setData("text/plain", id); event.dataTransfer.effectAllowed = "move"; }}
                  onDragEnd={() => { setDraggingTabId(null); setTabDropTarget(null); }}
                  onDragOver={(event) => {
                    event.preventDefault();
                    event.dataTransfer.dropEffect = "move";
                    const rect = event.currentTarget.getBoundingClientRect();
                    setTabDropTarget({ id, after: event.clientX > rect.left + rect.width / 2 });
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    const from = tabs.indexOf(draggingTabId ?? event.dataTransfer.getData("text/plain"));
                    const target = tabs.indexOf(id);
                    const rect = event.currentTarget.getBoundingClientRect();
                    const after = event.clientX > rect.left + rect.width / 2;
                    setDraggingTabId(null);
                    setTabDropTarget(null);
                    if (from < 0 || target < 0 || from === target) return;
                    const reordered = [...tabs];
                    const [moving] = reordered.splice(from, 1);
                    const insertion = target + (after ? 1 : 0) - (from < target ? 1 : 0);
                    reordered.splice(insertion, 0, moving);
                    setTabs(reordered);
                  }}
                  onContextMenu={(event) => showTabMenu(event, id)}
                >
                  <GripVertical className="tab-grip" size={14} aria-hidden="true" />
                  <span className={`method ${item.method.toLowerCase()}`}>
                    {item.method}
                  </span>
                  <span className="tab-name">{item.name}</span>
                  {!saved && selectedId === id && (
                    <span className="unsaved-dot">•</span>
                  )}
                  <span
                    className="tab-close"
                    onClick={(event) => {
                      event.stopPropagation();
                      setTabs((previous) =>
                        previous.filter((value) => value !== id)
                      );
                      if (selectedId === id) setSelectedId(null);
                    }}
                  >
                    ×
                  </span>
                </button>
              );
            })}
            <div className="tab-fill"></div>
            <div className="active-env">
              <span className={`environment-dot ${environment ? "active" : ""}`} aria-hidden="true" />
              <strong>{environment?.name ?? "No environment"}</strong>
            </div>
          </div>
          {request && collection
            ? (
              <>
                <div className="request-area">
                  <div className="request-heading">
                    <div>
                      <div className="eyebrow">
                        {collection.name}
                        {request.folderId
                          ? ` / ${
                            collection.folders.find((item) =>
                              item.id === request.folderId
                            )?.name ?? "Folder"
                          }`
                          : ""}
                      </div>
                      <input
                        className="request-title"
                        aria-label="Request name"
                        value={request.name}
                        onChange={(event) =>
                          editRequest((next) => {
                            next.name = event.target.value;
                          })}
                      />
                    </div>
                    <div className="request-tools">
                      <button
                        className="subtle small"
                        onClick={duplicateRequest}
                      >
                        Duplicate
                      </button>
                      <button className="subtle small" onClick={() => { void navigator.clipboard.writeText(exportCurl(request)).then(() => toast.success("cURL copied"), (err) => toast.error(message(err))); }}>Copy cURL</button>
                      <button
                        className="subtle small"
                        onClick={() => moveRequest(-1)}
                      >
                        ↑
                      </button>
                      <button
                        className="subtle small"
                        onClick={() => moveRequest(1)}
                      >
                        ↓
                      </button>
                      <button
                        className="subtle small danger"
                        onClick={removeRequest}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                  <div className="urlbar">
                    <select
                      aria-label="HTTP method"
                      className={`method-select ${request.method.toLowerCase()}`}
                      value={request.method}
                      onChange={(event) =>
                        editRequest((next) => {
                          next.method = event.target.value;
                        })}
                    >
                      {[
                        "GET",
                        "POST",
                        "PUT",
                        "PATCH",
                        "DELETE",
                        "HEAD",
                        "OPTIONS",
                      ].map((method) => <option key={method}>{method}</option>)}
                    </select>
                    <VariableField
                      label="Request URL"
                      variables={resolvedVariables}
                      placeholder="https://api.example.com/resource"
                      value={request.url}
                      onChange={(value) =>
                        editRequest((next) => {
                          next.url = value;
                          const names = pathParamNames(value);
                          next.pathParams = names.map((name) => next.pathParams?.find((row) => row.key === name) ?? { ...entry(), key: name });
                        })}
                    />
                    <button
                      className="send"
                      onClick={busy
                        ? () => {
                          void invoke("cancel_request", { id: request.id });
                        }
                        : send}
                    >
                      {busy ? "Cancel" : "Send"} ↗
                    </button>
                  </div>
                  {urlPreview && <div className="url-preview" aria-label="URL preview">
                    <span>Preview</span>
                    <code title={urlPreview}>{urlPreview}</code>
                  </div>}
                  {!request.trusted &&
                    (request.preScript || request.postScript) && (
                    <div className="trust">
                      <div>
                        <strong>Imported scripts are disabled</strong>
                        <span>Review both scripts before enabling them.</span>
                      </div>
                      <button
                        onClick={() =>
                          editRequest((next) => {
                            next.trusted = true;
                          })}
                      >
                        Trust scripts
                      </button>
                    </div>
                  )}
                  <nav className="editor-tabs">
                    {([
                      "params",
                      "headers",
                      "auth",
                      "body",
                      "pre",
                      "post",
                    ] as Panel[]).map((item) => (
                      <button
                        key={item}
                        className={panel === item ? "active" : ""}
                        onClick={() => setPanel(item)}
                      >
                        {item === "pre"
                          ? "Pre-request"
                          : item === "post"
                          ? "Post-response"
                          : item[0].toUpperCase() + item.slice(1)}
                        {(item === "pre" && request.preScript ||
                            item === "post" && request.postScript)
                          ? <span className="dot">•</span>
                          : null}
                      </button>
                    ))}
                  </nav>
                  <div className="editor">
                    {panel === "params" && (
                      <div className="params-editor">{pathParamNames(request.url).length > 0 && <><div className="scope-title">Path parameters</div><p className="hint">Use <code>:id</code> in the URL, then set its value here.</p>{(request.pathParams ?? []).map((row) => <div className="path-param-row" key={row.id}><code>:{row.key}</code><VariableField label={`Path parameter ${row.key}`} variables={resolvedVariables} value={row.value} placeholder={`Value for ${row.key}`} onChange={(value) => editRequest((next) => { const target = next.pathParams.find((item) => item.id === row.id); if (target) target.value = value; })} /></div>)}</>}
                      <div className="scope-title">Query parameters</div><Entries
                        name="Parameter"
                        variables={resolvedVariables}
                        rows={request.query}
                        onChange={(rows) =>
                          editRequest((next) => {
                            next.query = rows;
                          })}
                      /></div>
                    )}
                    {panel === "headers" && (
                      <Entries
                        name="Header"
                        variables={resolvedVariables}
                        rows={request.headers}
                        onChange={(rows) =>
                          editRequest((next) => {
                            next.headers = rows;
                          })}
                      />
                    )}
                    {panel === "auth" && (
                      <div className="auth-editor">
                        <label>Authorization</label>
                        <select
                          value={request.auth.kind || "none"}
                          onChange={(event) =>
                            editRequest((next) => {
                              next.auth.kind = event.target.value;
                            })}
                        >
                          <option value="none">No auth</option>
                          <option value="basic">Basic auth</option>
                          <option value="bearer">Bearer token</option>
                        </select>
                        {request.auth.kind === "basic" && (
                          <div className="auth-fields">
                            <input
                              placeholder="Username"
                              value={request.auth.username}
                              onChange={(event) =>
                                editRequest((next) => {
                                  next.auth.username = event.target.value;
                                })}
                            />
                            <input
                              type="password"
                              placeholder="Password"
                              value={request.auth.password}
                              onChange={(event) =>
                                editRequest((next) => {
                                  next.auth.password = event.target.value;
                                })}
                            />
                          </div>
                        )}
                        {request.auth.kind === "bearer" && (
                          <VariableField
                            label="Bearer token"
                            variables={resolvedVariables}
                            placeholder="Token or {{_.TOKEN}}"
                            value={request.auth.token}
                            onChange={(value) =>
                              editRequest((next) => {
                                next.auth.token = value;
                              })}
                          />
                        )}
                        <label>Timeout (milliseconds, 100–300000)</label>
                        <input
                          type="number"
                          min="100"
                          max="300000"
                          placeholder="30000"
                          value={request.timeoutMs ?? ""}
                          onChange={(event) =>
                            editRequest((next) => {
                              next.timeoutMs = event.target.value
                                ? Number(event.target.value)
                                : null;
                            })}
                        />
                      </div>
                    )}
                    {panel === "body" && (
                      <div className="body-editor">
                        <div className="body-types">
                          {["none", "json", "text", "form", "multipart"].map(
                            (kind) => (
                              <label key={kind}>
                                <input
                                  type="radio"
                                  checked={request.body.kind === kind}
                                  onChange={() =>
                                    editRequest((next) => {
                                      next.body.kind = kind;
                                    })}
                                />
                                {kind === "form"
                                  ? "URL encoded"
                                  : kind.toUpperCase()}
                              </label>
                            ),
                          )}
                          {request.body.kind === "json" && <button className="subtle small" onClick={() => { try { const formatted = JSON.stringify(JSON.parse(request.body.text.trim() || "{}"), null, 2); editRequest((next) => { next.body.text = formatted; }); toast.success("JSON formatted"); } catch (err) { toast.error(`Invalid JSON: ${message(err)}`); } }}>Format JSON</button>}
                        </div>
                        {["json", "text"].includes(request.body.kind) && (
                          <Suspense fallback={<div className="code-editor-loading">Loading editor…</div>}>
                          <CodeEditor
                            label="Request body"
                            variables={resolvedVariables}
                            theme={theme}
                            language={request.body.kind === "json" ? "json" : "text"}
                            value={request.body.text}
                            onChange={(value) =>
                              editRequest((next) => {
                                next.body.text = value;
                              })}
                          />
                          </Suspense>
                        )}
                        {["form", "multipart"].includes(request.body.kind) && (
                          <Entries
                            name="Field"
                            variables={resolvedVariables}
                            rows={request.body.fields}
                            onChange={(rows) =>
                              editRequest((next) => {
                                next.body.fields = rows;
                              })}
                          />
                        )}
                      </div>
                    )}
                    {(panel === "pre" || panel === "post") && (
                      <div className="script-editor">
                        <div className="script-heading">
                          <span>
                            JavaScript · {panel === "pre"
                              ? "before request"
                              : "after response"}
                          </span>
                          <code>
                            {panel === "post"
                              ? "_.TOKEN = response.json().token;"
                              : "_.NOW = new Date().toISOString();"}
                          </code>
                        </div>
                        <Suspense fallback={<div className="code-editor-loading">Loading editor…</div>}><CodeEditor
                          label={`${panel} script`}
                          language="javascript"
                          theme={theme}
                          variables={resolvedVariables}
                          value={panel === "pre"
                            ? request.preScript
                            : request.postScript}
                          onChange={(value) =>
                            editRequest((next) => {
                              if (panel === "pre") {
                                next.preScript = value;
                              } else next.postScript = value;
                            })}
                        /></Suspense>
                        <p className="hint">
                          Use <code>_</code> for variables, <code>request</code>
                          {" "}
                          for the request{panel === "post"
                            ? ", and response.status, response.text(), response.json(), response.header(\"Header-Name\")"
                            : ""}. Writes commit only if the script succeeds.
                        </p>
                      </div>
                    )}
                  </div>
                </div>
                <section className="response-panel">
                  <div className="response-top">
                    <div>
                      <strong>Response</strong>
                      {response && (
                        <>
                          <span
                            className={`status ${
                              response.status < 400 ? "ok" : "bad"
                            }`}
                          >
                            {response.status} {response.statusText}
                          </span>
                          <span className="metric">
                            ◷ {response.elapsedMs} ms
                          </span>
                          <span className="metric">
                            {(response.size / 1024).toFixed(1)} KB
                          </span>
                        </>
                      )}
                    </div>
                    <nav>
                      <button
                        className={responseView === "body" ? "active" : ""}
                        onClick={() => setResponseView("body")}
                      >
                        Body
                      </button>
                      <button
                        className={responseView === "headers" ? "active" : ""}
                        onClick={() => setResponseView("headers")}
                      >
                        Headers
                      </button>
                      <button className={responseView === "cookies" ? "active" : ""} onClick={() => setResponseView("cookies")}>Cookies</button>
                    </nav>
                  </div>
                  {response && !response.binary && responseView === "body" && <div className="response-find">
                    <input aria-label="Find in response" placeholder="Find in response" value={responseSearch} onChange={(event) => setResponseSearch(event.target.value)} />
                    <span>{responseSearch ? `${responseMatches} matches` : ""}</span>
                    <button className="subtle small" onClick={() => { void navigator.clipboard.writeText(responseBody).then(() => toast.success("Response copied"), (err) => toast.error(message(err))); }}>Copy</button>
                  </div>}
                  {response && <div className="response-details">
                    <span className="response-content-type">{responseContentType.split(";")[0]}</span>
                    <span className="response-url" title={response.url}>{response.url}</span>
                  </div>}
                  {response && responseView === "body" && responseIsHtml && <div className="response-notice">
                    This endpoint returned an HTML page. If you expected JSON, check that the API hostname and route are correct; some sites return their frontend page for unknown API paths.
                  </div>}
                  {error
                    ? (
                      <div className="response-error">
                        <strong>Could not complete request</strong>
                        <p>{error}</p>
                      </div>
                    )
                    : response
                    ? responseView === "cookies"
                      ? <div className="response-headers"><p>Session cookies for {response.url}</p><pre>{cookieText || "No cookies for this URL"}</pre><button className="subtle small" onClick={() => { void invoke("clear_cookies").then(() => { setCookieText(""); toast.success("Session cookies cleared"); }, (err) => toast.error(message(err))); }}>Clear session cookies</button></div>
                    : responseView === "body"
                      ? response.binary
                        ? (
                          <div className="binary">
                            Binary response · {response.size} bytes{" "}
                            <a
                              download="response.bin"
                              href={`data:application/octet-stream;base64,${response.body}`}
                            >
                              Download file
                            </a>
                          </div>
                        )
                        : <pre className="response-body">{highlightedResponse()}</pre>
                      : (
                        <div className="response-headers">
                          {response.headers.map(([key, value], index) => (
                            <div key={`${key}-${index}`}>
                              <strong>{key}</strong>
                              <span>
                                {/authorization|cookie|token/i.test(key)
                                  ? "••••••"
                                  : value}
                              </span>
                              <button className="subtle small" title={`Save ${key} as runtime variable`} onClick={() => setHeaderVariable({ name: key.replace(/[^A-Za-z0-9_]/g, "_").toUpperCase(), value })}>Save to _.</button>
                            </div>
                          ))}
                        </div>
                      )
                    : (
                      <div className="response-empty">
                        <img src="/icon.svg" alt="" />
                        <strong>Ready when you are</strong>
                        <p>Send a request to inspect the response here.</p>
                      </div>
                    )}
                </section>
              </>
            )
            : (
              <div className="welcome">
                <img src="/icon.svg" alt="" />
                <h1>Your API workspace</h1>
                <p>Choose a request or start a collection.</p>
                <button
                  className="send"
                  onClick={() =>
                    editStore((next) => {
                      next.collections.push(newCollection());
                    })}
                >
                  New collection
                </button>
              </div>
            )}
        </main>
      </div>
      {contextMenu && <div
        className="context-menu"
        role="menu"
        style={{ left: contextMenu.x, top: contextMenu.y }}
        onPointerDown={(event) => event.stopPropagation()}
        onContextMenu={(event) => event.preventDefault()}
      >
        {contextMenu.kind === "request" ? (() => {
          const target = findRequest(store, contextMenu.requestId);
          if (!target) return null;
          const requestId = contextMenu.requestId;
          const collectionId = contextMenu.collectionId;
          return <>
            <div className="context-menu-label">{target.request.name}</div>
            <button role="menuitem" onClick={() => { setContextMenu(null); rename(target.request.name, (name) => editCollection(collectionId, (next) => { const found = next.requests.find((item) => item.id === requestId); if (found) found.name = name; })); }}>Rename</button>
            <button role="menuitem" onClick={() => { duplicateRequestById(requestId, collectionId); setContextMenu(null); }}>Duplicate</button>
            <button role="menuitem" onClick={() => { open(requestId); setContextMenu(null); }}>Open in tab</button>
            <button role="menuitem" onClick={() => { const curl = exportCurl(target.request); void navigator.clipboard.writeText(curl).then(() => toast.success("cURL copied")).catch(() => toast.error("Could not copy cURL")); setContextMenu(null); }}>Copy cURL</button>
            <div className="context-menu-separator" />
            <button role="menuitem" className="danger" onClick={() => { removeRequestById(requestId, collectionId); setContextMenu(null); }}>Delete</button>
          </>;
        })() : contextMenu.kind === "tab" ? <>
          <div className="context-menu-label">{findRequest(store, contextMenu.requestId)?.request.name ?? "Request tab"}</div>
          <button role="menuitem" onClick={() => { closeTab(contextMenu.requestId); setContextMenu(null); }}>Close</button>
          <button role="menuitem" onClick={() => { closeTabsByRelation(contextMenu.requestId, "others"); setContextMenu(null); }}>Close others</button>
          <button role="menuitem" onClick={() => { closeTabsByRelation(contextMenu.requestId, "right"); setContextMenu(null); }}>Close other tabs to the right</button>
          <button role="menuitem" onClick={() => { closeTabsByRelation(contextMenu.requestId, "left"); setContextMenu(null); }}>Close other tabs to the left</button>
        </> : contextMenu.kind === "folder" ? (() => {
          const collectionId = contextMenu.collectionId;
          const folder = store.collections.find((item) => item.id === collectionId)?.folders.find((item) => item.id === contextMenu.folderId);
          if (!folder) return null;
          return <>
            <div className="context-menu-label">Folder · {folder.name}</div>
            <button role="menuitem" onClick={() => { setContextMenu(null); rename(folder.name, (name) => editCollection(collectionId, (next) => { const target = next.folders.find((item) => item.id === folder.id); if (target) target.name = name; })); }}>Rename</button>
            <button role="menuitem" onClick={() => { addRequest(collectionId, folder.id); setCollapsed((previous) => previous.filter((id) => id !== collectionId && id !== folder.id)); setContextMenu(null); }}>New request</button>
            <button role="menuitem" onClick={() => { editCollection(collectionId, (next) => next.folders.push({ id: uid(), name: "New folder", parentId: folder.id })); setCollapsed((previous) => previous.filter((id) => id !== collectionId && id !== folder.id)); setContextMenu(null); }}>New subfolder</button>
            <div className="context-menu-separator" />
            <button role="menuitem" className="danger" onClick={() => { deleteFolderById(collectionId, folder.id); setContextMenu(null); }}>Delete folder</button>
          </>;
        })() : (() => {
          const target = store.collections.find((item) => item.id === contextMenu.collectionId);
          if (!target) return null;
          return <>
            <div className="context-menu-label">Collection · {target.name}</div>
            <button role="menuitem" onClick={() => { setContextMenu(null); rename(target.name, (name) => editCollection(target.id, (next) => { next.name = name; })); }}>Rename</button>
            <button role="menuitem" onClick={() => { addRequest(target.id); setContextMenu(null); }}>New request</button>
            <button role="menuitem" onClick={() => { editCollection(target.id, (next) => next.folders.push({ id: uid(), name: "New folder", parentId: null })); setContextMenu(null); }}>New folder</button>
            <button role="menuitem" onClick={() => { setConfigCollectionId(target.id); setConfigOpen(true); setContextMenu(null); }}>Configure source…</button>
            <div className="context-menu-separator" />
            <button role="menuitem" className="danger" onClick={() => { deleteCollectionById(target.id); setContextMenu(null); }}>Delete collection</button>
          </>;
        })()}
      </div>}
      <Dialog open={!!incoming} onOpenChange={(open) => { if (!open) setIncoming(null); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>Bring in this workspace?</DialogTitle><DialogDescription>
            {incoming?.collections.length ?? 0} {(incoming?.collections.length ?? 0) === 1 ? "collection" : "collections"} and {incoming?.environments.length ?? 0} {(incoming?.environments.length ?? 0) === 1 ? "environment" : "environments"}. Imported scripts stay disabled until you review and trust each request.
          </DialogDescription></DialogHeader>
          <p className="hint">
            {(() => {
              const skipped = incoming ? mergeWorkspace(store, incoming).skipped : 0;
              return skipped
                ? `Merge will skip ${skipped} imported ${skipped === 1 ? "item" : "items"} because their IDs already exist. If this is a backup you want to restore, choose Replace.`
                : "Merge adds the imported items to your current workspace. Replace removes the current workspace and restores this import.";
            })()}
          </p>
          <DialogFooter><button className="subtle" onClick={() => setIncoming(null)}>Cancel</button><button className="subtle" onClick={() => applyImport("merge")}>Merge</button><button className="send" onClick={() => applyImport("replace")}>Replace</button></DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={!!renameDialog} onOpenChange={(open) => { if (!open) setRenameDialog(null); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>Rename {renameDialog?.name}</DialogTitle><DialogDescription>Enter a name for this item.</DialogDescription></DialogHeader>
          <form onSubmit={(event) => { event.preventDefault(); const name = renameValue.trim(); if (name) { renameDialog?.apply(name); setRenameDialog(null); } }}>
            <input autoFocus aria-label="New name" className="dialog-input" value={renameValue} onChange={(event) => setRenameValue(event.target.value)} />
            <DialogFooter><button className="subtle" type="button" onClick={() => setRenameDialog(null)}>Cancel</button><button className="send" type="submit" disabled={!renameValue.trim()}>Save</button></DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog open={curlDialog} onOpenChange={setCurlDialog}>
        <DialogContent>
          <DialogHeader><DialogTitle>Import cURL</DialogTitle><DialogDescription>Paste a cURL command to add a request to the current collection.</DialogDescription></DialogHeader>
          <textarea className="curl-input" aria-label="cURL command" placeholder="curl -X POST https://api.example.com" value={curlText} onChange={(event) => setCurlText(event.target.value)} />
          <DialogFooter><button className="subtle" onClick={() => setCurlDialog(false)}>Cancel</button><button className="send" onClick={() => { try { const item = importCurl(curlText); const id = collection?.id ?? store.collections[0]?.id; if (!id) throw new Error("Create a collection first"); editCollection(id, (next) => next.requests.push(item)); open(item.id); setCurlDialog(false); setCurlText(""); toast.success("Request imported"); } catch (err) { toast.error(message(err)); } }}>Import request</button></DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={workspaceDialogOpen} onOpenChange={setWorkspaceDialogOpen}>
        <DialogContent className="workspace-dialog">
          <DialogHeader><DialogTitle>Workspaces</DialogTitle><DialogDescription>Keep each project's requests, environments, and variables together. Import and export work on the selected workspace.</DialogDescription></DialogHeader>
          <div className="workspace-list">
            {workspaceData.workspaces.map((item) => <div className={`workspace-list-item${item.id === workspaceData.activeWorkspaceId ? " active" : ""}`} key={item.id}>
              <button className="workspace-select" disabled={busy || switchingWorkspace} onClick={() => void switchWorkspace(item.id)}><span className="workspace-indicator" /><span><strong>{item.name}</strong><small>{item.store.collections.length} collections · {item.store.environments.length} environments</small></span>{item.id === workspaceData.activeWorkspaceId && <span className="workspace-current">Current</span>}</button>
              <button className="icon" aria-label={`Rename ${item.name}`} title="Rename workspace" onClick={() => { setWorkspaceDialogOpen(false); rename(item.name, (name) => { setWorkspaceData((previous) => ({ ...previous, workspaces: previous.workspaces.map((workspace) => workspace.id === item.id ? { ...workspace, name } : workspace) })); setWorkspaceDialogOpen(true); }); }}><Pencil size={14} /></button>
              <button className="icon danger" aria-label={`Delete ${item.name}`} title={workspaceData.workspaces.length === 1 ? "Keep at least one workspace" : "Delete workspace"} disabled={workspaceData.workspaces.length === 1 || busy || switchingWorkspace} onClick={() => { setWorkspaceDialogOpen(false); setDeleteDialog({ name: item.name, description: `This permanently removes ${item.name} and all its collections, requests, environments, and variables. Other workspaces stay intact.`, apply: () => { void deleteWorkspace(item.id); } }); }}><Trash2 size={14} /></button>
            </div>)}
          </div>
          <form className="workspace-create" onSubmit={(event) => { event.preventDefault(); void createWorkspace(); }}>
            <input aria-label="New workspace name" placeholder="New workspace name" value={newWorkspaceName} onChange={(event) => setNewWorkspaceName(event.target.value)} maxLength={80} />
            <button className="send" type="submit" disabled={!newWorkspaceName.trim() || busy || switchingWorkspace}>Create workspace</button>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog open={configOpen} onOpenChange={setConfigOpen}>
        <DialogContent className="source-config-dialog">
          <DialogHeader><DialogTitle>Collection settings</DialogTitle><DialogDescription>Link an OpenAPI JSON, JavaScript, or TypeScript file. Kodama reads the exported document without running the file.</DialogDescription></DialogHeader>
          {store.collections.length ? <>
            <label className="dialog-label" htmlFor="source-collection">Collection</label>
            <select id="source-collection" value={configCollectionId ?? ""} onChange={(event) => setConfigCollectionId(event.target.value)}>
              {store.collections.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
            {configCollection && <>
              <div className="source-config-section">
                <div className="source-config-heading"><strong>OpenAPI source</strong><span>{configCollection.source ? "Checking for changes every 5 seconds" : "No file linked"}</span></div>
                <code className="source-path">{configCollection.source?.path ?? "Choose a file to add and sync routes in this collection."}</code>
                {configCollection.source?.lastSyncedAt && <small>Last synced {new Date(configCollection.source.lastSyncedAt).toLocaleString()}</small>}
                {sourceStatus[configCollection.id] && <p className={`source-status${sourceStatus[configCollection.id].error ? " error" : ""}`}>{sourceStatus[configCollection.id].message}</p>}
                <div className="source-actions">
                  <button className="subtle" disabled={sourceStatus[configCollection.id]?.busy} onClick={() => void chooseSourceFile(configCollection.id)}>{configCollection.source ? "Change file" : "Choose file"}</button>
                  {configCollection.source && <>
                    <button className="subtle" disabled={sourceStatus[configCollection.id]?.busy} onClick={() => void syncSourceNow(configCollection.id, "merge")}>Sync now</button>
                    <button className="subtle" disabled={sourceStatus[configCollection.id]?.busy} onClick={() => { editCollection(configCollection.id, (next) => { delete next.source; }); setSourceStatus((previous) => { const next = { ...previous }; delete next[configCollection.id]; return next; }); }}>Unlink</button>
                  </>}
                </div>
              </div>
              {configCollection.source && <>
                <div className="source-config-section">
                  <button className="source-accordion-trigger" aria-expanded={variablesOpen} onClick={() => setVariablesOpen((previous) => !previous)}><span>{variablesOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}<strong>Collection variables</strong><em>{configCollection.variables.length}</em></span><small>Values you set here survive normal sync</small></button>
                  {variablesOpen && <div className="source-variable-list">{configCollection.variables.length ? configCollection.variables.map((item) => <label className="source-variable" key={item.id}><code>{item.name}</code><input aria-label={`Value for ${item.name}`} value={item.value} placeholder={`Set ${item.name}`} onChange={(event) => editCollection(configCollection.id, (next) => { const variable = next.variables.find((value) => value.id === item.id); if (variable) variable.value = event.target.value; })} /></label>) : <p className="hint">This source has no collection variables.</p>}</div>}
                </div>
                <div className="source-config-section source-replace">
                  <div><strong>Replace collection from source</strong><p>Removes local routes, folders, scripts, and collection variables, then imports the current file again.</p></div>
                  <button className="subtle danger" disabled={sourceStatus[configCollection.id]?.busy} onClick={() => { setConfigOpen(false); setReplaceSourceId(configCollection.id); }}>Replace collection</button>
                </div>
              </>}
            </>}
          </> : <p className="hint">Create a collection first, then link a source file.</p>}
        </DialogContent>
      </Dialog>
      <AlertDialog open={!!replaceSourceId} onOpenChange={(open) => { if (!open) setReplaceSourceId(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader><AlertDialogTitle>Replace this collection?</AlertDialogTitle><AlertDialogDescription>All current requests, scripts, folders, and collection variables in {store.collections.find((item) => item.id === replaceSourceId)?.name ?? "this collection"} will be replaced from its source file. Other collections and environments stay intact.</AlertDialogDescription></AlertDialogHeader>
          <AlertDialogFooter><AlertDialogCancel onClick={() => setConfigOpen(true)}>Cancel</AlertDialogCancel><AlertDialogAction onClick={() => { const id = replaceSourceId; setReplaceSourceId(null); setConfigOpen(true); if (id) void syncSourceNow(id, "replace"); }}>Replace collection</AlertDialogAction></AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <Dialog open={!!headerVariable} onOpenChange={(open) => { if (!open) setHeaderVariable(null); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>Save response header</DialogTitle><DialogDescription>Store this header value as a runtime variable for the current session.</DialogDescription></DialogHeader>
          <label className="dialog-label" htmlFor="header-var-name">Variable name</label>
          <input id="header-var-name" className="dialog-input" value={headerVariable?.name ?? ""} onChange={(event) => setHeaderVariable((previous) => previous && { ...previous, name: event.target.value })} />
          <DialogFooter><button className="subtle" onClick={() => setHeaderVariable(null)}>Cancel</button><button className="send" onClick={() => { if (!headerVariable) return; const name = headerVariable.name.trim().replace(/^_\./, ""); if (!/^[A-Za-z_][\w]*$/.test(name)) { toast.error("Use letters, numbers, and underscores for variable names"); return; } setRuntime((previous) => ({ ...previous, [name]: headerVariable.value })); setHeaderVariable(null); toast.success(`Saved _.${name}`); }}>Save variable</button></DialogFooter>
        </DialogContent>
      </Dialog>
      <AlertDialog open={!!deleteDialog} onOpenChange={(open) => { if (!open) setDeleteDialog(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader><AlertDialogTitle>Delete {deleteDialog?.name}?</AlertDialogTitle><AlertDialogDescription>{deleteDialog?.description ?? "This removes it from your workspace."}</AlertDialogDescription></AlertDialogHeader>
          <AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel><AlertDialogAction onClick={() => { deleteDialog?.apply(); setDeleteDialog(null); }}>Delete</AlertDialogAction></AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div></TooltipProvider>
  );
}

export default App;
