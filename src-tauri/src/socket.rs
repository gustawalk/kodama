use crate::engine::{apply_scope, interpolate_at, resolve_entries};
use crate::model::{RunInput, SocketAutoSender};
use base64::Engine;
use futures_util::{FutureExt, SinkExt, StreamExt};
use reqwest::Url;
use rust_socketio::{
    asynchronous::{Client as IoClient, ClientBuilder},
    Payload,
};
use serde::Serialize;
use std::{collections::HashMap, sync::Arc, time::Duration};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::{mpsc, oneshot, watch, Mutex};
use tokio::task::JoinHandle;
use tokio::time::{interval_at, Instant, MissedTickBehavior};
use tokio_tungstenite::{
    connect_async,
    tungstenite::{
        client::IntoClientRequest,
        http::{HeaderName, HeaderValue},
        Message,
    },
};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SocketEvent {
    session_id: String,
    kind: String,
    event: String,
    payload: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    auto_sender_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    auto_sender_name: Option<String>,
}

fn emit(app: &AppHandle, session_id: &str, kind: &str, event: &str, payload: impl AsRef<str>) {
    emit_source(app, session_id, kind, event, payload, None);
}

fn emit_source(
    app: &AppHandle,
    session_id: &str,
    kind: &str,
    event: &str,
    payload: impl AsRef<str>,
    source: Option<&SocketAutoSender>,
) {
    let payload = payload.as_ref();
    let payload = if payload.len() > MAX_SOCKET_LOG_BYTES {
        let end = (0..=MAX_SOCKET_LOG_BYTES)
            .rev()
            .find(|&index| payload.is_char_boundary(index))
            .unwrap_or(0);
        format!(
            "{}\n… (event log truncated from {} bytes)",
            &payload[..end],
            payload.len()
        )
    } else {
        payload.to_owned()
    };
    let _ = app.emit(
        "socket-event",
        SocketEvent {
            session_id: session_id.into(),
            kind: kind.into(),
            event: event.into(),
            payload,
            auto_sender_id: source.map(|sender| sender.id.clone()),
            auto_sender_name: source.map(|sender| sender.name.clone()),
        },
    );
}

struct OutgoingMessage {
    message: Message,
    source: Option<SocketAutoSender>,
}

enum SocketHandle {
    Connecting,
    WebSocket(mpsc::Sender<OutgoingMessage>),
    SocketIo(IoClient),
}

const MAX_SOCKET_PAYLOAD_BYTES: usize = 256 * 1024;
const WEBSOCKET_SEND_QUEUE_SIZE: usize = 32;
const MAX_SOCKET_LOG_BYTES: usize = 16 * 1024 - 128;

#[derive(Default, Clone)]
pub struct SocketManager(
    Arc<Mutex<HashMap<String, SocketHandle>>>,
    Arc<Mutex<HashMap<String, AutoSession>>>,
);

struct AutoTask {
    config: SocketAutoSender,
    task: JoinHandle<()>,
}
impl Drop for AutoTask {
    fn drop(&mut self) {
        self.task.abort();
    }
}
struct AutoSession {
    input: watch::Sender<RunInput>,
    tasks: HashMap<String, AutoTask>,
}

fn recurring_interval(period: Duration) -> tokio::time::Interval {
    let mut timer = interval_at(Instant::now() + period, period);
    timer.set_missed_tick_behavior(MissedTickBehavior::Skip);
    timer
}

async fn run_schedule<F, Fut>(
    inputs: watch::Receiver<RunInput>,
    source: &SocketAutoSender,
    mut send: F,
) -> Result<(), String>
where
    F: FnMut(RunInput) -> Fut,
    Fut: std::future::Future<Output = Result<(), String>>,
{
    let mut timer = recurring_interval(Duration::from_secs(source.interval_seconds.into()));
    loop {
        timer.tick().await;
        let input = sender_input(inputs.borrow().clone(), source);
        send(input).await?;
    }
}

impl AutoSession {
    fn reconcile<F>(&mut self, input: RunInput, mut spawn: F)
    where
        F: FnMut(SocketAutoSender, watch::Receiver<RunInput>) -> JoinHandle<()>,
    {
        let schedules = input
            .request
            .socket
            .as_ref()
            .map(|socket| socket.auto_senders.clone())
            .unwrap_or_default();
        self.input.send_replace(input);
        // Retain failed tasks too: variable updates must not create error loops.
        self.tasks.retain(|key, task| {
            schedules
                .iter()
                .any(|item| item.enabled && item.id == *key && *item == task.config)
        });
        for config in schedules.into_iter().filter(|item| item.enabled) {
            if self.tasks.contains_key(&config.id) {
                continue;
            }
            let task = spawn(config.clone(), self.input.subscribe());
            self.tasks
                .insert(config.id.clone(), AutoTask { config, task });
        }
    }
}

fn sender_input(mut input: RunInput, sender: &SocketAutoSender) -> RunInput {
    if let Some(socket) = input.request.socket.as_mut() {
        socket.event = sender.event.clone();
        socket.payload = sender.payload.clone();
        socket.format = sender.format.clone();
    }
    input
}

fn validate_schedules(input: &RunInput) -> Result<(), String> {
    let mut ids = std::collections::HashSet::new();
    if let Some(socket) = &input.request.socket {
        for config in &socket.auto_senders {
            config.validate(input.request.kind == "socketio")?;
            uuid::Uuid::parse_str(&config.id).map_err(|_| "Invalid auto sender ID")?;
            if !ids.insert(&config.id) {
                return Err("Duplicate auto sender ID".into());
            }
        }
    }
    Ok(())
}

impl SocketManager {
    async fn remove(&self, id: &str) -> Option<SocketHandle> {
        // Same lock order as sync: removing a connection cannot leave orphan timers.
        let handle = self.0.lock().await.remove(id);
        self.1.lock().await.remove(id);
        handle
    }

    async fn sync(&self, id: &str, input: RunInput, app: &AppHandle) -> Result<(), String> {
        validate_schedules(&input)?;
        let connections = self.0.lock().await;
        if !matches!(
            connections.get(id),
            Some(SocketHandle::WebSocket(_) | SocketHandle::SocketIo(_))
        ) {
            return Err("Socket is disconnected".into());
        }
        let mut sessions = self.1.lock().await;
        let session = sessions.entry(id.into()).or_insert_with(|| AutoSession {
            input: watch::channel(input.clone()).0,
            tasks: HashMap::new(),
        });
        session.reconcile(input, |source, inputs| {
            let manager = self.clone();
            let app = app.clone();
            let id = id.to_owned();
            tokio::spawn(async move {
                let result = run_schedule(inputs, &source, |input| {
                    send_message(&id, input, &manager, &app, Some(&source))
                })
                .await;
                if let Err(error) = result {
                    emit_source(
                        &app,
                        &id,
                        "error",
                        "auto sender",
                        format!(
                            "{error}\nSchedule suspended until settings change or you reconnect."
                        ),
                        Some(&source),
                    );
                }
            })
        });
        Ok(())
    }
}

#[tauri::command]
pub async fn sync_socket_auto_senders(
    session_id: String,
    input: RunInput,
    app: AppHandle,
    manager: State<'_, SocketManager>,
) -> Result<(), String> {
    manager.sync(&session_id, input, &app).await
}

fn scopes(input: &RunInput) -> HashMap<String, String> {
    let mut values = HashMap::new();
    apply_scope(&mut values, &input.defaults);
    apply_scope(&mut values, &input.collection_variables);
    apply_scope(&mut values, &input.environment_variables);
    values.extend(input.runtime_variables.clone());
    values
}

fn headers(
    input: &RunInput,
    values: &HashMap<String, String>,
) -> Result<Vec<(String, String)>, String> {
    let mut rows = resolve_entries(
        &input.request.headers,
        values,
        &input.runtime_variables,
        "socket header",
    )?;
    match input.request.auth.kind.as_str() {
        "bearer" => rows.push((
            "Authorization".into(),
            format!(
                "Bearer {}",
                interpolate_at(
                    &input.request.auth.token,
                    values,
                    &input.runtime_variables,
                    "Bearer token"
                )?
            ),
        )),
        "basic" => {
            let username = interpolate_at(
                &input.request.auth.username,
                values,
                &input.runtime_variables,
                "Basic username",
            )?;
            let password = interpolate_at(
                &input.request.auth.password,
                values,
                &input.runtime_variables,
                "Basic password",
            )?;
            rows.push((
                "Authorization".into(),
                format!(
                    "Basic {}",
                    base64::engine::general_purpose::STANDARD
                        .encode(format!("{username}:{password}"))
                ),
            ));
        }
        _ => {}
    }
    for (name, value) in &rows {
        HeaderName::from_bytes(name.as_bytes()).map_err(|e| format!("Invalid header name: {e}"))?;
        HeaderValue::from_str(value).map_err(|e| format!("Invalid header value: {e}"))?;
    }
    Ok(rows)
}

fn payload_text(input: &RunInput) -> Result<(String, serde_json::Value), String> {
    let socket = input
        .request
        .socket
        .as_ref()
        .ok_or("Socket settings are missing")?;
    let values = scopes(input);
    let text = interpolate_at(
        &socket.payload,
        &values,
        &input.runtime_variables,
        "socket message",
    )?;
    if text.len() > MAX_SOCKET_PAYLOAD_BYTES {
        return Err("Socket message exceeds the 256 KiB send limit".into());
    }
    let value = if socket.format == "json" {
        serde_json::from_str(&text).map_err(|e| format!("Invalid JSON message: {e}"))?
    } else {
        serde_json::Value::String(text.clone())
    };
    Ok((text, value))
}

fn auth_json(input: &RunInput) -> Result<Option<serde_json::Value>, String> {
    let auth = input
        .request
        .socket
        .as_ref()
        .map(|socket| socket.auth.as_str())
        .unwrap_or("");
    let auth = interpolate_at(
        auth,
        &scopes(input),
        &input.runtime_variables,
        "Socket.IO auth",
    )?;
    if auth.trim().is_empty() {
        return Ok(None);
    }
    serde_json::from_str(&auth)
        .map(Some)
        .map_err(|error| format!("Invalid Socket.IO auth JSON: {error}"))
}

fn event_name(input: &RunInput) -> Result<String, String> {
    if input.request.kind != "socketio" {
        return Ok("message".into());
    }
    let name = interpolate_at(
        input
            .request
            .socket
            .as_ref()
            .map(|socket| socket.event.as_str())
            .unwrap_or(""),
        &scopes(input),
        &input.runtime_variables,
        "Socket.IO event name",
    )?
    .trim()
    .to_owned();
    if name.is_empty() {
        return Err("Enter a Socket.IO event name".into());
    }
    Ok(name)
}

#[tauri::command]
pub async fn connect_socket(
    session_id: String,
    input: RunInput,
    app: AppHandle,
    manager: State<'_, SocketManager>,
) -> Result<(), String> {
    let socket = input
        .request
        .socket
        .as_ref()
        .ok_or("Socket settings are missing")?;
    validate_schedules(&input)?;
    let values = scopes(&input);
    let address = interpolate_at(
        &input.request.url,
        &values,
        &input.runtime_variables,
        "socket URL",
    )?;
    let mut url = Url::parse(&address).map_err(|e| format!("Invalid socket URL: {e}"))?;
    let headers = headers(&input, &values)?;
    if manager.0.lock().await.contains_key(&session_id) {
        return Err("This socket is already connected".into());
    }
    if input.request.kind == "websocket" {
        if !matches!(url.scheme(), "ws" | "wss") {
            return Err("WebSocket URL must start with ws:// or wss://".into());
        }
        let mut request = address.into_client_request().map_err(|e| e.to_string())?;
        for (name, value) in headers {
            request.headers_mut().insert(
                HeaderName::from_bytes(name.as_bytes()).map_err(|e| e.to_string())?,
                HeaderValue::from_str(&value).map_err(|e| e.to_string())?,
            );
        }
        manager
            .0
            .lock()
            .await
            .insert(session_id.clone(), SocketHandle::Connecting);
        let connected = tokio::time::timeout(Duration::from_secs(10), connect_async(request)).await;
        let (stream, _) = match connected {
            Ok(Ok(value)) => value,
            result => {
                manager.remove(&session_id).await;
                return Err(match result {
                    Err(_) => "Connection timed out".into(),
                    Ok(Err(error)) => format!("WebSocket connection failed: {error}"),
                    _ => unreachable!(),
                });
            }
        };
        let (mut writer, mut reader) = stream.split();
        let (sender, mut receiver) = mpsc::channel(WEBSOCKET_SEND_QUEUE_SIZE);
        let mut connections = manager.0.lock().await;
        if !matches!(connections.get(&session_id), Some(SocketHandle::Connecting)) {
            return Ok(());
        }
        connections.insert(session_id.clone(), SocketHandle::WebSocket(sender));
        drop(connections);
        manager.sync(&session_id, input.clone(), &app).await?;
        emit(
            &app,
            &session_id,
            "status",
            "connected",
            "WebSocket connected",
        );
        let manager = manager.inner().clone();
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    outgoing = receiver.recv() => match outgoing {
                        Some(outgoing) => if let Err(error) = writer.send(outgoing.message).await { emit_source(&app, &session_id, "error", "send", error.to_string(), outgoing.source.as_ref()); break; },
                        None => { let _ = writer.send(Message::Close(None)).await; break; }
                    },
                    incoming = reader.next() => match incoming {
                        Some(Ok(Message::Text(text))) => emit(&app, &session_id, "received", "message", text.as_str()),
                        Some(Ok(Message::Binary(bytes))) => emit(&app, &session_id, "received", "binary", format!("{} bytes (base64 preview): {}", bytes.len(), base64::engine::general_purpose::STANDARD.encode(&bytes[..bytes.len().min(12 * 1024)]))),
                        Some(Ok(Message::Close(frame))) => { emit(&app, &session_id, "status", "disconnected", frame.map(|value| value.reason.to_string()).unwrap_or_default()); break; },
                        Some(Err(error)) => { emit(&app, &session_id, "error", "connection", error.to_string()); break; },
                        None => break,
                        _ => {}
                    }
                }
            }
            manager.remove(&session_id).await;
            emit(
                &app,
                &session_id,
                "status",
                "disconnected",
                "WebSocket disconnected",
            );
        });
    } else if input.request.kind == "socketio" {
        if !matches!(url.scheme(), "http" | "https") {
            return Err("Socket.IO URL must start with http:// or https://".into());
        }
        let path = interpolate_at(
            &socket.path,
            &values,
            &input.runtime_variables,
            "Socket.IO path",
        )?;
        if !path.starts_with('/') {
            return Err("Socket.IO path must start with /".into());
        }
        url.set_path(&path);
        let namespace = interpolate_at(
            &socket.namespace,
            &values,
            &input.runtime_variables,
            "Socket.IO namespace",
        )?;
        let auth = auth_json(&input)?;
        let mut builder = ClientBuilder::new(url.to_string())
            .namespace(if namespace.is_empty() {
                "/"
            } else {
                &namespace
            })
            .reconnect(false);
        for (name, value) in headers {
            builder = builder.opening_header(name, value);
        }
        if let Some(auth) = auth {
            builder = builder.auth(auth);
        }
        // rust_socketio::connect starts polling but does not wait for namespace acceptance.
        let (ready_tx, ready_rx) = oneshot::channel::<Result<(), String>>();
        let ready = Arc::new(Mutex::new(Some(ready_tx)));
        let ready_open = ready.clone();
        builder = builder.on("open", move |_, _| {
            let ready = ready_open.clone();
            async move {
                if let Some(sender) = ready.lock().await.take() {
                    let _ = sender.send(Ok(()));
                }
            }
            .boxed()
        });
        let app_close = app.clone();
        let id_close = session_id.clone();
        let manager_close = manager.inner().clone();
        let ready_close = ready.clone();
        builder = builder.on("close", move |_, _| {
            let ready = ready_close.clone();
            let app = app_close.clone();
            let id = id_close.clone();
            let manager = manager_close.clone();
            async move {
                if let Some(sender) = ready.lock().await.take() {
                    let _ = sender.send(Err("Socket.IO closed during handshake".into()));
                }
                manager.remove(&id).await;
                emit(
                    &app,
                    &id,
                    "status",
                    "disconnected",
                    "Socket.IO disconnected",
                );
            }
            .boxed()
        });
        let app_error = app.clone();
        let id_error = session_id.clone();
        let manager_error = manager.inner().clone();
        let ready_error = ready.clone();
        builder = builder.on("error", move |payload, client| {
            let ready = ready_error.clone();
            let app = app_error.clone();
            let id = id_error.clone();
            let manager = manager_error.clone();
            async move {
                if let Some(sender) = ready.lock().await.take() {
                    let _ = sender.send(Err(format!("Socket.IO handshake failed: {payload:?}")));
                }
                manager.remove(&id).await;
                emit(&app, &id, "error", "connection", format!("{payload:?}"));
                emit(
                    &app,
                    &id,
                    "status",
                    "disconnected",
                    "Socket.IO connection failed",
                );
                let _ = client.disconnect().await;
            }
            .boxed()
        });
        let app_event = app.clone();
        let id_event = session_id.clone();
        builder = builder.on_any(move |event, payload, _| {
            let app = app_event.clone();
            let id = id_event.clone();
            async move {
                let text = match payload {
                    Payload::Text(values) => values
                        .into_iter()
                        .map(|value| value.to_string())
                        .collect::<Vec<_>>()
                        .join(", "),
                    Payload::Binary(bytes) => format!("{} binary bytes", bytes.len()),
                    #[allow(deprecated)]
                    Payload::String(text) => text,
                };
                emit(&app, &id, "received", event.as_str(), text);
            }
            .boxed()
        });
        manager
            .0
            .lock()
            .await
            .insert(session_id.clone(), SocketHandle::Connecting);
        let deadline = Instant::now() + Duration::from_secs(10);
        let connected = tokio::time::timeout_at(deadline, builder.connect()).await;
        let client = match connected {
            Ok(Ok(value)) => value,
            result => {
                manager.remove(&session_id).await;
                return Err(match result {
                    Err(_) => "Connection timed out".into(),
                    Ok(Err(error)) => format!("Socket.IO connection failed: {error}"),
                    _ => unreachable!(),
                });
            }
        };
        let handshake = tokio::time::timeout_at(deadline, ready_rx).await;
        if !matches!(handshake, Ok(Ok(Ok(())))) {
            manager.remove(&session_id).await;
            let _ = client.disconnect().await;
            return Err(match handshake {
                Ok(Ok(Err(error))) => error,
                _ => "Socket.IO handshake timed out".into(),
            });
        }
        let mut connections = manager.0.lock().await;
        if !matches!(connections.get(&session_id), Some(SocketHandle::Connecting)) {
            drop(connections);
            let _ = client.disconnect().await;
            return Ok(());
        }
        connections.insert(session_id.clone(), SocketHandle::SocketIo(client));
        drop(connections);
        manager.sync(&session_id, input, &app).await?;
        emit(
            &app,
            &session_id,
            "status",
            "connected",
            "Socket.IO connected",
        );
    } else {
        return Err("This request is not a socket request".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn send_socket(
    session_id: String,
    input: RunInput,
    manager: State<'_, SocketManager>,
    app: AppHandle,
) -> Result<(), String> {
    send_message(&session_id, input, &manager, &app, None).await
}

async fn send_message(
    session_id: &str,
    input: RunInput,
    manager: &SocketManager,
    app: &AppHandle,
    source: Option<&SocketAutoSender>,
) -> Result<(), String> {
    let (text, value) = payload_text(&input)?;
    let event = event_name(&input)?;
    let handle = {
        let connections = manager.0.lock().await;
        match connections.get(session_id) {
            Some(SocketHandle::WebSocket(sender)) => SocketHandle::WebSocket(sender.clone()),
            Some(SocketHandle::SocketIo(client)) => SocketHandle::SocketIo(client.clone()),
            _ => return Err("Socket is disconnected".into()),
        }
    };
    match handle {
        SocketHandle::WebSocket(sender) => sender
            .try_send(OutgoingMessage {
                message: Message::Text(text.clone().into()),
                source: source.cloned(),
            })
            .map_err(|error| match error {
                mpsc::error::TrySendError::Full(_) => {
                    "WebSocket send queue is full. Wait for messages to drain.".to_string()
                }
                mpsc::error::TrySendError::Closed(_) => "WebSocket is disconnected".to_string(),
            })?,
        SocketHandle::SocketIo(client) => {
            client
                .emit(event.as_str(), value)
                .await
                .map_err(|e| e.to_string())?;
        }
        SocketHandle::Connecting => return Err("Socket is still connecting".into()),
    }
    emit_source(app, session_id, "sent", &event, text, source);
    Ok(())
}

#[tauri::command]
pub async fn disconnect_socket(
    session_id: String,
    manager: State<'_, SocketManager>,
) -> Result<(), String> {
    let handle = manager.remove(&session_id).await;
    match handle {
        Some(SocketHandle::Connecting) => {}
        Some(SocketHandle::WebSocket(_)) => {}
        Some(SocketHandle::SocketIo(client)) => {
            client.disconnect().await.map_err(|e| e.to_string())?
        }
        None => {}
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{ApiRequest, Variable};

    fn test_input() -> RunInput {
        serde_json::from_value(serde_json::json!({
            "request": {"id": "request", "name": "Chat", "kind": "socketio", "method": "GET", "url": "http://localhost", "socket": {"format": "json", "payload": "{}"}},
            "environmentVariables": [{"id": "var", "name": "TOKEN", "value": "secret", "secret": true}]
        })).unwrap()
    }

    fn schedule(id: &str, seconds: u32) -> SocketAutoSender {
        SocketAutoSender {
            id: id.into(),
            name: id.into(),
            interval_seconds: seconds,
            enabled: true,
            event: "ping".into(),
            payload: "{}".into(),
            format: "json".into(),
        }
    }

    #[test]
    fn auth_and_events_resolve_variables_before_validation() {
        let mut input = test_input();
        assert_eq!(auth_json(&input).unwrap(), None);
        input.request.socket.as_mut().unwrap().auth = "{\"token\":\"{{TOKEN}}\"}".into();
        assert_eq!(
            auth_json(&input).unwrap(),
            Some(serde_json::json!({"token": "secret"}))
        );
        input.request.socket.as_mut().unwrap().auth = "{\"token\":\"{{MISSING}}\"}".into();
        assert!(auth_json(&input).unwrap_err().contains("MISSING"));
        input.request.socket.as_mut().unwrap().auth = "{bad}".into();
        assert!(auth_json(&input)
            .unwrap_err()
            .contains("Invalid Socket.IO auth JSON"));
        input.request.socket.as_mut().unwrap().event = "{{TOKEN}}:ping".into();
        assert_eq!(event_name(&input).unwrap(), "secret:ping");
        input.request.socket.as_mut().unwrap().event = "{{MISSING}}".into();
        assert!(event_name(&input).unwrap_err().contains("MISSING"));
        input.request.socket.as_mut().unwrap().event = " ".into();
        assert!(event_name(&input).is_err());
    }

    #[test]
    fn schedules_validate_and_legacy_settings_default_to_empty() {
        let input = test_input();
        assert!(input.request.socket.unwrap().auto_senders.is_empty());
        let mut sender = schedule("ping", 30);
        assert!(sender.validate(true).is_ok());
        sender.interval_seconds = 0;
        assert!(sender.validate(false).is_err());
        sender.interval_seconds = 30;
        sender.event.clear();
        assert!(sender.validate(true).is_err());
        assert!(sender.validate(false).is_ok());
        sender.format = "binary".into();
        assert!(sender.validate(false).is_err());
    }

    #[tokio::test(start_paused = true)]
    async fn schedules_wait_resolve_latest_inputs_and_suspend_on_failure() {
        let (tx, rx) = watch::channel(test_input());
        let (sent, mut received) = mpsc::unbounded_channel();
        let source = schedule("keepalive", 30);
        let task = tokio::spawn(async move {
            run_schedule(rx, &source, |input| {
                let sent = sent.clone();
                async move {
                    sent.send(input).unwrap();
                    Err("send failed".into())
                }
            })
            .await
        });
        tokio::task::yield_now().await;
        assert!(received.try_recv().is_err());
        tokio::time::advance(Duration::from_secs(29)).await;
        assert!(received.try_recv().is_err());
        let mut latest = test_input();
        latest
            .runtime_variables
            .insert("TOKEN".into(), "updated".into());
        tx.send_replace(latest);
        tokio::time::advance(Duration::from_secs(1)).await;
        tokio::task::yield_now().await;
        let input = received.try_recv().unwrap();
        assert_eq!(input.runtime_variables["TOKEN"], "updated");
        assert_eq!(input.request.socket.unwrap().event, "ping");
        assert_eq!(task.await.unwrap().unwrap_err(), "send failed");
        tokio::time::advance(Duration::from_secs(300)).await;
        assert!(received.try_recv().is_err());
    }

    #[tokio::test(start_paused = true)]
    async fn slow_sends_do_not_overlap_or_replay_missed_intervals() {
        let (_, rx) = watch::channel(test_input());
        let (sent, mut received) = mpsc::unbounded_channel();
        let source = schedule("slow", 10);
        let task = tokio::spawn(async move {
            run_schedule(rx, &source, |_| {
                let sent = sent.clone();
                async move {
                    sent.send(Instant::now()).unwrap();
                    tokio::time::sleep(Duration::from_secs(35)).await;
                    Ok(())
                }
            })
            .await
        });
        tokio::task::yield_now().await;
        let start = Instant::now();
        tokio::time::advance(Duration::from_secs(10)).await;
        tokio::task::yield_now().await;
        assert_eq!(
            received.try_recv().unwrap() - start,
            Duration::from_secs(10)
        );
        tokio::time::advance(Duration::from_secs(34)).await;
        tokio::task::yield_now().await;
        assert!(received.try_recv().is_err());
        tokio::time::advance(Duration::from_secs(1)).await;
        tokio::task::yield_now().await;
        // One overdue tick is handled; the skipped 20/30/40-second ticks never burst.
        assert_eq!(
            received.try_recv().unwrap() - start,
            Duration::from_secs(45)
        );
        assert!(received.try_recv().is_err());
        task.abort();
    }

    #[tokio::test(start_paused = true)]
    async fn missed_ticks_skip_catch_up_bursts() {
        let start = Instant::now();
        let mut timer = recurring_interval(Duration::from_secs(30));
        tokio::time::advance(Duration::from_secs(100)).await;
        timer.tick().await;
        let tick = timer.tick().await;
        assert_eq!(tick, Instant::now());
        // The following tick is at 120 seconds, rather than replaying 60 and 90.
        assert_eq!(tick - start, Duration::from_secs(120));
    }

    #[tokio::test(start_paused = true)]
    async fn reconcile_restarts_only_changed_tasks_and_cancels_removed_tasks() {
        let mut input = test_input();
        input.request.socket.as_mut().unwrap().auto_senders =
            vec![schedule("a", 30), schedule("b", 60)];
        let mut session = AutoSession {
            input: watch::channel(input.clone()).0,
            tasks: HashMap::new(),
        };
        let spawn = |_: SocketAutoSender, _: watch::Receiver<RunInput>| {
            tokio::spawn(std::future::pending::<()>())
        };
        session.reconcile(input.clone(), spawn);
        let a = session.tasks["a"].task.abort_handle();
        let b = session.tasks["b"].task.abort_handle();
        // Live variable changes do not restart either timer.
        input
            .runtime_variables
            .insert("TOKEN".into(), "fresh".into());
        session.reconcile(input.clone(), spawn);
        tokio::task::yield_now().await;
        assert!(!a.is_finished() && !b.is_finished());
        input.request.socket.as_mut().unwrap().auto_senders[0].interval_seconds = 10;
        session.reconcile(input.clone(), spawn);
        tokio::task::yield_now().await;
        assert!(a.is_finished());
        assert!(!b.is_finished());
        input.request.socket.as_mut().unwrap().auto_senders[1].enabled = false;
        session.reconcile(input.clone(), spawn);
        tokio::task::yield_now().await;
        assert!(b.is_finished());
        let active = session.tasks["a"].task.abort_handle();
        drop(session);
        tokio::task::yield_now().await;
        assert!(active.is_finished());
        // A fresh connection recreates the enabled schedules.
        let mut reconnected = AutoSession {
            input: watch::channel(input.clone()).0,
            tasks: HashMap::new(),
        };
        reconnected.reconcile(input, spawn);
        assert_eq!(reconnected.tasks.len(), 1);
    }

    #[test]
    fn socket_message_uses_scopes_and_checks_json() {
        let mut request: ApiRequest = serde_json::from_value(serde_json::json!({
            "id": "request", "name": "Chat", "method": "GET", "kind": "websocket",
            "url": "ws://localhost/chat", "socket": { "format": "json", "payload": "{}" }
        }))
        .unwrap();
        let mut input = RunInput {
            request: request.clone(),
            defaults: vec![],
            collection_variables: vec![],
            environment_variables: vec![Variable {
                id: "name".into(),
                name: "NAME".into(),
                value: "Ada".into(),
                secret: false,
            }],
            runtime_variables: HashMap::new(),
        };
        request.socket.as_mut().unwrap().payload = "{\"name\":\"{{NAME}}\"}".into();
        input.request = request.clone();
        assert_eq!(
            payload_text(&input).unwrap().1,
            serde_json::json!({"name":"Ada"})
        );
        request.socket.as_mut().unwrap().payload = "{broken".into();
        input.request = request.clone();
        assert!(payload_text(&input)
            .unwrap_err()
            .contains("Invalid JSON message"));
        request.socket.as_mut().unwrap().format = "text".into();
        request.socket.as_mut().unwrap().payload = "Hello {{NAME}}".into();
        input.request = request;
        assert_eq!(payload_text(&input).unwrap().0, "Hello Ada");
    }
}
