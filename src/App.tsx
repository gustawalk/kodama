import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
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
  { rows, onChange, name }: {
    rows: Entry[];
    onChange: (rows: Entry[]) => void;
    name: string;
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
          <input
            aria-label={name}
            value={row.key}
            placeholder={name}
            onChange={(event) => edit(row.id, "key", event.target.value)}
          />
          <input
            aria-label="Value"
            value={row.value}
            placeholder="Value or {{NAME}}"
            onChange={(event) => edit(row.id, "value", event.target.value)}
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
            type={row.secret ? "password" : "text"}
            value={row.value}
            placeholder="Value"
            onChange={(event) => edit(row.id, "value", event.target.value)}
          />
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
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tabs, setTabs] = useState<string[]>([]);
  const [panel, setPanel] = useState<Panel>("params");
  const [sidebar, setSidebar] = useState<Sidebar>("requests");
  const [search, setSearch] = useState("");
  const [runtime, setRuntime] = useState<Record<string, string>>({});
  const [response, setResponse] = useState<RunResult | null>(null);
  const [responseView, setResponseView] = useState<"body" | "headers">("body");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<
    { id: string; name: string; method: string; status: number; time: number }[]
  >([]);
  const [incoming, setIncoming] = useState<Store | null>(null);
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [collapsed, setCollapsed] = useState<string[]>([]);

  useEffect(() => {
    invoke<Store>("load_store").then((data) => {
      const next = data.collections.length ? data : demoStore();
      setStore(next);
      const id = next.collections[0]?.requests[0]?.id ?? null;
      setSelectedId(id);
      setTabs(id ? [id] : []);
      setReady(true);
    }).catch((err) => {
      setError(`Could not load workspace: ${message(err)}`);
      const id = store.collections[0]?.requests[0]?.id ?? null;
      setSelectedId(id);
      setTabs(id ? [id] : []);
      setReady(true);
    });
  }, []);
  useEffect(() => {
    if (!ready) return;
    setSaved(false);
    const timer = window.setTimeout(() => {
      invoke("save_store", { store }).then(() => setSaved(true)).catch((err) =>
        setError(`Could not save workspace: ${message(err)}`)
      );
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
      values[name] = {
        value,
        source: "Runtime",
        secret: /token|key|secret|password/i.test(name),
      };
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
    const value = window.prompt("Name", original)?.trim();
    if (value) apply(value);
  };
  const addRequest = (collectionId: string, folderId: string | null = null) => {
    const item = newRequest("New request", folderId);
    editCollection(collectionId, (next) => {
      next.requests.push(item);
    });
    open(item.id);
  };
  const removeRequest = () => {
    if (!request || !collection || !window.confirm(`Delete ${request.name}?`)) {
      return;
    }
    editCollection(collection.id, (next) => {
      next.requests = next.requests.filter((item) => item.id !== request.id);
    });
    setTabs((previous) => previous.filter((id) => id !== request.id));
    setSelectedId(null);
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

  return (
    <div className={`app ${theme}`}>
      <header className="topbar">
        <div className="brand">
          <span className="brand-icon">◈</span>
          <strong>Kodama</strong>
          <small>REST workspace</small>
        </div>
        <div className="top-actions">
          <span className="saved">{saved ? "Saved locally" : "Saving…"}</span>
          <button className="subtle" onClick={importFile}>Import</button>
          <button className="subtle" onClick={exportFile}>Export</button>
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
                                if (
                                  window.confirm(
                                    `Delete ${folder.name} and its requests?`,
                                  )
                                ) {
                                  editCollection(item.id, (next) => {
                                    next.folders = next.folders.filter(
                                      (value) => value.id !== folder.id,
                                    );
                                    next.requests = next.requests.filter(
                                      (value) =>
                                        value.folderId !== folder.id,
                                    );
                                  });
                                }
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
                        if (window.confirm(`Delete ${item.name}?`)) {
                          editStore((next) => {
                            next.collections = next.collections.filter(
                              (value) => value.id !== item.id,
                            );
                          });
                        }
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
                    <span>
                      {/token|key|secret|password/i.test(name)
                        ? "••••••"
                        : value}
                    </span>
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
                  <span title={item.source}>
                    {item.secret ? "••••••" : item.value}
                  </span>
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
                    <input
                      aria-label="Request URL"
                      placeholder="https://api.example.com/resource"
                      value={request.url}
                      onChange={(event) =>
                        editRequest((next) => {
                          next.url = event.target.value;
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
                          <input
                            placeholder="Token or {{_.TOKEN}}"
                            value={request.auth.token}
                            onChange={(event) =>
                              editRequest((next) => {
                                next.auth.token = event.target.value;
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
                        </div>
                        {["json", "text"].includes(request.body.kind) && (
                          <textarea
                            className="code"
                            spellCheck={false}
                            placeholder={request.body.kind === "json"
                              ? '{"key":"value"}'
                              : "Request body"}
                            value={request.body.text}
                            onChange={(event) =>
                              editRequest((next) => {
                                next.body.text = event.target.value;
                              })}
                          />
                        )}
                        {["form", "multipart"].includes(request.body.kind) && (
                          <Entries
                            name="Field"
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
                        <textarea
                          className="code"
                          aria-label={`${panel} script`}
                          spellCheck={false}
                          placeholder={panel === "post"
                            ? "_.TOKEN = response.json().token;"
                            : "// Set variables or change request"}
                          value={panel === "pre"
                            ? request.preScript
                            : request.postScript}
                          onChange={(event) =>
                            editRequest((next) => {
                              if (panel === "pre") {
                                next.preScript = event.target.value;
                              } else next.postScript = event.target.value;
                            })}
                        />
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
                    </nav>
                  </div>
                  {error
                    ? (
                      <div className="response-error">
                        <strong>Could not complete request</strong>
                        <p>{error}</p>
                      </div>
                    )
                    : response
                    ? responseView === "body"
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
                        : <pre className="response-body">{responseBody}</pre>
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
      {incoming && (
        <div
          className="modal-overlay"
          role="dialog"
          aria-modal="true"
          aria-label="Import workspace"
        >
          <div className="modal">
            <div className="eyebrow">IMPORT KODAMA JSON</div>
            <h2>Bring in this workspace?</h2>
            <p>
              {incoming.collections.length} collections and{" "}
              {incoming.environments.length}{" "}
              environments. Imported scripts stay disabled until you review and
              trust each request.
            </p>
            <p className="hint">
              Merge will skip {mergeWorkspace(store, incoming).skipped}{" "}
              items with colliding UUIDs. Replace removes the current workspace.
            </p>
            <div className="modal-actions">
              <button className="subtle" onClick={() => setIncoming(null)}>
                Cancel
              </button>
              <button className="subtle" onClick={() => applyImport("merge")}>
                Merge
              </button>
              <button className="send" onClick={() => applyImport("replace")}>
                Replace
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
