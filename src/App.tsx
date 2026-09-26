import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type React from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast, Toaster } from "sonner";
import { Check, ChevronDown, ChevronRight, ChevronUp, Ellipsis, Eye, EyeOff, Folder, FolderOpen, FolderPlus, GripVertical, PanelBottom, PanelRight, Pencil, Pin, Settings2, Trash2, X } from "lucide-react";
import { Select as SelectPrimitive } from "radix-ui";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { VariableField, type ResolvedVariable } from "./VariableField";
import { moveSiblingFolder, reorderSiblingFolder } from "./folderOrder";
import { variableHasValue, variableInspectorEntries } from "./variableResolution";
import { exportCurl, importCurl } from "./curl";
import { importOpenApi, type OpenApiRequestNames, type OpenApiScheme } from "./openapi";
import { bundleOpenApiRefs } from "./openapiRefs";
import { previewRequestUrl } from "./requestPreview";
import { parseOpenApiSource, type SourceFile } from "./sourceParser";
import { syncCollectionSource, type SyncSummary } from "./sourceSync";
import { savedTheme, themeGroups, themes, type ThemeId } from "./themes";
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
  freshWorkspaceData,
  emptyStore,
  entry,
  newCollection,
  newRequest,
  uid,
  variable,
} from "./types";
import "./App.css";
import "./themes.css";

type Panel = "params" | "headers" | "auth" | "body" | "pre" | "post";
const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
const CodeEditor = lazy(() => import("./CodeEditor").then((module) => ({ default: module.CodeEditor })));
type Sidebar = "requests" | "environments" | "variables" | "history";
type PointerDrag =
  | { kind: "request"; requestId: string; collectionId: string }
  | { kind: "collection"; collectionId: string }
  | { kind: "folder"; folderId: string; collectionId: string }
  | { kind: "tab"; requestId: string };
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
        <div className={`variable-row${row.secret ? " is-secret" : ""}`} key={row.id}>
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
          {row.secret && <button className="icon" aria-label={shown.includes(row.id) ? "Hide variable value" : "Show variable value"} title={shown.includes(row.id) ? "Hide value" : "Show value"} onClick={() => setShown((previous) => previous.includes(row.id) ? previous.filter((id) => id !== row.id) : [...previous, row.id])}>{shown.includes(row.id) ? <EyeOff size={15} /> : <Eye size={15} />}</button>}
          <label className="secret-toggle" title="Secret values stay hidden in variable editors">
            <input
              type="checkbox"
              role="switch"
              aria-label={`Secret variable ${row.name || "unnamed"}`}
              checked={row.secret}
              onChange={(event) => {
                const secret = event.target.checked;
                edit(row.id, "secret", secret);
                if (!secret) setShown((previous) => previous.filter((id) => id !== row.id));
              }}
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

function responseSizeBounds(dock: "bottom" | "right", available: number): [number, number] {
  if (dock === "bottom" && available > 0) {
    const minRequestHeight = Math.min(460, available * 0.72);
    return [Math.max(45, minRequestHeight / available * 100), 75];
  }
  return [25, 75];
}

function App() {
  const [workspaceData, setWorkspaceData] = useState<WorkspaceData>(freshWorkspaceData);
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
  const [pinnedByWorkspace, setPinnedByWorkspace] = useState<Record<string, string[]>>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("kodama.pinnedByWorkspace") ?? "{}");
      return Object.fromEntries(Object.entries(saved).filter(([, ids]) => Array.isArray(ids)).map(([id, ids]) => [id, (ids as unknown[]).filter((value): value is string => typeof value === "string")]));
    } catch { return {}; }
  });
  const pinnedTabs = pinnedByWorkspace[workspaceData.activeWorkspaceId] ?? [];
  const [panel, setPanel] = useState<Panel>("params");
  const [sidebar, setSidebar] = useState<Sidebar>("requests");
  const [search, setSearch] = useState("");
  const [searchCollapsed, setSearchCollapsed] = useState<string[]>([]);
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
  const [theme, setTheme] = useState<ThemeId>(() => savedTheme(localStorage.getItem("kodama.theme")));
  const [openApiRequestNames, setOpenApiRequestNames] = useState<OpenApiRequestNames>(() =>
    localStorage.getItem("kodama.openApiRequestNames") === "path" ? "path" : "summary"
  );
  const [openApiScheme, setOpenApiScheme] = useState<OpenApiScheme>(() => {
    const saved = localStorage.getItem("kodama.openApiScheme");
    return saved === "http" || saved === "https" ? saved : "document";
  });
  const [collapsedByWorkspace, setCollapsedByWorkspace] = useState<Record<string, string[]>>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("kodama.collapsedByWorkspace") ?? "{}");
      return Object.fromEntries(Object.entries(saved).filter(([, ids]) => Array.isArray(ids)).map(([id, ids]) => [id, (ids as unknown[]).filter((value): value is string => typeof value === "string")]));
    } catch { return {}; }
  });
  const collapsed = collapsedByWorkspace[workspaceData.activeWorkspaceId] ?? [];
  const setCollapsed = (update: React.SetStateAction<string[]>) => setCollapsedByWorkspace((previous) => {
    const id = workspaceData.activeWorkspaceId;
    const current = previous[id] ?? [];
    return { ...previous, [id]: typeof update === "function" ? update(current) : update };
  });
  const isNodeCollapsed = (id: string) => search ? searchCollapsed.includes(id) : collapsed.includes(id);
  const toggleNode = (id: string) => {
    const closing = !isNodeCollapsed(id);
    if (search) setSearchCollapsed((previous) => closing ? [...new Set([...previous, id])] : previous.filter((value) => value !== id));
    setCollapsed((previous) => closing ? [...new Set([...previous, id])] : previous.filter((value) => value !== id));
  };
  const expandNodes = (...ids: string[]) => {
    setCollapsed((previous) => previous.filter((id) => !ids.includes(id)));
    setSearchCollapsed((previous) => previous.filter((id) => !ids.includes(id)));
  };
  const [renameDialog, setRenameDialog] = useState<{ name: string; apply: (name: string) => void } | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deleteDialog, setDeleteDialog] = useState<{ name: string; description?: string; apply: () => void } | null>(null);
  const [responseSearch, setResponseSearch] = useState("");
  const [activeResponseMatch, setActiveResponseMatch] = useState(0);
  const [responseDock, setResponseDock] = useState<"bottom" | "right">(() => localStorage.getItem("kodama.responseDock") === "right" ? "right" : "bottom");
  const [responseSizes, setResponseSizes] = useState(() => {
    try { const sizes = JSON.parse(localStorage.getItem("kodama.responseSizes") ?? "{}"); return { bottom: Math.max(25, Math.min(75, Number(sizes.bottom) || 53)), right: Math.max(25, Math.min(75, Number(sizes.right) || 55)) }; }
    catch { return { bottom: 53, right: 55 }; }
  });
  const workbenchRef = useRef<HTMLDivElement>(null);
  const [curlDialog, setCurlDialog] = useState(false);
  const [curlText, setCurlText] = useState("");
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const stored = Number(localStorage.getItem("kodama.sidebarWidth"));
    return Number.isFinite(stored) && stored > 0
      ? Math.max(210, Math.min(540, stored))
      : 280;
  });
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [requestDropAfter, setRequestDropAfter] = useState(false);
  const [collectionDropTarget, setCollectionDropTarget] = useState<{ id: string; position: "before" | "after" } | null>(null);
  const [folderDropTarget, setFolderDropTarget] = useState<{ id: string; position: "before" | "after" } | null>(null);
  const [draggingTabId, setDraggingTabId] = useState<string | null>(null);
  const [tabDropTarget, setTabDropTarget] = useState<{ id: string; after: boolean } | null>(null);
  const pointerDragRef = useRef<{ payload: PointerDrag; x: number; y: number; active: boolean } | null>(null);
  const suppressNextClickRef = useRef(false);
  const [headerVariable, setHeaderVariable] = useState<{ name: string; value: string } | null>(null);
  const [configOpen, setConfigOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<"appearance" | "imports" | "collection">("appearance");
  const [workspaceDialogOpen, setWorkspaceDialogOpen] = useState(false);
  const [switchingWorkspace, setSwitchingWorkspace] = useState(false);
  const [newWorkspaceName, setNewWorkspaceName] = useState("");
  const [variablesOpen, setVariablesOpen] = useState(false);
  const [configCollectionId, setConfigCollectionId] = useState<string | null>(null);
  const [replaceSourceId, setReplaceSourceId] = useState<string | null>(null);
  const [sourceStatus, setSourceStatus] = useState<Record<string, { busy: boolean; message: string; error: boolean }>>({});
  const [sourceWarnings, setSourceWarnings] = useState<Record<string, { path: string; message: string }[]>>({});
  const [importWarnings, setImportWarnings] = useState<{ path: string; message: string }[]>([]);
  const sourceCollectionsRef = useRef<Collection[]>([]);
  const syncingSourcesRef = useRef(new Set<string>());
  const pollingSourcesRef = useRef(false);
  const activeWorkspaceRef = useRef(workspaceData.activeWorkspaceId);
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const saveRevisionRef = useRef(0);

  useEffect(() => {
    document.documentElement.dataset.kodamaTheme = theme;
    document.documentElement.classList.toggle("dark", themes[theme].mode === "dark");
    localStorage.setItem("kodama.theme", theme);
    return () => {
      delete document.documentElement.dataset.kodamaTheme;
      document.documentElement.classList.remove("dark");
    };
  }, [theme]);
  useEffect(() => { localStorage.setItem("kodama.openApiRequestNames", openApiRequestNames); }, [openApiRequestNames]);
  useEffect(() => { localStorage.setItem("kodama.openApiScheme", openApiScheme); }, [openApiScheme]);
  useEffect(() => { localStorage.setItem("kodama.collapsedByWorkspace", JSON.stringify(collapsedByWorkspace)); }, [collapsedByWorkspace]);
  useEffect(() => { localStorage.setItem("kodama.pinnedByWorkspace", JSON.stringify(pinnedByWorkspace)); }, [pinnedByWorkspace]);
  useEffect(() => { localStorage.setItem("kodama.responseDock", responseDock); }, [responseDock]);
  useEffect(() => { localStorage.setItem("kodama.responseSizes", JSON.stringify(responseSizes)); }, [responseSizes]);

  useEffect(() => {
    invoke<WorkspaceData | null>("load_workspaces").then((data) => {
      const next = data ?? freshWorkspaceData();
      next.workspaces = next.workspaces.map((item) => ({ ...item, store: withDefaultEnvironment(item.store) }));
      activeWorkspaceRef.current = next.activeWorkspaceId;
      setWorkspaceData(next);
      const active = next.workspaces.find((item) => item.id === next.activeWorkspaceId) ?? next.workspaces[0];
      const known = new Set(active.store.collections.flatMap((item) => item.requests.map((request) => request.id)));
      const restoredPins = (pinnedByWorkspace[next.activeWorkspaceId] ?? []).filter((id) => known.has(id));
      const id = restoredPins[0] ?? active.store.collections[0]?.requests[0]?.id ?? null;
      setSelectedId(id);
      setTabs(restoredPins.length ? restoredPins : id ? [id] : []);
      setReady(true);
    }).catch((err) => {
      setLoadError(`Could not load workspace: ${message(err)}`);
      setSaved(false);
      toast.error(`Could not load workspace: ${message(err)}`);
    });
  }, []);
  useEffect(() => {
    if (!ready) return;
    setPinnedByWorkspace((previous) => {
      let changed = false;
      const next = { ...previous };
      for (const workspace of workspaceData.workspaces) {
        const ids = new Set(workspace.store.collections.flatMap((item) => item.requests.map((request) => request.id)));
        const valid = (previous[workspace.id] ?? []).filter((id) => ids.has(id));
        if (valid.length !== (previous[workspace.id] ?? []).length) { next[workspace.id] = valid; changed = true; }
      }
      return changed ? next : previous;
    });
  }, [workspaceData, ready]);
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
  useLayoutEffect(() => {
    const menu = contextMenuRef.current;
    if (!contextMenu || !menu) return;
    const { width, height } = menu.getBoundingClientRect();
    const margin = 8;
    const top = contextMenu.y + height > window.innerHeight - margin
      ? contextMenu.y - height
      : contextMenu.y;
    menu.style.left = `${Math.max(margin, Math.min(contextMenu.x, window.innerWidth - width - margin))}px`;
    menu.style.top = `${Math.max(margin, Math.min(top, window.innerHeight - height - margin))}px`;
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
            const paths = [source.path, ...(source.dependencies ?? []).map((item) => item.path)];
            const stamps = await invoke<(string | null)[]>("source_file_stamps", { paths });
            const changed = stamps[0] !== source.stamp || (source.dependencies ?? []).some((item, index) => (stamps[index + 1] ?? "missing") !== item.stamp);
            if (changed && !stopped) {
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
    const timer = window.setInterval(() => { void checkSources(); }, 10000);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [ready, workspaceData.activeWorkspaceId, openApiRequestNames, openApiScheme]);

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
        requests: item.name.toLowerCase().includes(search.toLowerCase()) ? item.requests : item.requests.filter((value) =>
          `${value.name} ${value.method} ${value.url}`.toLowerCase().includes(search.toLowerCase())
        ),
      })).filter(({ requests }) => !search || requests.length),
    [store.collections, search],
  );
  const visibleNodeIds = useMemo(() => visibleCollections.flatMap(({ item, requests }) => {
    const ids = new Set([item.id]);
    if (!search) item.folders.forEach((folder) => ids.add(folder.id));
    else requests.forEach((request) => {
      let parentId = request.folderId;
      const seen = new Set<string>();
      while (parentId && !seen.has(parentId)) {
        seen.add(parentId);
        ids.add(parentId);
        parentId = item.folders.find((folder) => folder.id === parentId)?.parentId ?? null;
      }
    });
    return [...ids];
  }), [visibleCollections, search]);
  const allFoldersExpanded = visibleNodeIds.every((id) => !isNodeCollapsed(id));
  const toggleAllFolders = () => {
    const ids = new Set(visibleNodeIds);
    if (search) setSearchCollapsed(allFoldersExpanded ? [...ids] : []);
    setCollapsed((previous) => allFoldersExpanded ? [...new Set([...previous, ...ids])] : previous.filter((id) => !ids.has(id)));
  };
  const visibleVariables = variableInspectorEntries(resolvedVariables);
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
  const responseIsJson = useMemo(() => {
    if (!response || response.binary) return false;
    try { JSON.parse(response.body); return true; }
    catch { return false; }
  }, [response]);
  const responseContentType = response?.headers.find(([key]) => key.toLowerCase() === "content-type")?.[1] ?? "Unknown content type";
  const responseIsHtml = !!response && (/text\/html|application\/xhtml\+xml/i.test(responseContentType) || /^\s*(?:<!doctype\s+html|<html\b)/i.test(response.body));
  const responseMatches = responseSearch ? responseBody.toLowerCase().split(responseSearch.toLowerCase()).length - 1 : 0;
  useEffect(() => { setActiveResponseMatch(0); }, [responseSearch, responseBody]);
  useEffect(() => {
    if (!responseSearch || !responseMatches) return;
    workbenchRef.current?.querySelectorAll(".response-body mark")[activeResponseMatch]?.scrollIntoView({ block: "nearest" });
  }, [activeResponseMatch, responseMatches, responseSearch, responseView]);
  const highlightedResponse = () => {
    const tokens: { from: number; to: number; kind: string }[] = [];
    if (responseIsJson) {
      const pattern = /("(?:\\.|[^"\\])*")(?=\s*:)|("(?:\\.|[^"\\])*")|(-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)|(\b(?:true|false|null)\b)/g;
      for (const match of responseBody.matchAll(pattern)) {
        const from = match.index ?? 0;
        const kind = match[1] ? "key" : match[2] ? "string" : match[3] ? "number" : "literal";
        tokens.push({ from, to: from + match[0].length, kind });
      }
    }
    let rangeId = 0;
    const renderRange = (start: number, end: number): React.ReactNode[] => {
      const parts: React.ReactNode[] = [];
      let cursor = start;
      const currentRange = rangeId++;
      tokens.forEach((token, index) => {
        const from = Math.max(cursor, start, token.from);
        const to = Math.min(end, token.to);
        if (from >= to) return;
        if (cursor < from) parts.push(responseBody.slice(cursor, from));
        parts.push(<span key={`json-${currentRange}-${index}`} className={`response-json-${token.kind}`}>{responseBody.slice(from, to)}</span>);
        cursor = to;
      });
      if (cursor < end) parts.push(responseBody.slice(cursor, end));
      return parts;
    };
    if (!responseSearch) return renderRange(0, responseBody.length);
    const parts: React.ReactNode[] = [];
    const lower = responseBody.toLowerCase();
    const needle = responseSearch.toLowerCase();
    let index = 0;
    let matchIndex = 0;
    while (index < responseBody.length) {
      const found = lower.indexOf(needle, index);
      if (found < 0) { parts.push(...renderRange(index, responseBody.length)); break; }
      parts.push(...renderRange(index, found));
      parts.push(<mark key={found} className={matchIndex === activeResponseMatch ? "active" : ""}>{renderRange(found, found + needle.length)}</mark>);
      matchIndex++;
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
  const open = (id: string, keepSidebar = false) => {
    setSelectedId(id);
    setTabs((previous) => previous.includes(id) ? previous : [...previous, id]);
    setResponse(null);
    setError("");
    if (!keepSidebar) setSidebar("requests");
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
  const moveRequestById = (requestId: string, collectionId: string, direction: -1 | 1) => {
    editCollection(collectionId, (next) => {
      const index = next.requests.findIndex((item) => item.id === requestId);
      if (index < 0) return;
      const siblingIndices = next.requests.flatMap((item, position) => item.folderId === next.requests[index].folderId ? [position] : []);
      const siblingIndex = siblingIndices.indexOf(index);
      const other = siblingIndices[siblingIndex + direction];
      if (other === undefined) return;
      [next.requests[index], next.requests[other]] = [next.requests[other], next.requests[index]];
    });
  };
  const moveFolderById = (folderId: string, collectionId: string, direction: -1 | 1) => {
    editCollection(collectionId, (next) => { next.folders = moveSiblingFolder(next.folders, folderId, direction); });
  };
  const moveFolderTo = (folderId: string, collectionId: string, targetId: string, after: boolean) => {
    editCollection(collectionId, (next) => { next.folders = reorderSiblingFolder(next.folders, folderId, targetId, after); });
  };

  const moveRequestTo = (
    source: { requestId: string; collectionId: string },
    targetCollectionId: string,
    targetFolderId: string | null,
    anchorRequestId?: string,
    insertAfter = false,
  ) => {
    setDragOverId(null);
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
  };
  const moveCollectionTo = (sourceId: string, targetCollectionId: string, position: "before" | "after") => {
    setCollectionDropTarget(null);
    if (!sourceId || sourceId === targetCollectionId) return;
    editStore((next) => {
      const sourceIndex = next.collections.findIndex((item) => item.id === sourceId);
      if (sourceIndex < 0 || !next.collections.some((item) => item.id === targetCollectionId)) return;
      const [moving] = next.collections.splice(sourceIndex, 1);
      const insertAt = next.collections.findIndex((item) => item.id === targetCollectionId);
      next.collections.splice(insertAt < 0 ? next.collections.length : insertAt + (position === "after" ? 1 : 0), 0, moving);
    });
  };
  const beginPointerDrag = (event: React.PointerEvent, payload: PointerDrag) => {
    if (event.button !== 0 || event.pointerType === "touch" || (event.target as HTMLElement).closest(".tab-close")) return;
    pointerDragRef.current = { payload, x: event.clientX, y: event.clientY, active: false };
    const origin = { x: event.clientX, y: event.clientY };
    const targetAt = (x: number, y: number) => document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-drop-type]");
    let x = event.clientX;
    let y = event.clientY;
    const updateTarget = () => {
      const drag = pointerDragRef.current;
      if (!drag?.active) return;
      const target = targetAt(x, y);
      const targetType = target?.dataset.dropType;
      if (payload.kind === "request") {
        const id = targetType === "request" ? `request:${target?.dataset.requestId}` : targetType === "folder" ? `folder:${target?.dataset.collectionId}:${target?.dataset.folderId}` : targetType === "collection" ? `root:${target?.dataset.collectionId}` : null;
        setDragOverId(id === `request:${payload.requestId}` ? null : id);
        if (targetType === "request" && target) { const rect = target.getBoundingClientRect(); setRequestDropAfter(y >= rect.top + rect.height / 2); }
      } else if (payload.kind === "collection") {
        const rect = target?.getBoundingClientRect();
        setCollectionDropTarget(targetType === "collection" && target && target.dataset.collectionId !== payload.collectionId && rect ? { id: target.dataset.collectionId ?? "", position: y < rect.top + rect.height / 2 ? "before" : "after" } : null);
      } else if (payload.kind === "folder") {
        const folder = store.collections.find((item) => item.id === payload.collectionId)?.folders.find((item) => item.id === payload.folderId);
        const other = store.collections.find((item) => item.id === payload.collectionId)?.folders.find((item) => item.id === target?.dataset.folderId);
        const rect = target?.getBoundingClientRect();
        setFolderDropTarget(targetType === "folder" && target?.dataset.collectionId === payload.collectionId && folder && other && folder.id !== other.id && folder.parentId === other.parentId && rect
          ? { id: other.id, position: y < rect.top + rect.height / 2 ? "before" : "after" } : null);
      } else {
        const rect = target?.getBoundingClientRect();
        setTabDropTarget(targetType === "tab" && target && target.dataset.requestId !== payload.requestId && pinnedTabs.includes(payload.requestId) === pinnedTabs.includes(target.dataset.requestId ?? "") && rect ? { id: target.dataset.requestId ?? "", after: x > rect.left + rect.width / 2 } : null);
      }
    };
    const scrollTimer = window.setInterval(() => {
      if (!pointerDragRef.current?.active) return;
      const container = payload.kind === "tab" ? document.querySelector<HTMLElement>(".tabs") : document.querySelector<HTMLElement>(".sidebar-body");
      if (!container) return;
      const rect = container.getBoundingClientRect();
      if (payload.kind === "tab") container.scrollLeft += x < rect.left + 38 ? -14 : x > rect.right - 38 ? 14 : 0;
      else container.scrollTop += y < rect.top + 38 ? -14 : y > rect.bottom - 38 ? 14 : 0;
      updateTarget();
    }, 30);
    const move = (next: PointerEvent) => {
      x = next.clientX; y = next.clientY;
      const drag = pointerDragRef.current;
      if (!drag) return;
      if (!drag.active && Math.hypot(x - origin.x, y - origin.y) >= 6) {
        drag.active = true;
        document.body.classList.add("pointer-dragging");
        if (payload.kind === "tab") setDraggingTabId(payload.requestId);
      }
      updateTarget();
    };
    const finish = () => {
      window.clearInterval(scrollTimer);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      const drag = pointerDragRef.current;
      if (drag?.active) {
        suppressNextClickRef.current = true;
        window.setTimeout(() => { suppressNextClickRef.current = false; }, 0);
        const target = targetAt(x, y);
        const rect = target?.getBoundingClientRect();
        if (payload.kind === "request") {
          if (target?.dataset.dropType === "request") moveRequestTo(payload, target.dataset.collectionId ?? "", target.dataset.folderId || null, target.dataset.requestId, !!rect && y >= rect.top + rect.height / 2);
          else if (target?.dataset.dropType === "folder" || target?.dataset.dropType === "collection") moveRequestTo(payload, target.dataset.collectionId ?? "", target.dataset.folderId || null);
        } else if (payload.kind === "collection" && target?.dataset.dropType === "collection") moveCollectionTo(payload.collectionId, target.dataset.collectionId ?? "", !!rect && y >= rect.top + rect.height / 2 ? "after" : "before");
        else if (payload.kind === "folder" && target?.dataset.dropType === "folder" && target.dataset.collectionId === payload.collectionId)
          moveFolderTo(payload.folderId, payload.collectionId, target.dataset.folderId ?? "", !!rect && y >= rect.top + rect.height / 2);
        else if (payload.kind === "tab" && target?.dataset.dropType === "tab" && target.dataset.requestId !== payload.requestId && pinnedTabs.includes(payload.requestId) === pinnedTabs.includes(target.dataset.requestId ?? "")) {
          const from = tabs.indexOf(payload.requestId);
          const to = tabs.indexOf(target.dataset.requestId ?? "");
          if (from >= 0 && to >= 0) setTabs((previous) => { const result = [...previous]; const [moving] = result.splice(from, 1); result.splice(to + (!!rect && x > rect.left + rect.width / 2 ? 1 : 0) - (from < to ? 1 : 0), 0, moving); return result; });
        }
      }
      pointerDragRef.current = null;
      document.body.classList.remove("pointer-dragging");
      setDragOverId(null); setCollectionDropTarget(null); setFolderDropTarget(null); setTabDropTarget(null); setDraggingTabId(null); setRequestDropAfter(false);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish, { once: true });
    window.addEventListener("pointercancel", finish, { once: true });
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
    if (pinnedTabs.includes(requestId)) setPinnedByWorkspace((previous) => ({ ...previous, [workspaceData.activeWorkspaceId]: (previous[workspaceData.activeWorkspaceId] ?? []).filter((id) => id !== requestId) }));
    if (selectedId === requestId) setSelectedId(remaining[Math.max(0, index - 1)] ?? null);
  };

  const togglePinTab = (requestId: string) => {
    const pinned = pinnedTabs.includes(requestId);
    setPinnedByWorkspace((previous) => ({ ...previous, [workspaceData.activeWorkspaceId]: pinned
      ? (previous[workspaceData.activeWorkspaceId] ?? []).filter((id) => id !== requestId)
      : [...(previous[workspaceData.activeWorkspaceId] ?? []), requestId] }));
    setTabs((previous) => {
      const remaining = previous.filter((id) => id !== requestId);
      if (pinned) return [...remaining.filter((id) => pinnedTabs.includes(id)), ...remaining.filter((id) => !pinnedTabs.includes(id)), requestId];
      const lastPinned = remaining.reduce((last, id, index) => pinnedTabs.includes(id) ? index : last, -1);
      remaining.splice(lastPinned + 1, 0, requestId);
      return remaining;
    });
  };

  const closeTabsByRelation = (requestId: string, relation: "others" | "right" | "left") => {
    const index = tabs.indexOf(requestId);
    const remaining = tabs.filter((id, tabIndex) => pinnedTabs.includes(id) || (relation === "others"
      ? id === requestId
      : relation === "right" ? tabIndex <= index : tabIndex >= index));
    setTabs(remaining);
    if (!remaining.includes(selectedId ?? "")) setSelectedId(requestId);
  };

  const resizeSidebar = (delta: number) => setSidebarWidth((width) =>
    Math.max(210, Math.min(Math.min(window.innerWidth * 0.48, 540), width + delta)),
  );
  const resizeResponse = (clientX: number, clientY: number) => {
    const rect = workbenchRef.current?.getBoundingClientRect();
    if (!rect) return;
    const dimension = responseDock === "bottom" ? rect.height : rect.width;
    const origin = responseDock === "bottom" ? rect.top : rect.left;
    const coordinate = responseDock === "bottom" ? clientY : clientX;
    const [minimum, maximum] = responseSizeBounds(responseDock, dimension);
    const percent = (coordinate - origin) / dimension * 100;
    setResponseSizes((previous) => ({ ...previous, [responseDock]: Math.max(minimum, Math.min(maximum, percent)) }));
  };

  const showRequestMenu = (event: React.MouseEvent, requestId: string, collectionId: string) => {
    event.preventDefault();
    setContextMenu({ kind: "request", requestId, collectionId, x: event.clientX, y: event.clientY });
  };

  const showTabMenu = (event: React.MouseEvent, requestId: string) => {
    event.preventDefault();
    setContextMenu({ kind: "tab", requestId, x: event.clientX, y: event.clientY });
  };

  const showCollectionMenu = (event: React.MouseEvent, collectionId: string) => {
    event.preventDefault();
    setContextMenu({ kind: "collection", collectionId, x: event.clientX, y: event.clientY });
  };

  const showFolderMenu = (event: React.MouseEvent, collectionId: string, folderId: string) => {
    event.preventDefault();
    setContextMenu({ kind: "folder", collectionId, folderId, x: event.clientX, y: event.clientY });
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
      toast.error(`Could not import workspace: ${message(err)}`);
    }
  }
  async function importOpenApiFile() {
    try {
      const file = await invoke<SourceFile | null>("import_openapi_file");
      if (!file) return;
      const read = (path: string) => invoke<SourceFile>("read_source_file", { path });
      const parsed = await parseOpenApiSource(file, read);
      const bundled = await bundleOpenApiRefs(file, parsed.document, read);
      const warnings = [...bundled.warnings];
      const imported = importOpenApi(bundled.document, openApiRequestNames, openApiScheme, (warning) => warnings.push(warning));
      setStore((previous) => ({ ...previous, collections: [...previous.collections, ...imported.collections] }));
      const first = imported.collections[0].requests[0];
      if (first) open(first.id);
      toast.success(`Imported ${imported.collections[0].requests.length} requests from OpenAPI`);
      if (warnings.length) setImportWarnings(warnings);
    } catch (err) { toast.error(`Could not import OpenAPI: ${message(err)}`); }
  }
  async function prepareSourceFile(file: SourceFile) {
    const read = (path: string) => invoke<SourceFile>("read_source_file", { path });
    const parsed = await parseOpenApiSource(file, read);
    const bundled = await bundleOpenApiRefs(file, parsed.document, read);
    const warnings = [...bundled.warnings];
    const imported = importOpenApi(bundled.document, openApiRequestNames, openApiScheme, (warning) => warnings.push(warning)).collections[0];
    const used = new Set(imported.requests.flatMap((item) => [item.url, item.body.text, ...item.query.flatMap((row) => [row.key, row.value]), ...item.pathParams.map((row) => row.value), ...item.headers.flatMap((row) => [row.key, row.value])]
      .flatMap((text) => [...text.matchAll(/\{\{\s*([A-Za-z_][\w]*)\s*\}\}/g)].map((match) => match[1]))));
    const placeholders = parsed.placeholders.filter((name) => used.has(name));
    for (const name of placeholders) {
      if (!imported.variables.some((item) => item.name === name)) imported.variables.push({ ...variable(), name });
    }
    const dependencies = [...new Map([...parsed.dependencies, ...bundled.dependencies].map((item) => [item.path, item])).values()];
    return { imported, details: { path: file.path, stamp: file.stamp, dependencies, placeholders }, warnings };
  }
  async function applySourceFile(collectionId: string, file: SourceFile, mode: "merge" | "replace", announce: boolean) {
    const targetWorkspaceId = workspaceData.activeWorkspaceId;
    if (syncingSourcesRef.current.has(collectionId)) return;
    syncingSourcesRef.current.add(collectionId);
    setSourceStatus((previous) => ({ ...previous, [collectionId]: { busy: true, message: "Reading source…", error: false } }));
    try {
      const { imported, details, warnings } = await prepareSourceFile(file);
      if (activeWorkspaceRef.current !== targetWorkspaceId) return;
      const current = sourceCollectionsRef.current.find((item) => item.id === collectionId);
      if (!current) throw new Error("Collection no longer exists");
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
      setSourceWarnings((previous) => ({ ...previous, [collectionId]: warnings }));
      setSourceStatus((previous) => ({ ...previous, [collectionId]: { busy: false, message: warnings.length ? `${result}; ${warnings.length} source warnings` : result, error: warnings.length > 0 } }));
      if (announce) toast.success(result);
    } catch (err) {
      const detail = message(err);
      setSourceStatus((previous) => ({ ...previous, [collectionId]: { busy: false, message: detail, error: true } }));
      if (announce) toast.error(`Could not sync source: ${detail}`);
    } finally { syncingSourcesRef.current.delete(collectionId); }
  }
  async function createCollectionFromSourceFile(file: SourceFile) {
    const targetWorkspaceId = workspaceData.activeWorkspaceId;
    const { imported, details, warnings } = await prepareSourceFile(file);
    if (activeWorkspaceRef.current !== targetWorkspaceId) return;
    const linked = syncCollectionSource(imported, imported, details, "merge").collection;
    setStore((previous) => ({ ...previous, collections: [...previous.collections, linked] }));
    setConfigCollectionId(linked.id);
    setSourceWarnings((previous) => ({ ...previous, [linked.id]: warnings }));
    if (warnings.length) setSourceStatus((previous) => ({ ...previous, [linked.id]: { busy: false, message: `Imported ${linked.requests.length} routes with ${warnings.length} source warnings`, error: true } }));
    if (linked.requests[0]) open(linked.requests[0].id);
    toast.success(`Created ${linked.name} with ${linked.requests.length} source routes`);
  }
  async function createCollectionFromSourceFileDialog() {
    try {
      const file = await invoke<SourceFile | null>("pick_source_file");
      if (!file) return;
      await createCollectionFromSourceFile(file);
    } catch (err) { toast.error(`Could not open source file: ${message(err)}`); }
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
    const known = new Set(next.collections.flatMap((item) => item.requests.map((request) => request.id)));
    const restoredPins = (pinnedByWorkspace[activeWorkspaceRef.current] ?? []).filter((id) => known.has(id));
    const firstId = restoredPins[0] ?? next.collections[0]?.requests[0]?.id ?? null;
    setSelectedId(firstId);
    setTabs(restoredPins.length ? restoredPins : firstId ? [firstId] : []);
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
    setSearchCollapsed([]);
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
    setCollapsedByWorkspace((previous) => { const next = { ...previous }; delete next[id]; return next; });
    setPinnedByWorkspace((previous) => { const next = { ...previous }; delete next[id]; return next; });
    if (wasActive) resetWorkspaceSession(remaining[0].store);
    setWorkspaceDialogOpen(true);
  }

  if (loadError) return <div className="app"><div className="load-failure"><img className="brand-icon brand-logo" src="/icon.svg" alt="" /><h1>Workspace unavailable</h1><p>{loadError}</p><button className="send" onClick={() => window.location.reload()}>Retry loading</button></div></div>;

  const errorTitle = error.split("\n", 1)[0];
  const variableError = /^Variable ([A-Za-z_][\w.]*) (is not defined|has no value)(.*)$/.exec(errorTitle);
  const workbenchRect = workbenchRef.current?.getBoundingClientRect();
  const responseBounds = responseSizeBounds(responseDock, responseDock === "bottom"
    ? workbenchRect?.height ?? window.innerHeight * 0.8
    : workbenchRect?.width ?? window.innerWidth * 0.7);

  return (
    <TooltipProvider><div className="app">
      <Toaster theme={themes[theme].mode} position="bottom-right" richColors />
      <header className="topbar">
        <div className="brand">
          <img className="brand-icon brand-logo" src="/icon.svg" alt="" />
          <strong>Kodama</strong>
          <button className="workspace-switcher" onClick={() => setWorkspaceDialogOpen(true)} title="Switch workspace"><span className="workspace-indicator" />{activeWorkspace.name}<ChevronDown size={13} /></button>
        </div>
        <div className="top-actions">
          <span className="saved">{!ready ? "Workspace unavailable" : saved ? "Saved locally" : "Saving…"}</span>
          <button className={`icon config-button${Object.values(sourceStatus).some((item) => item.error) ? " source-error" : ""}`} aria-label="Settings" title="Settings" onClick={() => { setConfigCollectionId(collection?.id ?? store.collections[0]?.id ?? null); setConfigOpen(true); }}><Settings2 size={17} /></button>
        </div>
      </header>
      <div className="workspace" onClickCapture={(event) => { if (suppressNextClickRef.current) { event.preventDefault(); event.stopPropagation(); suppressNextClickRef.current = false; } }}>
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
                <button className="icon" aria-label={allFoldersExpanded ? "Collapse all folders" : "Expand all folders"} title={allFoldersExpanded ? "Collapse all folders" : "Expand all folders"} disabled={!visibleNodeIds.length} onClick={toggleAllFolders}>{allFoldersExpanded ? <ChevronUp size={15} /> : <ChevronDown size={15} />}</button>
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
              <div className="search-wrap">
                <input
                  className="search"
                  aria-label="Search requests"
                  placeholder="Search requests…"
                  value={search}
                  onChange={(event) => { setSearch(event.target.value); setSearchCollapsed([]); }}
                />
                {search && <button aria-label="Clear request search" title="Clear search" onClick={() => { setSearch(""); setSearchCollapsed([]); }}><X size={14} /></button>}
              </div>
              {visibleCollections.map(({ item, requests }) => {
                const folderHasMatches = (folderId: string): boolean => requests.some((value) => value.folderId === folderId) || item.folders.some((child) => child.parentId === folderId && folderHasMatches(child.id));
                const requestRow = (value: ApiRequest, depth = 0) => (
                  <div className="request-row" key={value.id}>
                    <button
                      data-drop-type="request" data-request-id={value.id} data-collection-id={item.id} data-folder-id={value.folderId ?? ""}
                      className={`request-link${depth ? " nested" : ""}${selectedId === value.id ? " selected" : ""}${dragOverId === `request:${value.id}` ? (requestDropAfter ? " drop-after" : " drop-before") : ""}`}
                      onPointerDown={(event) => beginPointerDrag(event, { kind: "request", requestId: value.id, collectionId: item.id })}
                      onClick={() => open(value.id)}
                      onContextMenu={(event) => showRequestMenu(event, value.id, item.id)}
                    >
                      <span className={`method ${value.method.toLowerCase()}`}>{value.method}</span>
                      <span>{value.name}</span>
                    </button>
                    <button className="request-menu-trigger" aria-label={`Actions for ${value.name}`} title="Request actions" onClick={(event) => showRequestMenu(event, value.id, item.id)}><Ellipsis size={15} /></button>
                  </div>
                );
                const renderFolder = (folder: typeof item.folders[number], depth = 0): React.ReactNode => {
                  if (search && !folderHasMatches(folder.id)) return null;
                  const targetId = `folder:${item.id}:${folder.id}`;
                  const isCollapsed = isNodeCollapsed(folder.id);
                  return <div className={`folder-node${depth ? " child-folder" : ""}${folderDropTarget?.id === folder.id ? ` folder-drop-${folderDropTarget.position}` : ""}`} key={folder.id}>
                    <div
                      data-drop-type="folder" data-collection-id={item.id} data-folder-id={folder.id}
                      className={`folder-heading${dragOverId === targetId ? " drop-target" : ""}`}
                      onContextMenu={(event) => showFolderMenu(event, item.id, folder.id)}
                    >
                      <button
                        aria-label={`${isCollapsed ? "Expand" : "Collapse"} ${folder.name}`}
                        onPointerDown={(event) => beginPointerDrag(event, { kind: "folder", folderId: folder.id, collectionId: item.id })}
                        onClick={() => toggleNode(folder.id)}
                      >
                        {isCollapsed ? <Folder size={14} aria-hidden="true" /> : <FolderOpen size={14} aria-hidden="true" />} {folder.name}
                      </button>
                      <button className="icon" title="New request in folder" onClick={() => { addRequest(item.id, folder.id); expandNodes(item.id, folder.id); }}>＋</button>
                      <button className="icon" title="New subfolder" aria-label={`New subfolder in ${folder.name}`} onClick={() => { editCollection(item.id, (next) => next.folders.push({ id: uid(), name: "New folder", parentId: folder.id })); expandNodes(item.id, folder.id); }}><FolderPlus size={14} /></button>
                      <button className="icon" aria-label={`Actions for folder ${folder.name}`} title="Folder actions" onClick={(event) => showFolderMenu(event, item.id, folder.id)}><Ellipsis size={14} /></button>
                    </div>
                    {!isCollapsed && <>
                      {requests.filter((value) => value.folderId === folder.id).map((value) => requestRow(value, depth + 1))}
                      {item.folders.filter((value) => value.parentId === folder.id).map((child) => renderFolder(child, depth + 1))}
                    </>}
                  </div>;
                };
                const folderIds = new Set(item.folders.map((folder) => folder.id));
                const rootFolders = item.folders.filter((folder) => !folder.parentId || !folderIds.has(folder.parentId));
                const collectionDropPosition = collectionDropTarget?.id === item.id ? collectionDropTarget.position : null;
                return <div className={`collection${collectionDropPosition ? ` collection-drop-${collectionDropPosition}` : ""}`} key={item.id}>
                  <div className="collection-heading">
                    <button
                      data-drop-type="collection" data-collection-id={item.id}
                      className={`collection-name${dragOverId === `root:${item.id}` ? " drop-target" : ""}`}
                      onPointerDown={(event) => beginPointerDrag(event, { kind: "collection", collectionId: item.id })}
                      onClick={() => toggleNode(item.id)}
                      onDoubleClick={() =>
                        rename(item.name, (name) =>
                          editCollection(item.id, (next) => {
                            next.name = name;
                          }))}
                      onContextMenu={(event) => showCollectionMenu(event, item.id)}
                    >
                      {isNodeCollapsed(item.id) ? "▸" : "▾"} {item.name}
                    </button>
                    <button
                      className="icon"
                      title="New request"
                      onClick={() => { addRequest(item.id); expandNodes(item.id); }}
                    >
                      ＋
                    </button>
                    <button
                      className="icon"
                      title="New folder"
                      onClick={() => {
                        editCollection(item.id, (next) => {
                          next.folders.push({
                            id: uid(),
                            name: "New folder",
                            parentId: null,
                          });
                        });
                        expandNodes(item.id);
                      }}
                    >
                      <FolderPlus size={14} />
                    </button>
                  </div>
                  {!isNodeCollapsed(item.id) && (
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
              {visibleVariables.map(([name, item]) => (
                <div className="inspector" key={name}>
                  <code>{name}</code>
                  <Tooltip><TooltipTrigger asChild><span tabIndex={0} className={variableHasValue(name, resolvedVariables) ? "" : "variable-unset"}>{variableHasValue(name, resolvedVariables) ? item.secret ? "••••••" : item.value : "Unset"}</span></TooltipTrigger>
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
                  <div className="history-record" key={item.id}><button className="history-item" onClick={() => {
                    setExpandedHistory((previous) => previous === item.id ? null : item.id);
                    if (!findRequest(store, item.requestId)) { toast.error("This request no longer exists in the workspace"); return; }
                    open(item.requestId, true);
                    if (item.response) setResponse(item.response);
                    else setError(item.error ?? "This response body was not retained in history because it was large or binary.");
                  }} aria-expanded={expandedHistory === item.id}>
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
                  data-drop-type="tab" data-request-id={id}
                  className={`tab${selectedId === id ? " active" : ""}${pinnedTabs.includes(id) ? " pinned" : ""}${draggingTabId === id ? " dragging" : ""}${tabDropTarget?.id === id && draggingTabId !== id ? (tabDropTarget.after ? " drop-after" : " drop-before") : ""}`}
                  title="Drag to reorder tabs"
                  onClick={() => open(id)}
                  onPointerDown={(event) => beginPointerDrag(event, { kind: "tab", requestId: id })}
                  onContextMenu={(event) => showTabMenu(event, id)}
                >
                  <GripVertical className="tab-grip" size={14} aria-hidden="true" />
                  {pinnedTabs.includes(id) && <Pin size={12} className="tab-pin" aria-hidden="true" />}
                  <span className={`method ${item.method.toLowerCase()}`}>
                    {item.method}
                  </span>
                  <span className="tab-name">{item.name}</span>
                  {!saved && selectedId === id && (
                    <span className="unsaved-dot">•</span>
                  )}
                  <span className="tab-close" onClick={(event) => { event.stopPropagation(); closeTab(id); }}>
                    ×
                  </span>
                </button>
              );
            })}
            <div className="tab-fill"></div>
            <SelectPrimitive.Root value={store.activeEnvironmentId ?? "__none__"} onValueChange={(id) => editStore((next) => { next.activeEnvironmentId = id === "__none__" ? null : id; })}>
              <SelectPrimitive.Trigger className="active-env" aria-label="Switch environment">
                <span className={`environment-dot ${environment ? "active" : ""}`} aria-hidden="true" />
                <strong>{environment?.name ?? "No environment"}</strong><ChevronDown size={12} aria-hidden="true" />
              </SelectPrimitive.Trigger>
              <SelectPrimitive.Portal><SelectPrimitive.Content className="environment-menu" position="popper" sideOffset={5} align="end">
                <SelectPrimitive.Viewport>
                  <SelectPrimitive.Item className="environment-menu-item" value="__none__"><SelectPrimitive.ItemText>No environment</SelectPrimitive.ItemText><SelectPrimitive.ItemIndicator><Check size={13} /></SelectPrimitive.ItemIndicator></SelectPrimitive.Item>
                  {store.environments.map((item) => <SelectPrimitive.Item key={item.id} className="environment-menu-item" value={item.id}><SelectPrimitive.ItemText>{item.name}</SelectPrimitive.ItemText><SelectPrimitive.ItemIndicator><Check size={13} /></SelectPrimitive.ItemIndicator></SelectPrimitive.Item>)}
                </SelectPrimitive.Viewport>
              </SelectPrimitive.Content></SelectPrimitive.Portal>
            </SelectPrimitive.Root>
          </div>
          {request && collection
            ? (
              <div ref={workbenchRef} className={`workbench dock-${responseDock}`} style={responseDock === "bottom" ? { gridTemplateRows: `${responseSizes.bottom}% 4px minmax(0, 1fr)` } : { gridTemplateColumns: `${responseSizes.right}% 4px minmax(0, 1fr)` }}>
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
                  </div>
                  <div className="urlbar">
                    <SelectPrimitive.Root value={request.method} onValueChange={(method) => editRequest((next) => { next.method = method; })}>
                      <SelectPrimitive.Trigger aria-label="HTTP method" className={`method-trigger ${request.method.toLowerCase()}`}>
                        <span className="method-dot" aria-hidden="true" />
                        <SelectPrimitive.Value />
                        <SelectPrimitive.Icon className="method-chevron"><ChevronDown size={14} /></SelectPrimitive.Icon>
                      </SelectPrimitive.Trigger>
                      <SelectPrimitive.Portal>
                        <SelectPrimitive.Content className="method-menu" position="popper" sideOffset={6} align="start">
                          <SelectPrimitive.Viewport className="method-menu-viewport">
                            {HTTP_METHODS.map((method) => <SelectPrimitive.Item key={method} value={method} className={`method-menu-item ${method.toLowerCase()}`}>
                              <span className="method-dot" aria-hidden="true" />
                              <SelectPrimitive.ItemText>{method}</SelectPrimitive.ItemText>
                              <SelectPrimitive.ItemIndicator className="method-check"><Check size={14} /></SelectPrimitive.ItemIndicator>
                            </SelectPrimitive.Item>)}
                          </SelectPrimitive.Viewport>
                        </SelectPrimitive.Content>
                      </SelectPrimitive.Portal>
                    </SelectPrimitive.Root>
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
                            large
                            variables={resolvedVariables}
                            theme={themes[theme].mode}
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
                          theme={themes[theme].mode}
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
                <div className="response-resize" role="separator" aria-label="Resize response area" aria-orientation={responseDock === "bottom" ? "horizontal" : "vertical"} aria-valuemin={Math.round(responseBounds[0])} aria-valuemax={Math.round(responseBounds[1])} aria-valuenow={Math.round(responseSizes[responseDock])} tabIndex={0}
                  onPointerDown={(event) => { if (event.button === 0) { event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); } }}
                  onPointerMove={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId) && event.buttons === 1) resizeResponse(event.clientX, event.clientY); }}
                  onKeyDown={(event) => { const delta = event.key === "ArrowUp" || event.key === "ArrowLeft" ? -2 : event.key === "ArrowDown" || event.key === "ArrowRight" ? 2 : 0; if (delta) { event.preventDefault(); setResponseSizes((previous) => ({ ...previous, [responseDock]: Math.max(responseBounds[0], Math.min(responseBounds[1], previous[responseDock] + delta)) })); } }} />
                <section className="response-panel">
                  <div className="response-top">
                    <div>
                      <strong>Response</strong>
                      <button className="icon response-dock-button" aria-label={responseDock === "bottom" ? "Move response right" : "Move response below"} title={responseDock === "bottom" ? "Move response right" : "Move response below"} onClick={() => setResponseDock(responseDock === "bottom" ? "right" : "bottom")}>{responseDock === "bottom" ? <PanelRight size={15} /> : <PanelBottom size={15} />}</button>
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
                    <span>{responseSearch ? `${responseMatches ? activeResponseMatch + 1 : 0} / ${responseMatches}` : ""}</span>
                    <button className="icon" aria-label="Previous match" title="Previous match" disabled={!responseMatches} onClick={() => setActiveResponseMatch((index) => (index + responseMatches - 1) % responseMatches)}><ChevronUp size={15} /></button>
                    <button className="icon" aria-label="Next match" title="Next match" disabled={!responseMatches} onClick={() => setActiveResponseMatch((index) => (index + 1) % responseMatches)}><ChevronDown size={15} /></button>
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
                        <strong className="response-error-title">{variableError ? <>Variable <code className="response-variable-chip">{variableError[1]}</code> {variableError[2]}{variableError[3]}</> : errorTitle}</strong>
                        {error.includes("\n") && <pre>{error.slice(error.indexOf("\n") + 1)}</pre>}
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
                        <img className={busy ? "loading-icon" : ""} src="/icon.svg" alt="" />
                        <strong>{busy ? "Sending request…" : "Ready when you are"}</strong>
                        <p>{busy ? "Waiting for the server response." : "Send a request to inspect the response here."}</p>
                      </div>
                    )}
                </section>
              </div>
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
        ref={contextMenuRef}
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
          const siblingRequests = target.collection.requests.filter((item) => item.folderId === target.request.folderId);
          const siblingIndex = siblingRequests.findIndex((item) => item.id === requestId);
          return <>
            <div className="context-menu-label">{target.request.name}</div>
            <button role="menuitem" onClick={() => { setContextMenu(null); rename(target.request.name, (name) => editCollection(collectionId, (next) => { const found = next.requests.find((item) => item.id === requestId); if (found) found.name = name; })); }}>Rename</button>
            <button role="menuitem" onClick={() => { duplicateRequestById(requestId, collectionId); setContextMenu(null); }}>Duplicate</button>
            <button role="menuitem" onClick={() => { open(requestId); setContextMenu(null); }}>Open in tab</button>
            <button role="menuitem" onClick={() => { const curl = exportCurl(target.request); void navigator.clipboard.writeText(curl).then(() => toast.success("cURL copied")).catch(() => toast.error("Could not copy cURL")); setContextMenu(null); }}>Copy cURL</button>
            <div className="context-menu-separator" />
            <button role="menuitem" disabled={siblingIndex <= 0} onClick={() => { moveRequestById(requestId, collectionId, -1); setContextMenu(null); }}>Move up</button>
            <button role="menuitem" disabled={siblingIndex >= siblingRequests.length - 1} onClick={() => { moveRequestById(requestId, collectionId, 1); setContextMenu(null); }}>Move down</button>
            <div className="context-menu-separator" />
            <button role="menuitem" className="danger" onClick={() => { removeRequestById(requestId, collectionId); setContextMenu(null); }}>Delete</button>
          </>;
        })() : contextMenu.kind === "tab" ? <>
          <div className="context-menu-label">{findRequest(store, contextMenu.requestId)?.request.name ?? "Request tab"}</div>
          <button role="menuitem" onClick={() => { togglePinTab(contextMenu.requestId); setContextMenu(null); }}>{pinnedTabs.includes(contextMenu.requestId) ? "Unpin tab" : "Pin tab"}</button>
          <button role="menuitem" onClick={() => { closeTab(contextMenu.requestId); setContextMenu(null); }}>Close</button>
          <button role="menuitem" onClick={() => { closeTabsByRelation(contextMenu.requestId, "others"); setContextMenu(null); }}>Close others</button>
          <button role="menuitem" onClick={() => { closeTabsByRelation(contextMenu.requestId, "right"); setContextMenu(null); }}>Close other tabs to the right</button>
          <button role="menuitem" onClick={() => { closeTabsByRelation(contextMenu.requestId, "left"); setContextMenu(null); }}>Close other tabs to the left</button>
        </> : contextMenu.kind === "folder" ? (() => {
          const collectionId = contextMenu.collectionId;
          const folders = store.collections.find((item) => item.id === collectionId)?.folders ?? [];
          const folder = folders.find((item) => item.id === contextMenu.folderId);
          if (!folder) return null;
          const siblings = folders.filter((item) => item.parentId === folder.parentId);
          const siblingIndex = siblings.findIndex((item) => item.id === folder.id);
          return <>
            <div className="context-menu-label">Folder · {folder.name}</div>
            <button role="menuitem" onClick={() => { setContextMenu(null); rename(folder.name, (name) => editCollection(collectionId, (next) => { const target = next.folders.find((item) => item.id === folder.id); if (target) target.name = name; })); }}>Rename</button>
            <button role="menuitem" onClick={() => { addRequest(collectionId, folder.id); expandNodes(collectionId, folder.id); setContextMenu(null); }}>New request</button>
            <button role="menuitem" onClick={() => { editCollection(collectionId, (next) => next.folders.push({ id: uid(), name: "New folder", parentId: folder.id })); expandNodes(collectionId, folder.id); setContextMenu(null); }}>New subfolder</button>
            <div className="context-menu-separator" />
            <button role="menuitem" disabled={siblingIndex <= 0} onClick={() => { moveFolderById(folder.id, collectionId, -1); setContextMenu(null); }}>Move up</button>
            <button role="menuitem" disabled={siblingIndex >= siblings.length - 1} onClick={() => { moveFolderById(folder.id, collectionId, 1); setContextMenu(null); }}>Move down</button>
            <div className="context-menu-separator" />
            <button role="menuitem" className="danger" onClick={() => { deleteFolderById(collectionId, folder.id); setContextMenu(null); }}>Delete folder</button>
          </>;
        })() : (() => {
          const target = store.collections.find((item) => item.id === contextMenu.collectionId);
          if (!target) return null;
          return <>
            <div className="context-menu-label">Collection · {target.name}</div>
            <button role="menuitem" onClick={() => { setContextMenu(null); rename(target.name, (name) => editCollection(target.id, (next) => { next.name = name; })); }}>Rename</button>
            <button role="menuitem" onClick={() => { addRequest(target.id); expandNodes(target.id); setContextMenu(null); }}>New request</button>
            <button role="menuitem" onClick={() => { editCollection(target.id, (next) => next.folders.push({ id: uid(), name: "New folder", parentId: null })); expandNodes(target.id); setContextMenu(null); }}>New folder</button>
            <button role="menuitem" onClick={() => { setConfigCollectionId(target.id); setSettingsSection("collection"); setConfigOpen(true); setContextMenu(null); }}>Configure source…</button>
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
          <DialogHeader><DialogTitle>Settings</DialogTitle><DialogDescription>Choose how Kodama looks and manage this workspace and its collections.</DialogDescription></DialogHeader>
          <div className="settings-layout">
            <nav className="settings-nav" aria-label="Settings sections">
              <button className={settingsSection === "appearance" ? "active" : ""} onClick={() => setSettingsSection("appearance")}>Appearance</button>
              <button className={settingsSection === "imports" ? "active" : ""} onClick={() => setSettingsSection("imports")}>Import &amp; export</button>
              <button className={settingsSection === "collection" ? "active" : ""} onClick={() => setSettingsSection("collection")}>Collection sync</button>
            </nav>
            <div className="settings-pane">
          {settingsSection === "appearance" && <>
          <div className="settings-pane-heading"><strong>Appearance</strong><span>Choose the look of your workspace.</span></div>
          {themeGroups.map((group) => <div className="source-config-section" key={group.label}>
            <div className="source-config-heading"><strong>{group.label}</strong></div>
            <div className="theme-variant-grid" role="group" aria-label={`${group.label} variants`}>
              {group.options.map((id) => <button key={id} className={`theme-variant${theme === id ? " active" : ""}`} aria-pressed={theme === id} onClick={() => setTheme(id)}>
                <span className="theme-variant-preview" aria-hidden="true" style={{ "--theme-surface": themes[id].surface, "--theme-accent": themes[id].accent } as React.CSSProperties} />
                {themes[id].label}
                {theme === id && <Check size={14} aria-hidden="true" />}
              </button>)}
            </div>
          </div>)}
          </>}
          {settingsSection === "imports" && <>
          <div className="settings-pane-heading"><strong>Import &amp; export</strong><span>Choose how incoming routes are named and save or load workspace data.</span></div>
          <div className="source-config-section">
            <div className="source-config-heading"><strong>Workspace data</strong><span>{activeWorkspace.name}</span></div>
            <div className="settings-import-option">
              <span>Imported request names</span>
              <div className="settings-theme-options" role="group" aria-label="Imported request names">
                <button className={openApiRequestNames === "summary" ? "active" : ""} aria-pressed={openApiRequestNames === "summary"} onClick={() => setOpenApiRequestNames("summary")}>Summary</button>
                <button className={openApiRequestNames === "path" ? "active" : ""} aria-pressed={openApiRequestNames === "path"} onClick={() => setOpenApiRequestNames("path")}>Route path</button>
              </div>
              <small>Used for new OpenAPI imports and linked source syncs.</small>
            </div>
            <div className="settings-import-option">
              <span>Imported URL protocol</span>
              <div className="settings-theme-options" role="group" aria-label="Imported URL protocol">
                {(["document", "http", "https"] as const).map((scheme) => <button key={scheme} className={openApiScheme === scheme ? "active" : ""} aria-pressed={openApiScheme === scheme} onClick={() => setOpenApiScheme(scheme)}>{scheme === "document" ? "From file" : scheme.toUpperCase()}</button>)}
              </div>
              <small>Changes imported URLs only. Locally edited routes remain unchanged during sync.</small>
            </div>
            <p className="settings-section-description">Import requests into this workspace or export it as a Kodama file.</p>
            <div className="source-actions">
              <button className="subtle" onClick={() => { setConfigOpen(false); void importFile(); }}>Import workspace</button>
              <button className="subtle" onClick={() => { setConfigOpen(false); void importOpenApiFile(); }}>Import OpenAPI (new collection)</button>
              <button className="subtle" onClick={() => { setConfigOpen(false); setCurlDialog(true); }}>Import cURL</button>
              <button className="subtle" onClick={() => { setConfigOpen(false); void exportFile(); }}>Export workspace</button>
            </div>
          </div>
          </>}
          {settingsSection === "collection" && <>
          <div className="settings-collection-heading"><strong>Collection settings</strong><span>Link an OpenAPI JSON, YAML, JavaScript, or TypeScript file to keep routes synced.</span></div>
          {store.collections.length ? <>
            <label className="dialog-label" htmlFor="source-collection">Collection</label>
            <select id="source-collection" value={configCollectionId ?? ""} onChange={(event) => setConfigCollectionId(event.target.value)}>
              {store.collections.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
            <div className="source-actions source-collection-actions">
              <button className="subtle" onClick={() => void createCollectionFromSourceFileDialog()}>Create collection from file</button>
              <small>Creates a new linked collection using the OpenAPI title.</small>
            </div>
            {configCollection && <>
              <div className="source-config-section">
                <div className="source-config-heading"><strong>OpenAPI source</strong><span>{configCollection.source ? "Checking for changes every 10 seconds" : "No file linked"}</span></div>
                <code className="source-path">{configCollection.source?.path ?? "Choose a file to add and sync routes in this collection."}</code>
                {configCollection.source?.lastSyncedAt && <small>Last synced {new Date(configCollection.source.lastSyncedAt).toLocaleString()}</small>}
                {sourceStatus[configCollection.id] && <p className={`source-status${sourceStatus[configCollection.id].error ? " error" : ""}`}>{sourceStatus[configCollection.id].message}</p>}
                {!!sourceWarnings[configCollection.id]?.length && <details className="source-warning-list"><summary>{sourceWarnings[configCollection.id].length} source warnings</summary><ul>{sourceWarnings[configCollection.id].map((warning, index) => <li key={index}><strong>{warning.path}</strong><span>{warning.message}</span></li>)}</ul></details>}
                <div className="source-actions">
                  <button className="subtle" disabled={sourceStatus[configCollection.id]?.busy} onClick={() => void chooseSourceFile(configCollection.id)}>{configCollection.source ? "Change file" : "Link file to this collection"}</button>
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
          </> : <div className="source-config-section">
            <p className="settings-section-description">Choose an OpenAPI JSON, YAML, JavaScript, or TypeScript file to create a collection using its document title. Kodama will keep its routes synced to the file.</p>
            <div className="source-actions"><button className="subtle" onClick={() => void createCollectionFromSourceFileDialog()}>Create collection from file</button></div>
          </div>}
          </>}
            </div>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={importWarnings.length > 0} onOpenChange={(open) => { if (!open) setImportWarnings([]); }}>
        <DialogContent className="import-warning-dialog">
          <DialogHeader><DialogTitle>Imported with {importWarnings.length} warnings</DialogTitle><DialogDescription>Valid routes were imported. These source items could not be read and were skipped.</DialogDescription></DialogHeader>
          <ul className="source-warning-list import-warning-items">{importWarnings.map((warning, index) => <li key={index}><strong>{warning.path}</strong><span>{warning.message}</span></li>)}</ul>
          <DialogFooter><button className="subtle" onClick={() => setImportWarnings([])}>Done</button></DialogFooter>
        </DialogContent>
      </Dialog>
      <AlertDialog open={!!replaceSourceId} onOpenChange={(open) => { if (!open) setReplaceSourceId(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader><AlertDialogTitle>Replace this collection?</AlertDialogTitle><AlertDialogDescription>All current requests, scripts, folders, and collection variables in {store.collections.find((item) => item.id === replaceSourceId)?.name ?? "this collection"} will be replaced from its source file. Other collections and environments stay intact.</AlertDialogDescription></AlertDialogHeader>
          <AlertDialogFooter><AlertDialogCancel onClick={() => setConfigOpen(true)}>Cancel</AlertDialogCancel><AlertDialogAction className="alert-dialog-destructive-action" onClick={() => { const id = replaceSourceId; setReplaceSourceId(null); setConfigOpen(true); if (id) void syncSourceNow(id, "replace"); }}>Replace collection</AlertDialogAction></AlertDialogFooter>
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
          <AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel><AlertDialogAction className="alert-dialog-destructive-action" onClick={() => { deleteDialog?.apply(); setDeleteDialog(null); }}>Delete</AlertDialogAction></AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div></TooltipProvider>
  );
}

export default App;
