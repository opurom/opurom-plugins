#[path = "../../../rust/json.rs"]
mod json;

use json::Json;
use std::io::{self, BufRead, Write};

const NAME: &str = "notification";
const VERSION: &str = "0.1.0";
const CAPABILITIES: &[&str] = &["notification.show"];

fn main() {
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
        let (response, shutdown) = handle(&line);
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
fn handle(line: &str) -> (Json, bool) {
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
            json::ok(id, json::hello(NAME, VERSION, CAPABILITIES)),
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

fn invoke(capability: &str, params: &Json) -> Result<Json, String> {
    match capability {
        "notification.show" => {
            let title = params.get("title").and_then(Json::as_str).unwrap_or("");
            let message = params.get("message").and_then(Json::as_str).unwrap_or("");
            Ok(Json::object(vec![
                ("shown", Json::Bool(true)),
                ("title", Json::string(title)),
                ("message", Json::string(message)),
            ]))
        }
        other => Err(format!("unknown capability: {other}")),
    }
}
