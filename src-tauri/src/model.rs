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
pub struct ApiRequest {
    pub id: String,
    pub name: String,
    pub method: String,
    pub url: String,
    #[serde(default)]
    pub folder_id: Option<String>,
    #[serde(default)]
    pub query: Vec<Entry>,
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
    pub status: u16,
    pub status_text: String,
    pub headers: Vec<(String, String)>,
    pub body: String,
    pub binary: bool,
    pub size: usize,
    pub elapsed_ms: u128,
    pub runtime_variables: HashMap<String, String>,
}
