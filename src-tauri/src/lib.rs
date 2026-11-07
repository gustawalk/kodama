mod engine;
mod model;
mod script;
mod socket;
mod storage;

use model::{RunInput, RunResult};
use reqwest::{
    cookie::{CookieStore, Jar},
    Client, Url,
};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, RwLock},
    time::Instant,
};
use tauri::State;
use tokio::sync::oneshot;

#[derive(Default)]
struct ActiveRequests(Mutex<HashMap<String, oneshot::Sender<()>>>);
#[derive(Clone, serde::Serialize, serde::Deserialize)]
struct ManualCookie {
    name: String,
    value: String,
    enabled: bool,
    #[serde(default)]
    deleted: bool,
}
#[derive(Default)]
struct ManagedJar {
    jar: Jar,
    manual: RwLock<HashMap<String, Vec<ManualCookie>>>,
}
impl CookieStore for ManagedJar {
    fn set_cookies(
        &self,
        headers: &mut dyn Iterator<Item = &reqwest::header::HeaderValue>,
        url: &Url,
    ) {
        self.jar.set_cookies(headers, url);
    }
    fn cookies(&self, url: &Url) -> Option<reqwest::header::HeaderValue> {
        let original = self.jar.cookies(url);
        let manual = self.manual.read().ok()?;
        let rows = manual.get(&url.origin().ascii_serialization());
        let mut parts: Vec<String> = original
            .as_ref()
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .split(';')
            .filter(|v| !v.trim().is_empty())
            .filter(|v| {
                let name = v.split('=').next().unwrap_or("").trim();
                !rows.is_some_and(|rows| rows.iter().any(|r| r.name == name))
            })
            .map(|v| v.trim().to_string())
            .collect();
        if let Some(rows) = rows {
            parts.extend(
                rows.iter()
                    .filter(|r| r.enabled && !r.deleted)
                    .map(|r| format!("{}={}", r.name, r.value)),
            );
        }
        if parts.is_empty() {
            None
        } else {
            reqwest::header::HeaderValue::from_str(&parts.join("; ")).ok()
        }
    }
}

#[tauri::command]
fn manage_cookies(
    url: String,
    rows: Option<Vec<ManualCookie>>,
    cookies: State<'_, SessionCookies>,
) -> Result<Vec<ManualCookie>, String> {
    let url = Url::parse(&url).map_err(|e| e.to_string())?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("Use an HTTP or HTTPS URL".into());
    }
    let session = cookies
        .inner()
        .0
        .read()
        .map_err(|_| "Cookie jar unavailable")?;
    let origin = url.origin().ascii_serialization();
    if let Some(rows) = rows {
        let mut names = std::collections::HashSet::new();
        for row in &rows {
            if row.name.is_empty()
                || !row
                    .name
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&b))
                || row
                    .value
                    .bytes()
                    .any(|b| !(0x21..=0x7e).contains(&b) || b";\"\\".contains(&b))
            {
                return Err("Invalid cookie name or value".into());
            }
            if !names.insert(&row.name) {
                return Err("Cookie names must be unique".into());
            }
        }
        let mut rows = rows;
        let mut previous = session
            .jar
            .manual
            .read()
            .map_err(|_| "Cookie jar unavailable")?
            .get(&origin)
            .cloned()
            .unwrap_or_default();
        if let Some(header) = session.jar.jar.cookies(&url) {
            for part in header.to_str().unwrap_or("").split(';') {
                if let Some((name, value)) = part.trim().split_once('=') {
                    previous.push(ManualCookie {
                        name: name.into(),
                        value: value.into(),
                        enabled: true,
                        deleted: false,
                    });
                }
            }
        }
        for mut old in previous {
            if !rows.iter().any(|r| r.name == old.name) {
                old.enabled = false;
                old.deleted = true;
                rows.push(old);
            }
        }
        session
            .jar
            .manual
            .write()
            .map_err(|_| "Cookie jar unavailable")?
            .insert(origin.clone(), rows);
    }
    let mut result = session
        .jar
        .manual
        .read()
        .map_err(|_| "Cookie jar unavailable")?
        .get(&origin)
        .cloned()
        .unwrap_or_default();
    if let Some(header) = session.jar.jar.cookies(&url) {
        for part in header.to_str().unwrap_or("").split(';') {
            if let Some((name, value)) = part.trim().split_once('=') {
                if !result.iter().any(|r| r.name == name) {
                    result.push(ManualCookie {
                        name: name.into(),
                        value: value.into(),
                        enabled: true,
                        deleted: false,
                    });
                }
            }
        }
    }
    Ok(result.into_iter().filter(|r| !r.deleted).collect())
}

struct SessionHttp {
    jar: Arc<ManagedJar>,
    client: Option<Client>,
}

struct SessionCookies(RwLock<SessionHttp>);

impl Default for SessionCookies {
    fn default() -> Self {
        Self(RwLock::new(SessionHttp {
            jar: Arc::new(ManagedJar::default()),
            client: None,
        }))
    }
}

impl SessionCookies {
    fn client(&self) -> Result<Client, String> {
        let mut session = self.0.write().map_err(|_| "Cookie jar is unavailable")?;
        if session.client.is_none() {
            session.client = Some(engine::build_client(session.jar.clone())?);
        }
        Ok(session
            .client
            .as_ref()
            .expect("client was initialized")
            .clone())
    }
}

#[tauri::command]
async fn send_request(
    input: RunInput,
    active: State<'_, ActiveRequests>,
    cookies: State<'_, SessionCookies>,
) -> Result<RunResult, String> {
    let started = Instant::now();
    let id = input.request.id.clone();
    let client = cookies.client()?;
    let (sender, receiver) = oneshot::channel();
    active
        .0
        .lock()
        .map_err(|_| "Request manager is unavailable")?
        .insert(id.clone(), sender);
    let result = tokio::select! {
        result = engine::execute_with_client(input, client) => result,
        _ = receiver => Err("Request canceled".into()),
    };
    active
        .0
        .lock()
        .map_err(|_| "Request manager is unavailable")?
        .remove(&id);
    result.map(|mut response| {
        response.elapsed_ms = started.elapsed().as_millis();
        response
    })
}

#[tauri::command]
fn get_cookies(url: String, cookies: State<'_, SessionCookies>) -> Result<String, String> {
    let url = Url::parse(&url).map_err(|e| format!("Invalid URL: {e}"))?;
    let jar = cookies
        .inner()
        .0
        .read()
        .map_err(|_| "Cookie jar is unavailable")?;
    Ok(jar
        .jar
        .cookies(&url)
        .and_then(|value| value.to_str().ok().map(str::to_owned))
        .unwrap_or_default())
}

#[tauri::command]
fn clear_cookies(cookies: State<'_, SessionCookies>) -> Result<(), String> {
    *cookies
        .inner()
        .0
        .write()
        .map_err(|_| "Cookie jar is unavailable")? = SessionHttp {
        jar: Arc::new(ManagedJar::default()),
        client: None,
    };
    Ok(())
}

#[tauri::command]
fn cancel_request(id: String, active: State<'_, ActiveRequests>) -> Result<(), String> {
    if let Some(sender) = active
        .0
        .lock()
        .map_err(|_| "Request manager is unavailable")?
        .remove(&id)
    {
        let _ = sender.send(());
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(ActiveRequests::default())
        .manage(SessionCookies::default())
        .manage(socket::SocketManager::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            send_request,
            cancel_request,
            get_cookies,
            manage_cookies,
            clear_cookies,
            socket::connect_socket,
            socket::send_socket,
            socket::sync_socket_auto_senders,
            socket::disconnect_socket,
            storage::load_workspaces,
            storage::save_workspaces,
            storage::import_store,
            storage::import_openapi_file,
            storage::pick_source_file,
            storage::read_source_file,
            storage::source_file_stamp,
            storage::source_file_stamps,
            storage::export_store,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod managed_cookie_tests {
    use super::*;
    #[test]
    fn overrides_disables_and_isolates_origins() {
        let jar = ManagedJar::default();
        let url = Url::parse("https://example.test/path").unwrap();
        jar.jar.add_cookie_str("session=server; Path=/", &url);
        jar.manual.write().unwrap().insert(
            url.origin().ascii_serialization(),
            vec![
                ManualCookie {
                    name: "session".into(),
                    value: "manual".into(),
                    enabled: true,
                    deleted: false,
                },
                ManualCookie {
                    name: "extra".into(),
                    value: "value".into(),
                    enabled: true,
                    deleted: false,
                },
            ],
        );
        assert_eq!(jar.cookies(&url).unwrap(), "session=manual; extra=value");
        assert!(jar
            .cookies(&Url::parse("https://other.test/").unwrap())
            .is_none());
        jar.manual
            .write()
            .unwrap()
            .get_mut(&url.origin().ascii_serialization())
            .unwrap()[0]
            .enabled = false;
        assert_eq!(jar.cookies(&url).unwrap(), "extra=value");
    }
}
