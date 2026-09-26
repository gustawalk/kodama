use crate::model::{Store, Workspace, WorkspaceData, FORMAT_VERSION};
use serde::Serialize;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::{
    collections::HashSet,
    fs,
    fs::OpenOptions,
    io::Write,
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;
use tokio::sync::oneshot;
use uuid::Uuid;

fn data_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    fs::set_permissions(&dir, fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?;
    Ok(dir.join("kodama.json"))
}

fn validate(store: &Store) -> Result<(), String> {
    if store.version != FORMAT_VERSION {
        return Err(format!(
            "Unsupported Kodama format version: {}",
            store.version
        ));
    }
    let mut ids = HashSet::new();
    let mut add = |id: &str| -> Result<(), String> {
        Uuid::parse_str(id).map_err(|_| format!("Invalid UUID: {id}"))?;
        if !ids.insert(id.to_string()) {
            return Err(format!("Duplicate UUID: {id}"));
        }
        Ok(())
    };
    for variable in &store.defaults {
        add(&variable.id)?;
    }
    for collection in &store.collections {
        add(&collection.id)?;
        for folder in &collection.folders {
            add(&folder.id)?;
        }
        for request in &collection.requests {
            add(&request.id)?;
            for entry in request
                .query
                .iter()
                .chain(&request.path_params)
                .chain(&request.headers)
                .chain(&request.body.fields)
            {
                add(&entry.id)?;
            }
        }
        for variable in &collection.variables {
            add(&variable.id)?;
        }
    }
    for environment in &store.environments {
        add(&environment.id)?;
        for variable in &environment.variables {
            add(&variable.id)?;
        }
    }
    Ok(())
}

fn validate_workspaces(data: &WorkspaceData) -> Result<(), String> {
    if data.version != 1 {
        return Err(format!(
            "Unsupported workspace format version: {}",
            data.version
        ));
    }
    if data.workspaces.is_empty() {
        return Err("At least one workspace is required".into());
    }
    let mut ids = HashSet::new();
    for workspace in &data.workspaces {
        Uuid::parse_str(&workspace.id).map_err(|_| "Invalid workspace UUID")?;
        if !ids.insert(&workspace.id) {
            return Err("Duplicate workspace UUID".into());
        }
        if workspace.name.trim().is_empty() {
            return Err("Workspace name cannot be empty".into());
        }
        validate(&workspace.store)?;
    }
    if !ids.contains(&data.active_workspace_id) {
        return Err("Active workspace does not exist".into());
    }
    Ok(())
}

fn scrub_secrets(store: &mut Store) {
    for variable in &mut store.defaults {
        if variable.secret {
            variable.value.clear();
        }
    }
    for collection in &mut store.collections {
        collection.source = None;
        for variable in &mut collection.variables {
            if variable.secret {
                variable.value.clear();
            }
        }
        for request in &mut collection.requests {
            if !request.auth.password.contains("{{") {
                request.auth.password.clear();
            }
            if !request.auth.token.contains("{{") {
                request.auth.token.clear();
            }
            for header in &mut request.headers {
                if (header.key.eq_ignore_ascii_case("authorization")
                    || header.key.eq_ignore_ascii_case("cookie"))
                    && !header.value.contains("{{")
                {
                    header.value.clear();
                }
            }
        }
    }
    for environment in &mut store.environments {
        for variable in &mut environment.variables {
            if variable.secret {
                variable.value.clear();
            }
        }
    }
}

fn read_workspaces(path: &Path) -> Result<Option<WorkspaceData>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let data = fs::read(path).map_err(|e| e.to_string())?;
    let value: serde_json::Value =
        serde_json::from_slice(&data).map_err(|e| format!("Saved data is invalid: {e}"))?;
    let workspaces = if value.get("workspaces").is_some() {
        serde_json::from_value(value).map_err(|e| format!("Saved workspaces are invalid: {e}"))?
    } else {
        let store: Store = serde_json::from_value(value)
            .map_err(|e| format!("Saved workspace is invalid: {e}"))?;
        validate(&store)?;
        let id = Uuid::new_v4().to_string();
        WorkspaceData {
            version: 1,
            active_workspace_id: id.clone(),
            workspaces: vec![Workspace {
                id,
                name: "My workspace".into(),
                store,
            }],
        }
    };
    validate_workspaces(&workspaces)?;
    Ok(Some(workspaces))
}

#[tauri::command]
pub fn load_workspaces(app: AppHandle) -> Result<Option<WorkspaceData>, String> {
    let path = data_path(&app)?;
    read_workspaces(&path)
}

#[tauri::command]
pub fn save_workspaces(app: AppHandle, workspaces: WorkspaceData) -> Result<(), String> {
    validate_workspaces(&workspaces)?;
    let path = data_path(&app)?;
    write_local_data(&path, &workspaces)
}

#[cfg(test)]
fn write_local_store(path: &Path, store: &Store) -> Result<(), String> {
    write_local_data(path, store)
}

fn write_local_data<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let temp = path.with_extension("json.tmp");
    let data = serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?;
    let mut file = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(&temp)
        .map_err(|e| e.to_string())?;
    #[cfg(unix)]
    fs::set_permissions(&temp, fs::Permissions::from_mode(0o600)).map_err(|e| e.to_string())?;
    file.write_all(&data).map_err(|e| e.to_string())?;
    file.sync_all().map_err(|e| e.to_string())?;
    fs::rename(&temp, &path).map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceFile {
    path: String,
    stamp: String,
    contents: String,
}

fn source_stamp(path: &Path) -> Result<String, String> {
    let metadata = fs::metadata(path).map_err(|e| format!("Could not read source file: {e}"))?;
    if !metadata.is_file() {
        return Err("OpenAPI source must be a file".into());
    }
    if metadata.len() > 20 * 1024 * 1024 {
        return Err("OpenAPI source exceeds 20 MiB".into());
    }
    let modified = metadata
        .modified()
        .map_err(|e| e.to_string())?
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_nanos();
    Ok(format!("{}:{modified}", metadata.len()))
}

#[tauri::command]
pub fn source_file_stamp(path: String) -> Result<String, String> {
    source_stamp(Path::new(&path))
}

#[tauri::command]
pub fn source_file_stamps(paths: Vec<String>) -> Vec<Option<String>> {
    paths.iter().map(|path| source_stamp(Path::new(path)).ok()).collect()
}

#[tauri::command]
pub fn read_source_file(path: String) -> Result<SourceFile, String> {
    let path = Path::new(&path);
    let stamp = source_stamp(path)?;
    let contents =
        fs::read_to_string(path).map_err(|e| format!("Could not read source file: {e}"))?;
    Ok(SourceFile {
        path: path.to_string_lossy().into_owned(),
        stamp,
        contents,
    })
}

#[tauri::command]
pub async fn pick_source_file(app: AppHandle) -> Result<Option<SourceFile>, String> {
    let (sender, receiver) = oneshot::channel();
    app.dialog()
        .file()
        .add_filter("OpenAPI source", &["json", "yaml", "yml", "ts", "tsx", "js", "mjs", "cjs"])
        .pick_file(move |path| {
            let _ = sender.send(path);
        });
    let Some(path) = receiver.await.map_err(|_| "Open dialog failed")? else {
        return Ok(None);
    };
    read_source_file(
        path.as_path()
            .ok_or("Choose a local source file")?
            .to_string_lossy()
            .into_owned(),
    )
    .map(Some)
}

#[tauri::command]
pub async fn import_store(app: AppHandle) -> Result<Option<Store>, String> {
    let (sender, receiver) = oneshot::channel();
    app.dialog()
        .file()
        .add_filter("Kodama JSON", &["json"])
        .pick_file(move |path| {
            let _ = sender.send(path);
        });
    let Some(path) = receiver.await.map_err(|_| "Open dialog failed")? else {
        return Ok(None);
    };
    let data =
        fs::read(path.as_path().ok_or("Choose a local JSON file")?).map_err(|e| e.to_string())?;
    if data.len() > 20 * 1024 * 1024 {
        return Err("Import file exceeds 20 MiB".into());
    }
    let mut store: Store =
        serde_json::from_slice(&data).map_err(|e| format!("Import is invalid JSON: {e}"))?;
    validate(&store)?;
    for collection in &mut store.collections {
        for request in &mut collection.requests {
            if !request.pre_script.trim().is_empty() || !request.post_script.trim().is_empty() {
                request.trusted = false;
            }
        }
    }
    Ok(Some(store))
}

#[tauri::command]
pub async fn import_openapi_file(app: AppHandle) -> Result<Option<SourceFile>, String> {
    let (sender, receiver) = oneshot::channel();
    app.dialog()
        .file()
        .add_filter("OpenAPI document", &["json", "yaml", "yml"])
        .pick_file(move |path| {
            let _ = sender.send(path);
        });
    let Some(path) = receiver.await.map_err(|_| "Open dialog failed")? else {
        return Ok(None);
    };
    read_source_file(path.as_path().ok_or("Choose a local OpenAPI file")?.to_string_lossy().into_owned()).map(Some)
}

#[tauri::command]
pub async fn export_store(app: AppHandle, mut store: Store) -> Result<bool, String> {
    validate(&store)?;
    scrub_secrets(&mut store);
    for collection in &mut store.collections {
        for request in &mut collection.requests {
            request.trusted = false;
        }
    }
    let (sender, receiver) = oneshot::channel();
    app.dialog()
        .file()
        .add_filter("Kodama JSON", &["json"])
        .set_file_name("kodama-export.json")
        .save_file(move |path| {
            let _ = sender.send(path);
        });
    let Some(path) = receiver.await.map_err(|_| "Save dialog failed")? else {
        return Ok(false);
    };
    let bytes = serde_json::to_vec_pretty(&store).map_err(|e| e.to_string())?;
    fs::write(path.as_path().ok_or("Choose a local file")?, bytes).map_err(|e| e.to_string())?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Collection, Environment, Variable};

    #[test]
    fn legacy_store_becomes_first_workspace_without_losing_data() {
        let path = std::env::temp_dir().join(format!("kodama-migrate-{}.json", Uuid::new_v4()));
        let mut store = Store::default();
        store.collections.push(Collection {
            id: Uuid::new_v4().to_string(),
            name: "Existing API".into(),
            variables: vec![],
            folders: vec![],
            requests: vec![],
            source: None,
        });
        write_local_store(&path, &store).unwrap();
        let migrated = read_workspaces(&path).unwrap().unwrap();
        assert_eq!(migrated.workspaces.len(), 1);
        assert_eq!(
            migrated.workspaces[0].store.collections[0].name,
            "Existing API"
        );
        assert_eq!(migrated.active_workspace_id, migrated.workspaces[0].id);
        write_local_data(&path, &migrated).unwrap();
        let reloaded = read_workspaces(&path).unwrap().unwrap();
        assert_eq!(
            reloaded.workspaces[0].store.collections[0].name,
            "Existing API"
        );
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn workspace_container_keeps_projects_separate() {
        let first = Uuid::new_v4().to_string();
        let second = Uuid::new_v4().to_string();
        let data = WorkspaceData {
            version: 1,
            active_workspace_id: second.clone(),
            workspaces: vec![
                Workspace {
                    id: first,
                    name: "One".into(),
                    store: Store::default(),
                },
                Workspace {
                    id: second,
                    name: "Two".into(),
                    store: Store::default(),
                },
            ],
        };
        let path = std::env::temp_dir().join(format!("kodama-workspaces-{}.json", Uuid::new_v4()));
        write_local_data(&path, &data).unwrap();
        let loaded = read_workspaces(&path).unwrap().unwrap();
        assert_eq!(loaded.workspaces.len(), 2);
        assert_eq!(loaded.workspaces[1].name, "Two");
        assert_eq!(loaded.active_workspace_id, data.active_workspace_id);
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn reads_linked_source_file_and_reports_its_stamp() {
        let path = std::env::temp_dir().join(format!("kodama-source-{}.ts", Uuid::new_v4()));
        fs::write(&path, "export const openApiDocument = {};").unwrap();
        let file = read_source_file(path.to_string_lossy().into_owned()).unwrap();
        assert_eq!(file.contents, "export const openApiDocument = {};");
        assert_eq!(
            file.stamp,
            source_file_stamp(path.to_string_lossy().into_owned()).unwrap()
        );
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn local_save_retains_secret_values_across_reload() {
        let path =
            std::env::temp_dir().join(format!("kodama-storage-test-{}.json", Uuid::new_v4()));
        let mut store = Store::default();
        store.defaults.push(Variable {
            id: Uuid::new_v4().to_string(),
            name: "TOKEN".into(),
            value: "persistent-token".into(),
            secret: true,
        });
        write_local_store(&path, &store).unwrap();
        let loaded: Store = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(loaded.defaults[0].value, "persistent-token");
        #[cfg(unix)]
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn export_shape_keeps_structure_but_drops_secrets() {
        let mut store = Store {
            version: 1,
            defaults: vec![],
            collections: vec![Collection {
                id: Uuid::new_v4().to_string(),
                name: "API".into(),
                variables: vec![],
                folders: vec![],
                requests: vec![],
                source: Some(serde_json::json!({"path": "/private/project/openapi.ts"})),
            }],
            environments: vec![Environment {
                id: Uuid::new_v4().to_string(),
                name: "Local".into(),
                variables: vec![Variable {
                    id: Uuid::new_v4().to_string(),
                    name: "PASSWORD".into(),
                    value: "private".into(),
                    secret: true,
                }],
            }],
            active_environment_id: None,
        };
        validate(&store).unwrap();
        scrub_secrets(&mut store);
        let imported: Store = serde_json::from_slice(&serde_json::to_vec(&store).unwrap()).unwrap();
        assert_eq!(imported.collections[0].name, "API");
        assert_eq!(imported.environments[0].variables[0].value, "");
        assert!(imported.collections[0].source.is_none());
    }

    #[test]
    fn portable_round_trip_preserves_scripts_and_disables_execution_on_import() {
        let mut store = Store::default();
        let mut request = crate::model::ApiRequest {
            id: Uuid::new_v4().to_string(),
            name: "Login".into(),
            method: "POST".into(),
            url: "{{BASE_URL}}/login/:id".into(),
            folder_id: None,
            query: vec![],
            path_params: vec![crate::model::Entry {
                id: Uuid::new_v4().to_string(),
                key: "id".into(),
                value: "{{USER_ID}}".into(),
                enabled: true,
            }],
            headers: vec![],
            auth: Default::default(),
            body: Default::default(),
            pre_script: "_.READY = 'yes';".into(),
            post_script: "_.TOKEN = response.json().token;".into(),
            trusted: true,
            timeout_ms: None,
            source_key: None,
        };
        request.headers.push(crate::model::Entry {
            id: Uuid::new_v4().to_string(),
            key: "Authorization".into(),
            value: "Bearer {{_.TOKEN}}".into(),
            enabled: true,
        });
        store.collections.push(Collection {
            id: Uuid::new_v4().to_string(),
            name: "Example".into(),
            variables: vec![],
            folders: vec![],
            requests: vec![request],
            source: None,
        });
        scrub_secrets(&mut store);
        let bytes = serde_json::to_vec(&store).unwrap();
        let mut imported: Store = serde_json::from_slice(&bytes).unwrap();
        validate(&imported).unwrap();
        imported.collections[0].requests[0].trusted = false;
        let restored = &imported.collections[0].requests[0];
        assert_eq!(restored.post_script, "_.TOKEN = response.json().token;");
        assert_eq!(restored.headers[0].value, "Bearer {{_.TOKEN}}");
        assert_eq!(restored.path_params[0].value, "{{USER_ID}}");
        assert!(!restored.trusted);
    }
}
