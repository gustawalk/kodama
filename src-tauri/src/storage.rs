use crate::model::{Store, FORMAT_VERSION};
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::{
    collections::HashSet,
    fs,
    fs::OpenOptions,
    io::Write,
    path::{Path, PathBuf},
};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;
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

fn scrub_secrets(store: &mut Store) {
    for variable in &mut store.defaults {
        if variable.secret {
            variable.value.clear();
        }
    }
    for collection in &mut store.collections {
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

#[tauri::command]
pub fn load_store(app: AppHandle) -> Result<Store, String> {
    let path = data_path(&app)?;
    if !path.exists() {
        return Ok(Store::default());
    }
    let data = fs::read(&path).map_err(|e| e.to_string())?;
    let store: Store =
        serde_json::from_slice(&data).map_err(|e| format!("Saved data is invalid: {e}"))?;
    validate(&store)?;
    Ok(store)
}

#[tauri::command]
pub fn save_store(app: AppHandle, store: Store) -> Result<(), String> {
    validate(&store)?;
    let path = data_path(&app)?;
    write_local_store(&path, &store)
}

fn write_local_store(path: &Path, store: &Store) -> Result<(), String> {
    let temp = path.with_extension("json.tmp");
    let data = serde_json::to_vec_pretty(&store).map_err(|e| e.to_string())?;
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

#[tauri::command]
pub fn import_store(app: AppHandle) -> Result<Option<Store>, String> {
    let Some(path) = app
        .dialog()
        .file()
        .add_filter("Kodama JSON", &["json"])
        .blocking_pick_file()
    else {
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
pub fn export_store(app: AppHandle, mut store: Store) -> Result<bool, String> {
    validate(&store)?;
    scrub_secrets(&mut store);
    for collection in &mut store.collections {
        for request in &mut collection.requests {
            request.trusted = false;
        }
    }
    let Some(path) = app
        .dialog()
        .file()
        .add_filter("Kodama JSON", &["json"])
        .set_file_name("kodama-export.json")
        .blocking_save_file()
    else {
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
    }

    #[test]
    fn portable_round_trip_preserves_scripts_and_disables_execution_on_import() {
        let mut store = Store::default();
        let mut request = crate::model::ApiRequest {
            id: Uuid::new_v4().to_string(),
            name: "Login".into(),
            method: "POST".into(),
            url: "{{BASE_URL}}/login".into(),
            folder_id: None,
            query: vec![],
            headers: vec![],
            auth: Default::default(),
            body: Default::default(),
            pre_script: "_.READY = 'yes';".into(),
            post_script: "_.TOKEN = response.json().token;".into(),
            trusted: true,
            timeout_ms: None,
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
        });
        scrub_secrets(&mut store);
        let bytes = serde_json::to_vec(&store).unwrap();
        let mut imported: Store = serde_json::from_slice(&bytes).unwrap();
        validate(&imported).unwrap();
        imported.collections[0].requests[0].trusted = false;
        let restored = &imported.collections[0].requests[0];
        assert_eq!(restored.post_script, "_.TOKEN = response.json().token;");
        assert_eq!(restored.headers[0].value, "Bearer {{_.TOKEN}}");
        assert!(!restored.trusted);
    }
}
