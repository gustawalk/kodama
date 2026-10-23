import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { toast } from "sonner";
import type {
  ApiRequest,
  Collection,
  Entry,
  SocketMessageExample,
  SocketSettings,
  Variable,
} from "./types";
import { entry, uid } from "./types";
import { VariableField, type ResolvedVariable } from "./VariableField";
import { StyledSelect } from "./StyledSelect";
import { SocketAutoSenders } from "./SocketAutoSenders";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./components/ui/dialog";
import "./SocketWorkbench.css";

const CodeEditor = lazy(() =>
  import("./CodeEditor").then((module) => ({ default: module.CodeEditor })),
);

type EventSource = { autoSenderId?: string; autoSenderName?: string };
type LiveEvent = EventSource & {
  id: string;
  at: string;
  kind: string;
  event: string;
  payload: string;
};
type WireEvent = EventSource & { sessionId: string; kind: string; event: string; payload: string };
const MAX_LOG_PAYLOAD = 16_384;
const MAX_LOG_EVENTS = 500;
type Props = {
  request: ApiRequest;
  collection: Collection;
  defaults: Variable[];
  environmentVariables: Variable[];
  runtimeVariables: Record<string, string>;
  variables: Record<string, ResolvedVariable>;
  theme: "dark" | "light";
  active: boolean;
  onChange: (change: (request: ApiRequest) => void) => void;
};
const failure = (error: unknown) => (error instanceof Error ? error.message : String(error));
const truncateLogPayload = (text: string) =>
  text.length > MAX_LOG_PAYLOAD
    ? `${text.slice(0, MAX_LOG_PAYLOAD)}\n… (event log truncated from ${text.length} characters)`
    : text;
const pretty = (text: string) => {
  if (text.length > MAX_LOG_PAYLOAD) return truncateLogPayload(text);
  try {
    return truncateLogPayload(JSON.stringify(JSON.parse(text), null, 2));
  } catch {
    return text;
  }
};

export function SocketWorkbench({
  request,
  collection,
  defaults,
  environmentVariables,
  runtimeVariables,
  variables,
  theme,
  active,
  onChange,
}: Props) {
  const [status, setStatus] = useState<"disconnected" | "connecting" | "connected">("disconnected");
  const [events, setEvents] = useState<LiveEvent[]>([]);
  const [paused, setPaused] = useState(false);
  const [buffered, setBuffered] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [listening, setListening] = useState(false);
  const [selectedExampleId, setSelectedExampleId] = useState("");
  const [exampleName, setExampleName] = useState("");
  const [saveExampleOpen, setSaveExampleOpen] = useState(false);
  const [suspended, setSuspended] = useState<Set<string>>(new Set());
  const syncQueue = useRef(Promise.resolve());
  const session = useRef<string | null>(null);
  const pausedRef = useRef(false);
  const buffer = useRef<LiveEvent[]>([]);
  const pending = useRef<LiveEvent[]>([]);
  const pendingFrame = useRef<number | null>(null);
  const manualScrollEvent = useRef<string | null>(null);
  const logViewport = useRef<HTMLDivElement>(null);
  const socket = request.socket ?? {
    path: "/socket.io/",
    namespace: "/",
    auth: "",
    event: "message",
    payload: "",
    format: "json",
  };
  const isIo = request.kind === "socketio";
  const examples = socket.examples ?? [];
  const input = () => ({
    request,
    defaults,
    collectionVariables: collection.variables,
    environmentVariables,
    runtimeVariables,
  });
  const flushPending = () => {
    pendingFrame.current = null;
    const batch = pending.current;
    pending.current = [];
    for (const item of batch) {
      if (item.kind === "sent" && !item.autoSenderId) manualScrollEvent.current = item.id;
    }
    if (batch.length) setEvents((previous) => [...previous, ...batch].slice(-MAX_LOG_EVENTS));
  };
  const addEvent = (kind: string, event: string, payload: string, source: EventSource = {}) => {
    const item = {
      id: uid(),
      at: new Date().toLocaleTimeString(),
      kind,
      event,
      payload: pretty(payload),
      ...source,
    };
    if (pausedRef.current) {
      buffer.current.push(item);
      if (buffer.current.length > MAX_LOG_EVENTS) buffer.current.shift();
      setBuffered(buffer.current.length);
    } else {
      pending.current.push(item);
      if (pending.current.length > MAX_LOG_EVENTS) pending.current.shift();
      if (pendingFrame.current === null) pendingFrame.current = requestAnimationFrame(flushPending);
    }
  };

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<WireEvent>("socket-event", ({ payload }) => {
      if (payload.sessionId !== session.current) return;
      if (payload.kind === "status") {
        setStatus(payload.event === "connected" ? "connected" : "disconnected");
        setSuspended(new Set());
      }
      if (payload.kind === "error" && payload.autoSenderId) {
        setSuspended((previous) => new Set(previous).add(payload.autoSenderId!));
      }
      addEvent(payload.kind, payload.event, payload.payload, {
        autoSenderId: payload.autoSenderId,
        autoSenderName: payload.autoSenderName,
      });
    })
      .then((fn) => {
        if (disposed) fn();
        else {
          unlisten = fn;
          setListening(true);
        }
      })
      .catch((error) => {
        if (!disposed) addEvent("error", "listener", failure(error));
      });
    return () => {
      disposed = true;
      unlisten?.();
      if (pendingFrame.current !== null) cancelAnimationFrame(pendingFrame.current);
      pending.current = [];
      if (session.current) void invoke("disconnect_socket", { sessionId: session.current });
    };
  }, []);
  useEffect(() => {
    const id = manualScrollEvent.current;
    if (!id || !events.some((item) => item.id === id)) return;
    manualScrollEvent.current = null;
    const log = logViewport.current;
    if (!paused && active && log) log.scrollTop = log.scrollHeight;
  }, [events, paused, active]);

  const autoSenderInput = useMemo(
    () => JSON.stringify(input()),
    [request, defaults, collection.variables, environmentVariables, runtimeVariables],
  );
  useEffect(() => {
    if (status !== "connected" || !session.current) return;
    const id = session.current;
    const snapshot = JSON.parse(autoSenderInput);
    syncQueue.current = syncQueue.current.then(async () => {
      if (session.current !== id) return;
      try {
        await invoke("sync_socket_auto_senders", { sessionId: id, input: snapshot });
      } catch (error) {
        if (session.current === id) addEvent("error", "auto sender settings", failure(error));
      }
    });
  }, [status, autoSenderInput]);

  const setSocket = (field: keyof SocketSettings, value: string) =>
    onChange((next) => {
      next.socket = { ...socket, [field]: value } as SocketSettings;
    });
  const loadExample = (id: string) => {
    const example = examples.find((item) => item.id === id);
    if (!example) return;
    setSelectedExampleId(id);

    onChange((next) => {
      next.socket = {
        ...socket,
        event: example.event,
        payload: example.payload,
        format: example.format,
      };
    });
  };
  const selectedExample = examples.find((item) => item.id === selectedExampleId);
  const exampleChanged =
    !!selectedExample &&
    (selectedExample.event !== socket.event ||
      selectedExample.payload !== socket.payload ||
      selectedExample.format !== socket.format);
  const saveExample = (asNew: boolean) => {
    const name = asNew ? exampleName.trim() : selectedExample?.name;
    if (!name) return;
    const example: SocketMessageExample = {
      id: asNew ? uid() : selectedExampleId,
      name,
      event: socket.event,
      payload: socket.payload,
      format: socket.format,
    };
    onChange((next) => {
      next.socket = {
        ...socket,
        examples: !asNew
          ? examples.map((item) => (item.id === selectedExampleId ? example : item))
          : [...examples, example],
      };
    });
    setSelectedExampleId(example.id);
    setSaveExampleOpen(false);
    toast.success(asNew ? "Message saved" : "Saved message updated");
  };
  const deleteExample = () => {
    if (!selectedExampleId) return;
    onChange((next) => {
      next.socket = {
        ...socket,
        examples: examples.filter((item) => item.id !== selectedExampleId),
      };
    });
    setSelectedExampleId("");
    setExampleName("");
  };
  const setHeader = (rows: Entry[]) =>
    onChange((next) => {
      next.headers = rows;
    });
  const connect = async () => {
    if (status !== "disconnected" || !listening) return;
    const id = uid();
    session.current = id;
    setStatus("connecting");
    addEvent("status", "connecting", "Connecting…");
    try {
      await invoke("connect_socket", { sessionId: id, input: input() });
    } catch (error) {
      if (session.current === id) {
        setStatus("disconnected");
        addEvent("error", "connection", failure(error));
      }
    }
  };
  const disconnect = async () => {
    const id = session.current;
    session.current = null;
    setStatus("disconnected");
    if (id)
      await invoke("disconnect_socket", { sessionId: id }).catch((error) =>
        toast.error(failure(error)),
      );
    addEvent("status", "disconnected", "Disconnected by you");
  };
  const send = async () => {
    if (!session.current || status !== "connected") return;
    try {
      await invoke("send_socket", { sessionId: session.current, input: input() });
    } catch (error) {
      addEvent("error", "send", failure(error));
    }
  };
  useEffect(() => {
    if (!active) return;
    const key = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
        event.preventDefault();
        void (status === "connected" ? send() : connect());
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });
  return (
    <div className="socket-workbench" style={{ display: active ? "flex" : "none" }}>
      <div className="socket-heading">
        <div>
          <span className="eyebrow">
            {collection.name} / {isIo ? "Socket.IO" : "WebSocket"}
          </span>
          <input
            className="request-title"
            aria-label="Request name"
            value={request.name}
            onChange={(event) =>
              onChange((next) => {
                next.name = event.target.value;
              })
            }
          />
        </div>
        <span className={`socket-status ${status}`}>
          <span />
          {status === "connected"
            ? "Connected"
            : status === "connecting"
              ? "Connecting"
              : "Disconnected"}
        </span>
      </div>
      <div className="socket-urlbar">
        <span className="socket-protocol">{isIo ? "S.IO" : "WS"}</span>
        <VariableField
          label="Socket URL"
          variables={variables}
          value={request.url}
          placeholder={isIo ? "http://127.0.0.1:8787" : "ws://127.0.0.1:8787/chat/ws"}
          onChange={(value) =>
            onChange((next) => {
              next.url = value;
            })
          }
        />
        <button
          className="send"
          disabled={!listening}
          onClick={() => void (status === "disconnected" ? connect() : disconnect())}
        >
          {status === "disconnected" ? "Connect" : "Disconnect"}
        </button>
      </div>
      <div className="socket-layout">
        <div className="socket-compose">
          <div className="socket-section-title">Send event</div>
          <div className="socket-presets">
            <label className="socket-field">
              Saved messages
              <StyledSelect
                value={selectedExample ? selectedExampleId : ""}
                onChange={loadExample}
                options={examples.map((item) => ({ value: item.id, label: item.name }))}
                placeholder="Choose a saved message"
                ariaLabel="Saved messages"
              />
            </label>
            <div className="socket-preset-actions">
              <button
                className="subtle small"
                onClick={() => {
                  setExampleName("");
                  setSaveExampleOpen(true);
                }}
              >
                Save as new
              </button>
              <button
                className="subtle small"
                disabled={!exampleChanged}
                onClick={() => saveExample(false)}
              >
                Update
              </button>
              {selectedExample && (
                <button className="subtle small" onClick={deleteExample}>
                  Delete
                </button>
              )}
            </div>
            <span className="hint">Save an event and payload to reuse in this request.</span>
          </div>
          <Dialog open={saveExampleOpen} onOpenChange={setSaveExampleOpen}>
            <DialogContent className="rename-dialog">
              <DialogHeader>
                <DialogTitle>Save message</DialogTitle>
                <DialogDescription>
                  Save the current event and payload as a new message preset.
                </DialogDescription>
              </DialogHeader>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  saveExample(true);
                }}
              >
                <input
                  autoFocus
                  className="dialog-input"
                  aria-label="Saved message name"
                  placeholder="Message name"
                  value={exampleName}
                  onChange={(event) => setExampleName(event.target.value)}
                  required
                />
                <DialogFooter>
                  <button
                    type="button"
                    className="subtle"
                    onClick={() => setSaveExampleOpen(false)}
                  >
                    Cancel
                  </button>
                  <button className="send" disabled={!exampleName.trim()} type="submit">
                    Save message
                  </button>
                </DialogFooter>
              </form>
            </DialogContent>
          </Dialog>
          {isIo && (
            <label className="socket-field">
              Event name
              <VariableField
                label="Event name"
                variables={variables}
                value={socket.event}
                placeholder="message"
                onChange={(value) => setSocket("event", value)}
              />
            </label>
          )}
          <div className="socket-format">
            <span>Payload</span>
            <StyledSelect
              value={socket.format}
              onChange={(value) => setSocket("format", value)}
              options={[
                { value: "json", label: "JSON" },
                { value: "text", label: "Text" },
              ]}
            />
          </div>
          <div className="socket-message-editor">
            <Suspense fallback={<div className="code-editor-loading">Loading editor…</div>}>
              <CodeEditor
                label="Message payload"
                large
                variables={variables}
                theme={theme}
                language={socket.format === "json" ? "json" : "text"}
                value={socket.payload}
                onChange={(value) => setSocket("payload", value)}
              />
            </Suspense>
          </div>
          <div className="socket-compose-actions">
            {socket.format === "json" && (
              <button
                className="subtle small"
                onClick={() => {
                  try {
                    setSocket("payload", JSON.stringify(JSON.parse(socket.payload), null, 2));
                  } catch {
                    toast.error("Invalid JSON payload");
                  }
                }}
              >
                Format JSON
              </button>
            )}
            <button className="send" disabled={status !== "connected"} onClick={() => void send()}>
              Send event ↗
            </button>
          </div>
          <SocketAutoSenders
            schedules={socket.autoSenders ?? []}
            isIo={isIo}
            variables={variables}
            theme={theme}
            connected={status === "connected"}
            suspended={suspended}
            onChange={(schedules) => {
              const previous = socket.autoSenders ?? [];
              setSuspended(
                (current) =>
                  new Set(
                    [...current].filter(
                      (id) =>
                        JSON.stringify(previous.find((item) => item.id === id)) ===
                        JSON.stringify(schedules.find((item) => item.id === id)),
                    ),
                  ),
              );
              onChange((next) => {
                next.socket = { ...socket, autoSenders: schedules };
              });
            }}
          />
          <button className="socket-settings-toggle" onClick={() => setSettingsOpen(!settingsOpen)}>
            {settingsOpen ? "▾" : "▸"} Connection settings
          </button>
          {settingsOpen && (
            <div className="socket-settings">
              {isIo && (
                <>
                  <label className="socket-field">
                    Path
                    <VariableField
                      label="Socket.IO path"
                      variables={variables}
                      value={socket.path}
                      placeholder="/socket.io/"
                      onChange={(value) => setSocket("path", value)}
                    />
                  </label>
                  <label className="socket-field">
                    Namespace
                    <VariableField
                      label="Socket.IO namespace"
                      variables={variables}
                      value={socket.namespace}
                      placeholder="/"
                      onChange={(value) => setSocket("namespace", value)}
                    />
                  </label>
                  <label className="socket-field">
                    Auth JSON
                    <Suspense fallback={<div className="code-editor-loading">Loading editor…</div>}>
                      <CodeEditor
                        label="Socket.IO auth JSON"
                        language="json"
                        theme={theme}
                        variables={variables}
                        value={socket.auth}
                        onChange={(value) => setSocket("auth", value)}
                      />
                    </Suspense>
                    <span className="hint">
                      Use variables such as {"{{TOKEN}}"}. Auth changes apply when you reconnect.
                    </span>
                  </label>
                </>
              )}
              <label className="socket-field">
                Authorization
                <StyledSelect
                  value={request.auth.kind || "none"}
                  onChange={(value) =>
                    onChange((next) => {
                      next.auth.kind = value;
                    })
                  }
                  options={[
                    { value: "none", label: "No auth" },
                    { value: "bearer", label: "Bearer token" },
                    { value: "basic", label: "Basic auth" },
                  ]}
                />
              </label>
              {request.auth.kind === "bearer" && (
                <VariableField
                  label="Bearer token"
                  variables={variables}
                  value={request.auth.token}
                  placeholder="Token or {{TOKEN}}"
                  onChange={(value) =>
                    onChange((next) => {
                      next.auth.token = value;
                    })
                  }
                />
              )}
              {request.auth.kind === "basic" && (
                <>
                  <VariableField
                    label="Username"
                    variables={variables}
                    value={request.auth.username}
                    placeholder="Username"
                    onChange={(value) =>
                      onChange((next) => {
                        next.auth.username = value;
                      })
                    }
                  />
                  <VariableField
                    label="Password"
                    variables={variables}
                    value={request.auth.password}
                    placeholder="Password"
                    onChange={(value) =>
                      onChange((next) => {
                        next.auth.password = value;
                      })
                    }
                  />
                </>
              )}
              <div className="socket-section-title">Handshake headers</div>
              {request.headers.map((row) => (
                <div className="socket-header-row" key={row.id}>
                  <input
                    type="checkbox"
                    aria-label="Enabled"
                    checked={row.enabled}
                    onChange={(event) =>
                      setHeader(
                        request.headers.map((item) =>
                          item.id === row.id ? { ...item, enabled: event.target.checked } : item,
                        ),
                      )
                    }
                  />
                  <VariableField
                    label="Header name"
                    variables={variables}
                    value={row.key}
                    onChange={(value) =>
                      setHeader(
                        request.headers.map((item) =>
                          item.id === row.id ? { ...item, key: value } : item,
                        ),
                      )
                    }
                  />
                  <VariableField
                    label="Header value"
                    variables={variables}
                    value={row.value}
                    onChange={(value) =>
                      setHeader(
                        request.headers.map((item) =>
                          item.id === row.id ? { ...item, value } : item,
                        ),
                      )
                    }
                  />
                  <button
                    className="icon"
                    aria-label="Remove header"
                    onClick={() => setHeader(request.headers.filter((item) => item.id !== row.id))}
                  >
                    ×
                  </button>
                </div>
              ))}
              <button
                className="text-button"
                onClick={() => setHeader([...request.headers, entry()])}
              >
                + Add header
              </button>
              <p className="hint">Changes to connection settings take effect when you reconnect.</p>
            </div>
          )}
        </div>
        <section className="socket-log" aria-label="Socket event log">
          <div className="socket-log-toolbar">
            <strong>
              Events <span>{events.length}</span>
            </strong>
            <div>
              <button
                className="subtle small"
                onClick={() => {
                  if (paused) {
                    const resumed = buffer.current;
                    buffer.current = [];
                    setEvents((previous) => [...previous, ...resumed].slice(-MAX_LOG_EVENTS));
                    setBuffered(0);
                  } else if (pendingFrame.current !== null) {
                    cancelAnimationFrame(pendingFrame.current);
                    flushPending();
                  }
                  pausedRef.current = !paused;
                  setPaused(!paused);
                }}
              >
                {paused ? `Resume (${buffered})` : "Pause"}
              </button>
              <button
                className="subtle small"
                onClick={() => {
                  if (pendingFrame.current !== null) cancelAnimationFrame(pendingFrame.current);
                  pendingFrame.current = null;
                  pending.current = [];
                  setEvents([]);
                  buffer.current = [];
                  setBuffered(0);
                }}
              >
                Clear
              </button>
              <button
                className="subtle small"
                disabled={!events.length}
                onClick={() =>
                  void navigator.clipboard
                    .writeText(
                      events
                        .map(
                          (item) =>
                            `[${item.at}] ${item.kind}${item.autoSenderId ? ` [Auto: ${item.autoSenderName}]` : ""} ${item.event}: ${item.payload}`,
                        )
                        .join("\n"),
                    )
                    .then(
                      () => toast.success("Events copied"),
                      (error) => toast.error(failure(error)),
                    )
                }
              >
                Copy
              </button>
            </div>
          </div>
          <div className="socket-events" ref={logViewport}>
            {events.length ? (
              events.map((item) => (
                <div className={`socket-event ${item.kind}`} key={item.id}>
                  <div>
                    <time>{item.at}</time>
                    <span className="socket-event-kind">
                      {item.kind === "received"
                        ? "↓ Received"
                        : item.kind === "sent"
                          ? "↑ Sent"
                          : item.kind === "error"
                            ? "! Error"
                            : "• Status"}
                    </span>
                    <strong>{item.event}</strong>
                    {item.autoSenderId && (
                      <span className="socket-auto-tag" title={item.autoSenderName}>
                        Auto · {item.autoSenderName}
                      </span>
                    )}
                  </div>
                  {item.payload && <pre>{item.payload}</pre>}
                </div>
              ))
            ) : (
              <div className="socket-empty">Connect to start seeing events here.</div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
