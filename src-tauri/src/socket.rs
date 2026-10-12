use crate::engine::{apply_scope, interpolate_at, resolve_entries};
use crate::model::RunInput;
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
use tokio::sync::{mpsc, Mutex};
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
}

fn emit(app: &AppHandle, session_id: &str, kind: &str, event: &str, payload: impl Into<String>) {
    let _ = app.emit(
        "socket-event",
        SocketEvent {
            session_id: session_id.into(),
            kind: kind.into(),
            event: event.into(),
            payload: payload.into(),
        },
    );
}

enum SocketHandle {
    Connecting,
    WebSocket(mpsc::UnboundedSender<Message>),
    SocketIo(IoClient),
}

#[derive(Default, Clone)]
pub struct SocketManager(Arc<Mutex<HashMap<String, SocketHandle>>>);

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
    let value = if socket.format == "json" {
        serde_json::from_str(&text).map_err(|e| format!("Invalid JSON message: {e}"))?
    } else {
        serde_json::Value::String(text.clone())
    };
    Ok((text, value))
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
                manager.0.lock().await.remove(&session_id);
                return Err(match result {
                    Err(_) => "Connection timed out".into(),
                    Ok(Err(error)) => format!("WebSocket connection failed: {error}"),
                    _ => unreachable!(),
                });
            }
        };
        let (mut writer, mut reader) = stream.split();
        let (sender, mut receiver) = mpsc::unbounded_channel();
        let mut connections = manager.0.lock().await;
        if !matches!(connections.get(&session_id), Some(SocketHandle::Connecting)) {
            return Ok(());
        }
        connections.insert(session_id.clone(), SocketHandle::WebSocket(sender));
        drop(connections);
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
                        Some(message) => if let Err(error) = writer.send(message).await { emit(&app, &session_id, "error", "send", error.to_string()); break; },
                        None => { let _ = writer.send(Message::Close(None)).await; break; }
                    },
                    incoming = reader.next() => match incoming {
                        Some(Ok(Message::Text(text))) => emit(&app, &session_id, "received", "message", text.to_string()),
                        Some(Ok(Message::Binary(bytes))) => emit(&app, &session_id, "received", "binary", format!("{} bytes (base64): {}", bytes.len(), base64::engine::general_purpose::STANDARD.encode(bytes))),
                        Some(Ok(Message::Close(frame))) => { emit(&app, &session_id, "status", "disconnected", frame.map(|value| value.reason.to_string()).unwrap_or_default()); break; },
                        Some(Err(error)) => { emit(&app, &session_id, "error", "connection", error.to_string()); break; },
                        None => break,
                        _ => {}
                    }
                }
            }
            manager.0.lock().await.remove(&session_id);
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
        let auth = interpolate_at(
            &socket.auth,
            &values,
            &input.runtime_variables,
            "Socket.IO auth",
        )?;
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
        if !auth.trim().is_empty() {
            builder = builder.auth(
                serde_json::from_str::<serde_json::Value>(&auth)
                    .map_err(|e| format!("Invalid Socket.IO auth JSON: {e}"))?,
            );
        }
        let app_open = app.clone();
        let id_open = session_id.clone();
        builder = builder.on("open", move |_, _| {
            let app = app_open.clone();
            let id = id_open.clone();
            async move {
                emit(&app, &id, "status", "connected", "Socket.IO connected");
            }
            .boxed()
        });
        let app_close = app.clone();
        let id_close = session_id.clone();
        let manager_close = manager.inner().clone();
        builder = builder.on("close", move |_, _| {
            let app = app_close.clone();
            let id = id_close.clone();
            let manager = manager_close.clone();
            async move {
                manager.0.lock().await.remove(&id);
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
        builder = builder.on("error", move |payload, client| {
            let app = app_error.clone();
            let id = id_error.clone();
            let manager = manager_error.clone();
            async move {
                manager.0.lock().await.remove(&id);
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
        let connected = tokio::time::timeout(Duration::from_secs(10), builder.connect()).await;
        let client = match connected {
            Ok(Ok(value)) => value,
            result => {
                manager.0.lock().await.remove(&session_id);
                return Err(match result {
                    Err(_) => "Connection timed out".into(),
                    Ok(Err(error)) => format!("Socket.IO connection failed: {error}"),
                    _ => unreachable!(),
                });
            }
        };
        let mut connections = manager.0.lock().await;
        if !matches!(connections.get(&session_id), Some(SocketHandle::Connecting)) {
            drop(connections);
            let _ = client.disconnect().await;
            return Ok(());
        }
        connections.insert(session_id, SocketHandle::SocketIo(client));
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
    let (text, value) = payload_text(&input)?;
    let event = input
        .request
        .socket
        .as_ref()
        .map(|socket| socket.event.trim())
        .unwrap_or("");
    let handle = {
        let connections = manager.0.lock().await;
        match connections.get(&session_id) {
            Some(SocketHandle::WebSocket(sender)) => SocketHandle::WebSocket(sender.clone()),
            Some(SocketHandle::SocketIo(client)) => SocketHandle::SocketIo(client.clone()),
            _ => return Err("Socket is disconnected".into()),
        }
    };
    match handle {
        SocketHandle::WebSocket(sender) => sender
            .send(Message::Text(text.clone().into()))
            .map_err(|_| "WebSocket is disconnected".to_string())?,
        SocketHandle::SocketIo(client) => {
            if event.is_empty() {
                return Err("Enter a Socket.IO event name".into());
            }
            client.emit(event, value).await.map_err(|e| e.to_string())?;
        }
        SocketHandle::Connecting => return Err("Socket is still connecting".into()),
    }
    emit(
        &app,
        &session_id,
        "sent",
        if input.request.kind == "socketio" {
            event
        } else {
            "message"
        },
        text,
    );
    Ok(())
}

#[tauri::command]
pub async fn disconnect_socket(
    session_id: String,
    manager: State<'_, SocketManager>,
) -> Result<(), String> {
    let handle = manager.0.lock().await.remove(&session_id);
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

    #[test]
    fn socket_message_uses_scopes_and_checks_json() {
        let mut request: ApiRequest = serde_json::from_value(serde_json::json!({
            "id": "request", "name": "Chat", "method": "GET", "kind": "websocket",
            "url": "ws://localhost/chat", "socket": { "format": "json", "payload": "{}" }
        })).unwrap();
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
