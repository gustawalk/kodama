mod engine;
mod model;
mod script;
mod storage;

use model::{RunInput, RunResult};
use reqwest::{
    cookie::{CookieStore, Jar},
    Url,
};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, RwLock},
};
use tauri::State;
use tokio::sync::oneshot;

#[derive(Default)]
struct ActiveRequests(Mutex<HashMap<String, oneshot::Sender<()>>>);
struct SessionCookies(RwLock<Arc<Jar>>);

impl Default for SessionCookies {
    fn default() -> Self {
        Self(RwLock::new(Arc::new(Jar::default())))
    }
}

#[tauri::command]
async fn send_request(
    input: RunInput,
    active: State<'_, ActiveRequests>,
    cookies: State<'_, SessionCookies>,
) -> Result<RunResult, String> {
    let id = input.request.id.clone();
    let (sender, receiver) = oneshot::channel();
    active
        .0
        .lock()
        .map_err(|_| "Request manager is unavailable")?
        .insert(id.clone(), sender);
    let jar = cookies
        .0
        .read()
        .map_err(|_| "Cookie jar is unavailable")?
        .clone();
    let result = tokio::select! {
        result = engine::execute_with_jar(input, jar) => result,
        _ = receiver => Err("Request canceled".into()),
    };
    active
        .0
        .lock()
        .map_err(|_| "Request manager is unavailable")?
        .remove(&id);
    result
}

#[tauri::command]
fn get_cookies(url: String, cookies: State<'_, SessionCookies>) -> Result<String, String> {
    let url = Url::parse(&url).map_err(|e| format!("Invalid URL: {e}"))?;
    let jar = cookies.0.read().map_err(|_| "Cookie jar is unavailable")?;
    Ok(jar
        .cookies(&url)
        .and_then(|value| value.to_str().ok().map(str::to_owned))
        .unwrap_or_default())
}

#[tauri::command]
fn clear_cookies(cookies: State<'_, SessionCookies>) -> Result<(), String> {
    *cookies.0.write().map_err(|_| "Cookie jar is unavailable")? = Arc::new(Jar::default());
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
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            send_request,
            cancel_request,
            get_cookies,
            clear_cookies,
            storage::load_store,
            storage::save_store,
            storage::import_store,
            storage::import_openapi_file,
            storage::pick_source_file,
            storage::read_source_file,
            storage::source_file_stamp,
            storage::export_store,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
