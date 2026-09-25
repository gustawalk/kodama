use crate::model::{Entry, RunInput, RunResult, Variable};
use crate::script::{run_script, ScriptResponse};
use base64::Engine;
use reqwest::{
    cookie::Jar,
    header::{HeaderMap, HeaderName, HeaderValue},
    Client, Method, Url,
};
use std::{
    collections::HashMap,
    error::Error,
    sync::Arc,
    time::{Duration, Instant},
};
use uuid::Uuid;

fn random_value(name: &str) -> Result<String, String> {
    let id = Uuid::new_v4();
    let bytes = id.as_bytes();
    const FIRST: [&str; 8] = [
        "Alex", "Sam", "Jordan", "Taylor", "Morgan", "Casey", "Robin", "Jamie",
    ];
    const LAST: [&str; 8] = [
        "Lee", "Patel", "Silva", "Kim", "Garcia", "Brown", "Nguyen", "Costa",
    ];
    let first = FIRST[bytes[0] as usize % FIRST.len()];
    let last = LAST[bytes[1] as usize % LAST.len()];
    Ok(match name {
        "uuid" => id.to_string(),
        "firstName" => first.into(),
        "lastName" => last.into(),
        "fullName" => format!("{first} {last}"),
        "email" => format!(
            "{}.{}{}@example.test",
            first.to_lowercase(),
            last.to_lowercase(),
            bytes[2]
        ),
        "username" => format!("{}{}", first.to_lowercase(), bytes[2]),
        "integer" => u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]).to_string(),
        "boolean" => (bytes[0] % 2 == 0).to_string(),
        _ => return Err(format!("Unknown random generator: {name}")),
    })
}

fn resolve_path_params(
    url: &str,
    entries: &[Entry],
    variables: &HashMap<String, String>,
    runtime: &HashMap<String, String>,
) -> Result<String, String> {
    let mut result = String::new();
    let mut parts = url.splitn(2, "//");
    let scheme = parts.next().unwrap_or("");
    let rest = parts.next().ok_or("Invalid URL")?;
    let path_start = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    result.push_str(scheme);
    result.push_str("//");
    result.push_str(&rest[..path_start]);
    let suffix = &rest[path_start..];
    let (path, tail) = suffix
        .find(['?', '#'])
        .map(|index| (&suffix[..index], &suffix[index..]))
        .unwrap_or((suffix, ""));
    for (index, segment) in path.split('/').enumerate() {
        if index > 0 {
            result.push('/');
        }
        if let Some(name) = segment.strip_prefix(':').filter(|name| {
            !name.is_empty()
                && name
                    .chars()
                    .all(|ch| ch.is_ascii_alphanumeric() || ch == '_')
        }) {
            let row = entries
                .iter()
                .find(|row| row.enabled && row.key == name)
                .ok_or_else(|| format!("Missing path parameter: {name}"))?;
            let value = interpolate(&row.value, variables, runtime)?;
            if value.is_empty() {
                return Err(format!("Path parameter {name} needs a value"));
            }
            let mut encoder = Url::parse("https://kodama.invalid/").map_err(|e| e.to_string())?;
            encoder
                .path_segments_mut()
                .map_err(|_| "Could not encode path parameter")?
                .push(&value);
            result.push_str(encoder.path().trim_start_matches('/'));
        } else {
            result.push_str(segment);
        }
    }
    result.push_str(tail);
    Ok(result)
}

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
        if let Some(generator) = key
            .strip_prefix("$random.")
            .or_else(|| key.strip_prefix("random."))
        {
            output.push_str(&random_value(generator)?);
        } else {
            let value = if let Some(runtime_key) = key.strip_prefix("_.") {
                runtime.get(runtime_key)
            } else {
                variables.get(key)
            };
            output.push_str(value.ok_or_else(|| format!("Unresolved variable: {{{{{key}}}}}"))?);
        }
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

fn append_query_pairs(url: &mut Url, query: Vec<(String, String)>) -> Result<(), String> {
    if query.is_empty() {
        return Ok(());
    }
    let mut encoded_url = Url::parse("https://kodama.invalid/").map_err(|e| e.to_string())?;
    encoded_url.query_pairs_mut().extend_pairs(query);
    let encoded = encoded_url.query().unwrap_or("").replace('+', "%20");
    let existing = url.query().unwrap_or("");
    let separator = if existing.is_empty() || existing.ends_with('&') {
        ""
    } else {
        "&"
    };
    let combined = format!("{existing}{separator}{encoded}");
    url.set_query(Some(&combined));
    Ok(())
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

#[cfg(test)]
pub async fn execute(input: RunInput) -> Result<RunResult, String> {
    execute_with_jar(input, Arc::new(Jar::default())).await
}

pub async fn execute_with_jar(input: RunInput, jar: Arc<Jar>) -> Result<RunResult, String> {
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
    let url_text = resolve_path_params(
        &interpolate(&request.url, &variables, &runtime)?,
        &request.path_params,
        &variables,
        &runtime,
    )?;
    let mut url = Url::parse(&url_text).map_err(|e| format!("Invalid URL: {e}"))?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err("Only HTTP and HTTPS URLs are supported".into());
    }
    let query = resolve_entries(&request.query, &variables, &runtime)?;
    append_query_pairs(&mut url, query)?;
    let method = Method::from_bytes(request.method.as_bytes())
        .map_err(|e| format!("Invalid HTTP method: {e}"))?;
    let timeout = request.timeout_ms.unwrap_or(30_000).clamp(100, 300_000);
    let client = Client::builder()
        .cookie_provider(jar)
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
            if !body.trim().is_empty() {
                serde_json::from_str::<serde_json::Value>(&body)
                    .map_err(|e| format!("Invalid JSON body: {e}"))?;
                builder = builder
                    .header("content-type", "application/json")
                    .body(body);
            }
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
        .map_err(|e| {
            let kind = if e.is_timeout() { "Request timed out" }
                else if e.is_connect() { "Could not connect to server" }
                else if e.is_redirect() { "Redirect failed" }
                else if e.is_request() { "Invalid request" }
                else if e.is_body() { "Could not send request body" }
                else { "Request failed" };
            let mut causes = Vec::new();
            let mut source = e.source();
            while let Some(cause) = source {
                causes.push(cause.to_string());
                source = cause.source();
            }
            format!("{kind}\nURL: {url_text}\nDetails: {e}{}", if causes.is_empty() { String::new() } else { format!("\nCause: {}", causes.join(" → ")) })
        })?;
    let status = response.status();
    let response_url = response.url().to_string();
    let status_text = status.canonical_reason().unwrap_or("").to_string();
    let response_headers: Vec<(String, String)> = response
        .headers()
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_str().unwrap_or("<binary>").to_string()))
        .collect();
    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("Could not read response\nURL: {response_url}\nDetails: {e}"))?;
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
        url: response_url,
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
    fn path_parameters_are_encoded_and_random_templates_resolve() {
        let row = Entry {
            id: "id".into(),
            key: "id".into(),
            value: "a/b c".into(),
            enabled: true,
        };
        let url = resolve_path_params(
            "https://example.test/items/:id?expand=true",
            &[row],
            &HashMap::new(),
            &HashMap::new(),
        )
        .unwrap();
        assert_eq!(url, "https://example.test/items/a%2Fb%20c?expand=true");
        assert!(resolve_path_params(
            "https://example.test/items/:missing",
            &[],
            &HashMap::new(),
            &HashMap::new()
        )
        .is_err());
        let generated = interpolate("{{$random.uuid}}", &HashMap::new(), &HashMap::new()).unwrap();
        assert!(Uuid::parse_str(&generated).is_ok());
        let generated_alias =
            interpolate("{{random.uuid}}", &HashMap::new(), &HashMap::new()).unwrap();
        assert!(Uuid::parse_str(&generated_alias).is_ok());
        assert!(interpolate("{{$random.unknown}}", &HashMap::new(), &HashMap::new()).is_err());
        assert!(interpolate("{{random.unknown}}", &HashMap::new(), &HashMap::new()).is_err());
    }

    #[test]
    fn query_spaces_use_percent_20_without_changing_existing_query() {
        let mut url = Url::parse("https://example.test/search?existing=a+b").unwrap();
        append_query_pairs(&mut url, vec![("q".into(), "full+ query".into())]).unwrap();
        assert_eq!(
            url.as_str(),
            "https://example.test/search?existing=a+b&q=full%2B%20query"
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
            path_params: vec![],
            headers: vec![],
            auth: Auth::default(),
            body: Body::default(),
            pre_script: String::new(),
            post_script: String::new(),
            trusted: true,
            timeout_ms: Some(3000),
            source_key: None,
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

    #[test]
    fn shared_cookie_jar_sends_login_cookie_on_next_request() {
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
                    write!(stream, "HTTP/1.1 200 OK\r\nSet-Cookie: session=abc; Path=/; HttpOnly\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();
                } else {
                    assert!(text.to_ascii_lowercase().contains("cookie: session=abc"));
                    write!(
                        stream,
                        "HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                    )
                    .unwrap();
                }
            }
        });
        let jar = Arc::new(Jar::default());
        for path in ["login", "protected"] {
            let request = ApiRequest {
                id: uuid::Uuid::new_v4().to_string(),
                name: path.into(),
                method: "GET".into(),
                url: format!("http://127.0.0.1:{port}/{path}"),
                folder_id: None,
                query: vec![],
                path_params: vec![],
                headers: vec![],
                auth: Auth::default(),
                body: Body::default(),
                pre_script: String::new(),
                post_script: String::new(),
                trusted: true,
                timeout_ms: Some(3000),
                source_key: None,
            };
            tauri::async_runtime::block_on(execute_with_jar(
                RunInput {
                    request,
                    defaults: vec![],
                    collection_variables: vec![],
                    environment_variables: vec![],
                    runtime_variables: HashMap::new(),
                },
                jar.clone(),
            ))
            .unwrap();
        }
        server.join().unwrap();
    }
}
