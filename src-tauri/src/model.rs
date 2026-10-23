use serde::{Deserialize, Serialize};
use std::collections::HashMap;

pub const FORMAT_VERSION: u32 = 1;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Variable {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub value: String,
    #[serde(default)]
    pub secret: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub id: String,
    pub key: String,
    #[serde(default)]
    pub value: String,
    #[serde(default = "enabled")]
    pub enabled: bool,
}

fn enabled() -> bool {
    true
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Auth {
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub password: String,
    #[serde(default)]
    pub token: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Body {
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub fields: Vec<Entry>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SocketSettings {
    #[serde(default = "socket_path")]
    pub path: String,
    #[serde(default = "socket_namespace")]
    pub namespace: String,
    #[serde(default)]
    pub auth: String,
    #[serde(default)]
    pub event: String,
    #[serde(default)]
    pub payload: String,
    #[serde(default)]
    pub format: String,
    #[serde(default)]
    pub examples: Vec<SocketMessageExample>,
    #[serde(default)]
    pub auto_senders: Vec<SocketAutoSender>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SocketAutoSender {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub interval_seconds: u32,
    pub event: String,
    pub payload: String,
    pub format: String,
}

impl SocketAutoSender {
    pub fn validate(&self, is_io: bool) -> Result<(), String> {
        if self.interval_seconds == 0 || self.interval_seconds > 2_147_483_647 {
            return Err("Auto sender interval must be a positive whole number of seconds (at most 2147483647)".into());
        }
        if self.name.trim().is_empty() {
            return Err("Enter an auto sender name".into());
        }
        if is_io && self.event.trim().is_empty() {
            return Err("Enter a Socket.IO event name".into());
        }
        if !matches!(self.format.as_str(), "json" | "text") {
            return Err("Auto sender format must be JSON or text".into());
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SocketMessageExample {
    pub id: String,
    pub name: String,
    pub event: String,
    pub payload: String,
    pub format: String,
}

fn socket_path() -> String {
    "/socket.io/".into()
}
fn socket_namespace() -> String {
    "/".into()
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiRequest {
    pub id: String,
    pub name: String,
    pub method: String,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub socket: Option<SocketSettings>,
    pub url: String,
    #[serde(default)]
    pub folder_id: Option<String>,
    #[serde(default)]
    pub query: Vec<Entry>,
    #[serde(default)]
    pub path_params: Vec<Entry>,
    #[serde(default)]
    pub headers: Vec<Entry>,
    #[serde(default)]
    pub auth: Auth,
    #[serde(default)]
    pub body: Body,
    #[serde(default)]
    pub pre_script: String,
    #[serde(default)]
    pub post_script: String,
    #[serde(default = "enabled")]
    pub trusted: bool,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_key: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Folder {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub parent_id: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Collection {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub variables: Vec<Variable>,
    #[serde(default)]
    pub folders: Vec<Folder>,
    #[serde(default)]
    pub requests: Vec<ApiRequest>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<serde_json::Value>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Environment {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub variables: Vec<Variable>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Store {
    pub version: u32,
    #[serde(default)]
    pub defaults: Vec<Variable>,
    #[serde(default)]
    pub collections: Vec<Collection>,
    #[serde(default)]
    pub environments: Vec<Environment>,
    #[serde(default)]
    pub active_environment_id: Option<String>,
}

impl Default for Store {
    fn default() -> Self {
        Self {
            version: FORMAT_VERSION,
            defaults: vec![],
            collections: vec![],
            environments: vec![],
            active_environment_id: None,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub id: String,
    pub name: String,
    pub store: Store,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceData {
    pub version: u32,
    pub active_workspace_id: String,
    pub workspaces: Vec<Workspace>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunInput {
    pub request: ApiRequest,
    #[serde(default)]
    pub defaults: Vec<Variable>,
    #[serde(default)]
    pub collection_variables: Vec<Variable>,
    #[serde(default)]
    pub environment_variables: Vec<Variable>,
    #[serde(default)]
    pub runtime_variables: HashMap<String, String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunResult {
    pub url: String,
    pub status: u16,
    pub status_text: String,
    pub headers: Vec<(String, String)>,
    pub body: String,
    pub binary: bool,
    pub size: usize,
    pub elapsed_ms: u128,
    pub runtime_variables: HashMap<String, String>,
}
