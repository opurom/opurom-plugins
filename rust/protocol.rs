//! Shared request loop for the deterministic mock-device plugins.
//! The wire format and error handling match the three original R2 plugins.
#[path = "json.rs"]
mod json;

pub use json::Json;
use std::io::{self, BufRead, Write};

type Invoker = fn(&str, &Json) -> Result<Json, String>;

pub fn run(name: &str, version: &str, capabilities: &[&str], invoke: Invoker) {
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut out = stdout.lock();
    for line in stdin.lock().lines() {
        let line = match line {
            Ok(line) => line,
            Err(err) => {
                eprintln!("stdin error: {err}");
                break;
            }
        };
        if line.trim().is_empty() {
            continue;
        }
        let (response, shutdown) = handle(&line, name, version, capabilities, invoke);
        let mut text = String::new();
        response.encode(&mut text);
        if writeln!(out, "{text}").is_err() || out.flush().is_err() {
            eprintln!("stdout error");
            break;
        }
        if shutdown {
            break;
        }
    }
}

/// One request line in, one response line out. Nothing but JSON reaches stdout.
fn handle(
    line: &str,
    name: &str,
    version: &str,
    capabilities: &[&str],
    invoke: Invoker,
) -> (Json, bool) {
    let request = match json::parse(line) {
        Ok(value) => value,
        Err(err) => {
            eprintln!("malformed JSON: {err}");
            let detail = format!("malformed JSON: {err}");
            return (json::error(json::salvage_id(line), &detail), false);
        }
    };
    if !matches!(&request, Json::Obj(_)) {
        return (
            json::error(Json::Null, "request must be a JSON object"),
            false,
        );
    }
    let id = request.get("id").cloned().unwrap_or(Json::Null);
    let method = request.get("method").and_then(Json::as_str).unwrap_or("");
    match method {
        "hello" => (
            json::ok(id, json::hello(name, version, capabilities)),
            false,
        ),
        "invoke" => {
            let capability = request
                .get("capability")
                .and_then(Json::as_str)
                .unwrap_or("");
            let params = request
                .get("params")
                .cloned()
                .unwrap_or_else(|| Json::Obj(Vec::new()));
            let response = match invoke(capability, &params) {
                Ok(result) => json::ok(id, result),
                Err(err) => json::error(id, &err),
            };
            (response, false)
        }
        "shutdown" => (json::ok(id, Json::Null), true),
        other => (json::error(id, &format!("unknown method: {other}")), false),
    }
}
