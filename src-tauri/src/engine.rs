use crate::model::{Entry, RunInput, RunResult, Variable};
use crate::script::{run_script, ScriptResponse};
use base64::Engine;
use reqwest::{
    header::{HeaderMap, HeaderName, HeaderValue},
    Client, Method, Url,
};
use std::{
    collections::HashMap,
    time::{Duration, Instant},
};

fn apply_scope(target: &mut HashMap<String, String>, variables: &[Variable]) {
    for item in variables {
        if !item.name.trim().is_empty() {
            target.insert(item.name.clone(), item.value.clone());
        }
    }
}

fn interpolate(
    input: &str,
    variables: &HashMap<String, String>,
    runtime: &HashMap<String, String>,
) -> Result<String, String> {
    let mut output = String::new();
    let mut rest = input;
    while let Some(start) = rest.find("{{") {
        output.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        let end = after.find("}}").ok_or("Unclosed variable reference")?;
        let key = after[..end].trim();
        let value = if let Some(runtime_key) = key.strip_prefix("_.") {
            runtime.get(runtime_key)
        } else {
            variables.get(key)
        };
        output.push_str(value.ok_or_else(|| format!("Unresolved variable: {{{{{key}}}}}"))?);
        rest = &after[end + 2..];
    }
    output.push_str(rest);
    Ok(output)
}

fn resolve_entries(
    entries: &[Entry],
    vars: &HashMap<String, String>,
    runtime: &HashMap<String, String>,
) -> Result<Vec<(String, String)>, String> {
    entries
        .iter()
        .filter(|entry| entry.enabled && !entry.key.trim().is_empty())
        .map(|entry| {
            Ok((
                interpolate(&entry.key, vars, runtime)?,
                interpolate(&entry.value, vars, runtime)?,
            ))
        })
        .collect()
}

fn changed_runtime(
    previous: &HashMap<String, String>,
    updated: &HashMap<String, String>,
    runtime: &mut HashMap<String, String>,
) {
    for (key, value) in updated {
        if previous.get(key) != Some(value) {
            runtime.insert(key.clone(), value.clone());
        }
    }
}

pub async fn execute(input: RunInput) -> Result<RunResult, String> {
    let mut variables = HashMap::new();
    apply_scope(&mut variables, &input.defaults);
    apply_scope(&mut variables, &input.collection_variables);
    apply_scope(&mut variables, &input.environment_variables);
    variables.extend(input.runtime_variables.clone());
    let mut runtime = input.runtime_variables;
    let mut request = input.request;

    if !request.trusted
        && (!request.pre_script.trim().is_empty() || !request.post_script.trim().is_empty())
    {
        return Err(
            "Scripts are disabled for this imported request. Review and trust it before sending."
                .into(),
        );
    }
    if !request.pre_script.trim().is_empty() {
        let output = run_script(&request.pre_script, &variables, &request, None)?;
        changed_runtime(&variables, &output.variables, &mut runtime);
        variables = output.variables;
        request = output.request;
    }
    let url_text = interpolate(&request.url, &variables, &runtime)?;
    let mut url = Url::parse(&url_text).map_err(|e| format!("Invalid URL: {e}"))?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err("Only HTTP and HTTPS URLs are supported".into());
    }
    let query = resolve_entries(&request.query, &variables, &runtime)?;
    if !query.is_empty() {
        url.query_pairs_mut().extend_pairs(query);
    }
    let method = Method::from_bytes(request.method.as_bytes())
        .map_err(|e| format!("Invalid HTTP method: {e}"))?;
    let timeout = request.timeout_ms.unwrap_or(30_000).clamp(100, 300_000);
    let client = Client::builder()
        .timeout(Duration::from_millis(timeout))
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .map_err(|e| e.to_string())?;
    let mut headers = HeaderMap::new();
    for (key, value) in resolve_entries(&request.headers, &variables, &runtime)? {
        let name = HeaderName::from_bytes(key.as_bytes())
            .map_err(|e| format!("Invalid header name: {e}"))?;
        let value =
            HeaderValue::from_str(&value).map_err(|e| format!("Invalid header value: {e}"))?;
        headers.append(name, value);
    }
    let mut builder = client.request(method, url).headers(headers);
    match request.auth.kind.as_str() {
        "basic" => {
            builder = builder.basic_auth(
                interpolate(&request.auth.username, &variables, &runtime)?,
                Some(interpolate(&request.auth.password, &variables, &runtime)?),
            )
        }
        "bearer" => {
            builder = builder.bearer_auth(interpolate(&request.auth.token, &variables, &runtime)?)
        }
        _ => {}
    }
    match request.body.kind.as_str() {
        "json" => {
            let body = interpolate(&request.body.text, &variables, &runtime)?;
            serde_json::from_str::<serde_json::Value>(&body)
                .map_err(|e| format!("Invalid JSON body: {e}"))?;
            builder = builder
                .header("content-type", "application/json")
                .body(body);
        }
        "text" => builder = builder.body(interpolate(&request.body.text, &variables, &runtime)?),
        "form" => {
            builder = builder.form(&resolve_entries(
                &request.body.fields,
                &variables,
                &runtime,
            )?)
        }
        "multipart" => {
            let mut form = reqwest::multipart::Form::new();
            for (key, value) in resolve_entries(&request.body.fields, &variables, &runtime)? {
                form = form.text(key, value);
            }
            builder = builder.multipart(form);
        }
        _ => {}
    }
    let started = Instant::now();
    let response = builder
        .send()
        .await
        .map_err(|e| format!("Request failed: {e}"))?;
    let status = response.status();
    let status_text = status.canonical_reason().unwrap_or("").to_string();
    let response_headers: Vec<(String, String)> = response
        .headers()
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_str().unwrap_or("<binary>").to_string()))
        .collect();
    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("Could not read response: {e}"))?;
    let elapsed_ms = started.elapsed().as_millis();
    let size = bytes.len();
    let (body, binary) = match String::from_utf8(bytes.to_vec()) {
        Ok(text) => (text, false),
        Err(_) => (
            base64::engine::general_purpose::STANDARD.encode(&bytes),
            true,
        ),
    };
    if !request.post_script.trim().is_empty() {
        if binary {
            return Err("Post-response scripts cannot read binary responses".into());
        }
        let script_response = ScriptResponse {
            status: status.as_u16(),
            headers: &response_headers,
            body: &body,
        };
        let output = run_script(
            &request.post_script,
            &variables,
            &request,
            Some(&script_response),
        )?;
        changed_runtime(&variables, &output.variables, &mut runtime);
    }
    Ok(RunResult {
        status: status.as_u16(),
        status_text,
        headers: response_headers,
        body,
        binary,
        size,
        elapsed_ms,
        runtime_variables: runtime,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{ApiRequest, Auth, Body};
    use std::io::{Read, Write};
    use std::net::TcpListener;

    #[test]
    fn precedence_and_runtime_reference() {
        let mut variables = HashMap::new();
        apply_scope(
            &mut variables,
            &[Variable {
                id: "1".into(),
                name: "TOKEN".into(),
                value: "default".into(),
                secret: false,
            }],
        );
        apply_scope(
            &mut variables,
            &[Variable {
                id: "2".into(),
                name: "TOKEN".into(),
                value: "environment".into(),
                secret: false,
            }],
        );
        assert_eq!(
            interpolate("{{TOKEN}}", &variables, &HashMap::new()).unwrap(),
            "environment"
        );
        assert!(interpolate("{{_.TOKEN}}", &variables, &HashMap::new()).is_err());
        let runtime = HashMap::from([("TOKEN".into(), "fresh".into())]);
        assert_eq!(
            interpolate("Bearer {{_.TOKEN}}", &variables, &runtime).unwrap(),
            "Bearer fresh"
        );
    }

    #[test]
    fn login_script_updates_token_used_by_next_http_request() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            for index in 0..2 {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(3)))
                    .unwrap();
                let mut buffer = [0_u8; 4096];
                let read = stream.read(&mut buffer).unwrap();
                let text = String::from_utf8_lossy(&buffer[..read]);
                if index == 0 {
                    assert!(text.starts_with("POST /login"));
                    let body = r#"{"token":"fresh-token"}"#;
                    write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).unwrap();
                } else {
                    assert!(text.starts_with("GET /protected"));
                    assert!(text
                        .to_lowercase()
                        .contains("authorization: bearer fresh-token"));
                    let body = r#"{"authorized":true}"#;
                    write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).unwrap();
                }
            }
        });
        let make = |name: &str, method: &str, path: &str| ApiRequest {
            id: uuid::Uuid::new_v4().to_string(),
            name: name.into(),
            method: method.into(),
            url: format!("http://127.0.0.1:{port}{path}"),
            folder_id: None,
            query: vec![],
            headers: vec![],
            auth: Auth::default(),
            body: Body::default(),
            pre_script: String::new(),
            post_script: String::new(),
            trusted: true,
            timeout_ms: Some(3000),
        };
        let mut login = make("Login", "POST", "/login");
        login.post_script = "_.TOKEN = response.json().token;".into();
        let first = tauri::async_runtime::block_on(execute(RunInput {
            request: login,
            defaults: vec![],
            collection_variables: vec![],
            environment_variables: vec![],
            runtime_variables: HashMap::new(),
        }))
        .unwrap();
        assert_eq!(first.runtime_variables["TOKEN"], "fresh-token");
        let mut protected = make("Protected", "GET", "/protected");
        protected.headers.push(Entry {
            id: uuid::Uuid::new_v4().to_string(),
            key: "Authorization".into(),
            value: "Bearer {{_.TOKEN}}".into(),
            enabled: true,
        });
        let second = tauri::async_runtime::block_on(execute(RunInput {
            request: protected,
            defaults: vec![],
            collection_variables: vec![],
            environment_variables: vec![],
            runtime_variables: first.runtime_variables,
        }))
        .unwrap();
        assert_eq!(second.status, 200);
        assert_eq!(second.body, r#"{"authorized":true}"#);
        server.join().unwrap();
    }
}
