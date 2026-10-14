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
struct SessionHttp {
    jar: Arc<Jar>,
    client: Option<Client>,
}

struct SessionCookies(RwLock<SessionHttp>);

impl Default for SessionCookies {
    fn default() -> Self {
        Self(RwLock::new(SessionHttp {
            jar: Arc::new(Jar::default()),
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
    let jar = cookies.0.read().map_err(|_| "Cookie jar is unavailable")?;
    Ok(jar
        .jar
        .cookies(&url)
        .and_then(|value| value.to_str().ok().map(str::to_owned))
        .unwrap_or_default())
}

#[tauri::command]
fn clear_cookies(cookies: State<'_, SessionCookies>) -> Result<(), String> {
    *cookies.0.write().map_err(|_| "Cookie jar is unavailable")? = SessionHttp {
        jar: Arc::new(Jar::default()),
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
            clear_cookies,
            socket::connect_socket,
            socket::send_socket,
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
