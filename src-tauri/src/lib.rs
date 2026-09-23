mod engine;
mod model;
mod script;
mod storage;

use model::{RunInput, RunResult};
use std::{collections::HashMap, sync::Mutex};
use tauri::State;
use tokio::sync::oneshot;

#[derive(Default)]
struct ActiveRequests(Mutex<HashMap<String, oneshot::Sender<()>>>);

#[tauri::command]
async fn send_request(
    input: RunInput,
    active: State<'_, ActiveRequests>,
) -> Result<RunResult, String> {
    let id = input.request.id.clone();
    let (sender, receiver) = oneshot::channel();
    active
        .0
        .lock()
        .map_err(|_| "Request manager is unavailable")?
        .insert(id.clone(), sender);
    let result = tokio::select! {
        result = engine::execute(input) => result,
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
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            send_request,
            cancel_request,
            storage::load_store,
            storage::save_store,
            storage::import_store,
            storage::export_store,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
