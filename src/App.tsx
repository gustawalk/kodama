import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import type React from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast, Toaster } from "sonner";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { VariableField, type ResolvedVariable } from "./VariableField";
import { exportCurl, importCurl } from "./curl";
import type {
  ApiRequest,
  Collection,
  Entry,
  RunResult,
  Store,
  Variable,
} from "./types";
import {
  demoStore,
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
const copy = <T,>(value: T): T => structuredClone(value);
const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
const findRequest = (store: Store, id: string | null) =>
  store.collections.flatMap((collection) =>
    collection.requests.map((request) => ({ collection, request }))
  ).find((item) => item.request.id === id);
const collectionIds = (
  item: Collection,
) => [
  item.id,
  ...item.variables.map((value) => value.id),
  ...item.folders.map((value) => value.id),
  ...item.requests.flatMap((value) => [
    value.id,
    ...value.query.map((row) => row.id),
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
        <div className="entry-row" key={row.id}>
          <input
            aria-label="Enabled"
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
          <button className="icon" aria-label={shown.includes(row.id) ? "Hide variable value" : "Show variable value"} title={shown.includes(row.id) ? "Hide value" : "Show value"} onClick={() => setShown((previous) => previous.includes(row.id) ? previous.filter((id) => id !== row.id) : [...previous, row.id])}>◉</button>
          <label>
            <input
              type="checkbox"
              checked={row.secret}
              onChange={(event) => edit(row.id, "secret", event.target.checked)}
            />{" "}
            Secret
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
  const [store, setStore] = useState<Store>(demoStore);
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
    { id: string; name: string; method: string; status: number; time: number }[]
  >([]);
  const [incoming, setIncoming] = useState<Store | null>(null);
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [collapsed, setCollapsed] = useState<string[]>([]);
  const [renameDialog, setRenameDialog] = useState<{ name: string; apply: (name: string) => void } | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deleteDialog, setDeleteDialog] = useState<{ name: string; apply: () => void } | null>(null);
  const [responseSearch, setResponseSearch] = useState("");
  const [curlDialog, setCurlDialog] = useState(false);
  const [curlText, setCurlText] = useState("");

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    return () => document.documentElement.classList.remove("dark");
  }, [theme]);

  useEffect(() => {
    invoke<Store>("load_store").then((data) => {
      const next = data.collections.length ? data : demoStore();
      setStore(next);
      const id = next.collections[0]?.requests[0]?.id ?? null;
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
    if (!ready) return;
    setSaved(false);
    const timer = window.setTimeout(() => {
      invoke("save_store", { store }).then(() => setSaved(true)).catch((err) => {
        toast.error(`Could not save workspace: ${message(err)}`, { id: "save-error" });
      });
    }, 400);
    return () => window.clearTimeout(timer);
  }, [store, ready]);

  const current = findRequest(store, selectedId);
  const request = current?.request;
  const collection = current?.collection;
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
    return values;
  }, [store.defaults, collection, environment, runtime]);
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
      return response.body;
    }
  }, [response]);
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
  const duplicateRequest = () => {
    if (!request || !collection) return;
    const item = copy(request);
    item.id = uid();
    item.name += " copy";
    [...item.query, ...item.headers, ...item.body.fields].forEach((row) => {
      row.id = uid();
    });
    editCollection(collection.id, (next) => {
      next.requests.push(item);
    });
    open(item.id);
  };

  async function send() {
    if (!request || !collection || busy) return;
    setBusy(true);
    setError("");
    setResponse(null);
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
          name: request.name,
          method: request.method,
          status: result.status,
          time: result.elapsedMs,
        }, ...previous].slice(0, 40)
      );
    } catch (err) {
      setError(message(err));
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
        void invoke("save_store", { store }).then(() => setSaved(true)).catch(
          (err) => setError(message(err)),
        );
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
  async function exportFile() {
    try {
      await invoke("export_store", { store });
    } catch (err) {
      setError(message(err));
    }
  }
  function applyImport(mode: "merge" | "replace") {
    if (!incoming) return;
    if (mode === "replace") {
      setStore(incoming);
      setSelectedId(incoming.collections[0]?.requests[0]?.id ?? null);
      setTabs([]);
    } else setStore(mergeWorkspace(store, incoming).next);
    setRuntime({});
    setResponse(null);
    setIncoming(null);
  }

  if (loadError) return <div className={`app kodama-${theme}`}><div className="load-failure"><span className="brand-icon">◈</span><h1>Workspace unavailable</h1><p>{loadError}</p><button className="send" onClick={() => window.location.reload()}>Retry loading</button></div></div>;

  return (
    <TooltipProvider><div className={`app kodama-${theme}`}>
      <Toaster theme={theme} position="bottom-right" richColors />
      <header className="topbar">
        <div className="brand">
          <span className="brand-icon">◈</span>
          <strong>Kodama</strong>
          <small>REST workspace</small>
        </div>
        <div className="top-actions">
          <span className="saved">{!ready ? "Workspace unavailable" : saved ? "Saved locally" : "Saving…"}</span>
          <button className="subtle" onClick={importFile}>Import</button>
          <button className="subtle" onClick={exportFile}>Export</button>
          <button className="subtle" onClick={() => setCurlDialog(true)}>Import cURL</button>
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
        <aside className="sidebar">
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
              {visibleCollections.map(({ item, requests }) => (
                <div className="collection" key={item.id}>
                  <div className="collection-heading">
                    <button
                      className="collection-name"
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
                      {requests.filter((value) => !value.folderId).map(
                        (value) => (
                          <button
                            key={value.id}
                            className={`request-link ${
                              selectedId === value.id ? "selected" : ""
                            }`}
                            onClick={() => open(value.id)}
                          >
                            <span
                              className={`method ${value.method.toLowerCase()}`}
                            >
                              {value.method}
                            </span>
                            <span>{value.name}</span>
                          </button>
                        ),
                      )}
                      {item.folders.map((folder) => (
                        <div key={folder.id}>
                          <div className="folder-heading">
                            <button
                              onDoubleClick={() =>
                                rename(folder.name, (name) =>
                                  editCollection(item.id, (next) => {
                                    const found = next.folders.find((value) =>
                                      value.id === folder.id
                                    );
                                    if (found) found.name = name;
                                  }))}
                            >
                              ▾ {folder.name}
                            </button>
                            <button
                              className="icon"
                              title="New request in folder"
                              onClick={() =>
                                addRequest(item.id, folder.id)}
                            >
                              ＋
                            </button>
                            <button
                              className="icon"
                              title="Delete folder"
                              onClick={() => {
                                setDeleteDialog({ name: `${folder.name} and its requests`, apply: () => {
                                  editCollection(item.id, (next) => {
                                    next.folders = next.folders.filter(
                                      (value) => value.id !== folder.id,
                                    );
                                    next.requests = next.requests.filter(
                                      (value) =>
                                        value.folderId !== folder.id,
                                    );
                                  });
                                } });
                              }}
                            >
                              ×
                            </button>
                          </div>
                          {requests.filter((value) =>
                            value.folderId === folder.id
                          ).map((value) => (
                            <button
                              key={value.id}
                              className={`request-link nested ${
                                selectedId === value.id ? "selected" : ""
                              }`}
                              onClick={() => open(value.id)}
                            >
                              <span
                                className={`method ${value.method.toLowerCase()}`}
                              >
                                {value.method}
                              </span>
                              <span>{value.name}</span>
                            </button>
                          ))}
                        </div>
                      ))}
                    </>
                  )}
                  <div className="collection-actions">
                    <button
                      onClick={() =>
                        rename(item.name, (name) =>
                          editCollection(item.id, (next) => {
                            next.name = name;
                          }))}
                    >
                      Rename
                    </button>
                    <button
                      onClick={() => {
                        setDeleteDialog({ name: item.name, apply: () => {
                          editStore((next) => {
                            next.collections = next.collections.filter(
                              (value) => value.id !== item.id,
                            );
                          });
                        } });
                      }}
                    >
                      Delete
                    </button>
                  </div>
                </div>
              ))}
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
                            next.activeEnvironmentId = null;
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
              {Object.keys(runtime).length
                ? Object.entries(runtime).map(([name, value]) => (
                  <div className="inspector" key={name}>
                    <code>_.{name}</code>
                    <Tooltip><TooltipTrigger asChild><span tabIndex={0}>{/token|key|secret|password/i.test(name) ? "••••••" : value}</span></TooltipTrigger><TooltipContent>{value || "Empty value"}</TooltipContent></Tooltip>
                    <button
                      className="icon"
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
                  <div className="history-item" key={item.id}>
                    <span className={`method ${item.method.toLowerCase()}`}>
                      {item.method}
                    </span>
                    <strong>{item.name}</strong>
                    <span className={item.status < 400 ? "success" : "failure"}>
                      {item.status}
                    </span>
                    <small>{item.time} ms</small>
                  </div>
                ))
                : (
                  <p className="hint">
                    Requests sent this session appear here.
                  </p>
                )}
            </div>
          )}
          <div className="sidebar-footer">
            <span className="online-dot"></span> Local workspace{" "}
            <span>v0.1</span>
          </div>
        </aside>
        <main className="main">
          <div className="tabs">
            {tabs.map((id) => {
              const item = findRequest(store, id)?.request;
              return item && (
                <button
                  key={id}
                  className={`tab ${selectedId === id ? "active" : ""}`}
                  onClick={() => open(id)}
                >
                  <span className={`method ${item.method.toLowerCase()}`}>
                    {item.method}
                  </span>
                  {item.name}
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
              Environment <strong>{environment?.name ?? "None"}</strong>
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
                      <Entries
                        name="Parameter"
                        variables={resolvedVariables}
                        rows={request.query}
                        onChange={(rows) =>
                          editRequest((next) => {
                            next.query = rows;
                          })}
                      />
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
                            ? ", and response.status, response.text(), response.json()"
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
                            </div>
                          ))}
                        </div>
                      )
                    : (
                      <div className="response-empty">
                        <span>◇</span>
                        <strong>Ready when you are</strong>
                        <p>Send a request to inspect the response here.</p>
                      </div>
                    )}
                </section>
              </>
            )
            : (
              <div className="welcome">
                <span>◈</span>
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
      <Dialog open={!!incoming} onOpenChange={(open) => { if (!open) setIncoming(null); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>Bring in this workspace?</DialogTitle><DialogDescription>
            {incoming?.collections.length ?? 0} collections and {incoming?.environments.length ?? 0} environments. Imported scripts stay disabled until you review and trust each request.
          </DialogDescription></DialogHeader>
          <p className="hint">Merge will skip {incoming ? mergeWorkspace(store, incoming).skipped : 0} items with colliding UUIDs. Replace removes the current workspace.</p>
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
      <AlertDialog open={!!deleteDialog} onOpenChange={(open) => { if (!open) setDeleteDialog(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader><AlertDialogTitle>Delete {deleteDialog?.name}?</AlertDialogTitle><AlertDialogDescription>This removes it from your workspace.</AlertDialogDescription></AlertDialogHeader>
          <AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel><AlertDialogAction onClick={() => { deleteDialog?.apply(); setDeleteDialog(null); }}>Delete</AlertDialogAction></AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div></TooltipProvider>
  );
}

export default App;
