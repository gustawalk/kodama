use crate::model::ApiRequest;
use boa_engine::{Context, Source};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

const MAX_SCRIPT_BYTES: usize = 64 * 1024;
const MAX_RESPONSE_BYTES: usize = 1024 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptResponse<'a> {
    pub status: u16,
    pub headers: &'a [(String, String)],
    pub body: &'a str,
}

#[derive(Deserialize)]
pub struct ScriptOutput {
    pub variables: HashMap<String, String>,
    pub request: ApiRequest,
}

pub fn run_script(
    source: &str,
    variables: &HashMap<String, String>,
    request: &ApiRequest,
    response: Option<&ScriptResponse<'_>>,
) -> Result<ScriptOutput, String> {
    if source.len() > MAX_SCRIPT_BYTES {
        return Err("Script exceeds 64 KiB".into());
    }
    let response_json = match response {
        Some(r) => {
            if r.body.len() > MAX_RESPONSE_BYTES {
                return Err("Response is too large for a script (1 MiB limit)".into());
            }
            serde_json::to_string(r).map_err(|e| e.to_string())?
        }
        None => "null".into(),
    };
    let variables_json = serde_json::to_string(variables).map_err(|e| e.to_string())?;
    let request_json = serde_json::to_string(request).map_err(|e| e.to_string())?;
    let program = format!(
        "(() => {{\nconst _ = {variables_json};\nlet request = {request_json};\nconst rawResponse = {response_json};\nconst response = rawResponse && {{ status: rawResponse.status, headers: rawResponse.headers, header: (name) => rawResponse.headers.find(([key]) => key.toLowerCase() === String(name).toLowerCase())?.[1] ?? null, text: () => rawResponse.body, json: () => JSON.parse(rawResponse.body) }};\n{source}\nreturn JSON.stringify({{ variables: _, request }});\n}})()"
    );
    let mut context = Context::default();
    context
        .runtime_limits_mut()
        .set_loop_iteration_limit(100_000);
    context.runtime_limits_mut().set_recursion_limit(128);
    context.runtime_limits_mut().set_stack_size_limit(1024);
    let result = context
        .eval(Source::from_bytes(&program))
        .map_err(|e| format!("Script error: {e}"))?;
    let json = result
        .to_string(&mut context)
        .map_err(|e| format!("Script result error: {e}"))?
        .to_std_string_escaped();
    let output: ScriptOutput =
        serde_json::from_str(&json).map_err(|e| format!("Script returned invalid data: {e}"))?;
    if output
        .variables
        .iter()
        .any(|(k, v)| k.len() > 128 || v.len() > 64 * 1024)
    {
        return Err("Script variable name or value exceeds the size limit".into());
    }
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Auth, Body};

    fn request() -> ApiRequest {
        ApiRequest {
            id: "id".into(),
            name: "Login".into(),
            method: "POST".into(),
            url: "https://example.test".into(),
            folder_id: None,
            query: vec![],
            path_params: vec![],
            headers: vec![],
            auth: Auth::default(),
            body: Body::default(),
            pre_script: String::new(),
            post_script: String::new(),
            trusted: true,
            timeout_ms: None,
        }
    }

    #[test]
    fn token_overwrites_only_on_success() {
        let mut vars = HashMap::new();
        vars.insert("TOKEN".into(), "old".into());
        let response = ScriptResponse {
            status: 200,
            headers: &[],
            body: r#"{"token":"new"}"#,
        };
        let output = run_script(
            "_.TOKEN = response.json().token",
            &vars,
            &request(),
            Some(&response),
        )
        .unwrap();
        assert_eq!(output.variables["TOKEN"], "new");
        assert!(run_script(
            "_.TOKEN = 'bad'; throw Error('no')",
            &vars,
            &request(),
            Some(&response)
        )
        .is_err());
        assert_eq!(vars["TOKEN"], "old");
    }

    #[test]
    fn loop_is_limited() {
        assert!(run_script("while (true) {}", &HashMap::new(), &request(), None).is_err());
    }

    #[test]
    fn response_header_lookup_is_case_insensitive() {
        let headers = [("X-Session-Token".into(), "abc123".into())];
        let response = ScriptResponse {
            status: 200,
            headers: &headers,
            body: "{}",
        };
        let output = run_script(
            "_.TOKEN = response.header('x-session-token')",
            &HashMap::new(),
            &request(),
            Some(&response),
        )
        .unwrap();
        assert_eq!(output.variables["TOKEN"], "abc123");
    }
}
