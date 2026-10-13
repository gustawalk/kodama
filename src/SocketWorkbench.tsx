import { useEffect, useRef, useState } from "react";
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
import "./SocketWorkbench.css";

type LiveEvent = { id: string; at: string; kind: string; event: string; payload: string };
type WireEvent = { sessionId: string; kind: string; event: string; payload: string };
type Props = {
  request: ApiRequest;
  collection: Collection;
  defaults: Variable[];
  environmentVariables: Variable[];
  runtimeVariables: Record<string, string>;
  variables: Record<string, ResolvedVariable>;
  active: boolean;
  onChange: (change: (request: ApiRequest) => void) => void;
};
const failure = (error: unknown) => (error instanceof Error ? error.message : String(error));
const pretty = (text: string) => {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
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
  const session = useRef<string | null>(null);
  const pausedRef = useRef(false);
  const buffer = useRef<LiveEvent[]>([]);
  const logEnd = useRef<HTMLDivElement>(null);
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
  const addEvent = (kind: string, event: string, payload: string) => {
    const item = { id: uid(), at: new Date().toLocaleTimeString(), kind, event, payload };
    if (pausedRef.current) {
      buffer.current = [...buffer.current, item].slice(-500);
      setBuffered(buffer.current.length);
    } else setEvents((previous) => [...previous, item].slice(-500));
  };

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<WireEvent>("socket-event", ({ payload }) => {
      if (payload.sessionId !== session.current) return;
      if (payload.kind === "status")
        setStatus(payload.event === "connected" ? "connected" : "disconnected");
      addEvent(payload.kind, payload.event, payload.payload);
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
      if (session.current) void invoke("disconnect_socket", { sessionId: session.current });
    };
  }, []);
  useEffect(() => {
    if (!paused && active) logEnd.current?.scrollIntoView({ block: "end" });
  }, [events, paused, active]);

  const setSocket = (field: keyof SocketSettings, value: string) =>
    onChange((next) => {
      next.socket = { ...socket, [field]: value } as SocketSettings;
    });
  const loadExample = (id: string) => {
    const example = examples.find((item) => item.id === id);
    if (!example) return;
    setSelectedExampleId(id);
    setExampleName(example.name);
    onChange((next) => {
      next.socket = {
        ...socket,
        event: example.event,
        payload: example.payload,
        format: example.format,
      };
    });
  };
  const saveExample = () => {
    const name = exampleName.trim() || `Message ${examples.length + 1}`;
    const example: SocketMessageExample = {
      id: selectedExampleId || uid(),
      name,
      event: socket.event,
      payload: socket.payload,
      format: socket.format,
    };
    onChange((next) => {
      next.socket = {
        ...socket,
        examples: selectedExampleId
          ? examples.map((item) => (item.id === selectedExampleId ? example : item))
          : [...examples, example],
      };
    });
    setSelectedExampleId(example.id);
    setExampleName(name);
    toast.success(selectedExampleId ? "Message example updated" : "Message example saved");
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
          <div className="socket-section-title">Send message</div>
          <div className="socket-examples">
            <StyledSelect
              value={selectedExampleId}
              onChange={loadExample}
              options={examples.map((item) => ({ value: item.id, label: item.name }))}
              placeholder="Load saved message"
              ariaLabel="Saved message examples"
            />
            <button
              className="subtle small"
              onClick={() => {
                setSelectedExampleId("");
                setExampleName("");
              }}
            >
              New
            </button>
          </div>
          <div className="socket-example-save">
            <input
              aria-label="Message example name"
              placeholder="Example name"
              value={exampleName}
              onChange={(event) => setExampleName(event.target.value)}
            />
            <button className="subtle small" onClick={saveExample}>
              {selectedExampleId ? "Update" : "Save example"}
            </button>
            {selectedExampleId && (
              <button className="subtle small" onClick={deleteExample}>
                Delete
              </button>
            )}
          </div>
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
          <VariableField
            label="Message payload"
            variables={variables}
            value={socket.payload}
            placeholder={socket.format === "json" ? '{"text":"Hello!"}' : "Hello!"}
            multiline
            onChange={(value) => setSocket("payload", value)}
          />
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
              Send message ↗
            </button>
          </div>
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
                    <VariableField
                      label="Socket.IO auth JSON"
                      variables={variables}
                      value={socket.auth}
                      placeholder='{"token":"{{TOKEN}}"}'
                      multiline
                      onChange={(value) => setSocket("auth", value)}
                    />
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
                    setEvents((previous) => [...previous, ...buffer.current].slice(-500));
                    buffer.current = [];
                    setBuffered(0);
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
                        .map((item) => `[${item.at}] ${item.kind} ${item.event}: ${item.payload}`)
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
          <div className="socket-events">
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
                  </div>
                  {item.payload && <pre>{pretty(item.payload)}</pre>}
                </div>
              ))
            ) : (
              <div className="socket-empty">Connect to start seeing events here.</div>
            )}
            <div ref={logEnd} />
          </div>
        </section>
      </div>
    </div>
  );
}
