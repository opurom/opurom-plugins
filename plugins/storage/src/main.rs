#[path = "../../../rust/json.rs"]
mod json;

use json::Json;
use std::fs;
use std::io::{self, BufRead, Write};
use std::path::PathBuf;

const NAME: &str = "storage";
const VERSION: &str = "0.1.0";
const CAPABILITIES: &[&str] = &["storage.put", "storage.get"];
const DEFAULT_KEY: &str = "default";

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

/// The executable lives in <plugin>/bin, so its grandparent is the plugin directory.
fn state_path() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|err| format!("cannot locate plugin dir: {err}"))?;
    let dir = exe
        .parent()
        .and_then(|bin| bin.parent())
        .ok_or("cannot locate plugin dir")?;
    Ok(dir.join("tmp").join("state.json"))
}

fn load(path: &PathBuf) -> Vec<(String, Json)> {
    let text = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(_) => return Vec::new(),
    };
    match json::parse(&text) {
        Ok(Json::Obj(fields)) => fields,
        Ok(other) => {
            eprintln!("ignoring invalid state shape: {}", other.to_text());
            Vec::new()
        }
        Err(err) => {
            eprintln!("ignoring corrupt state file: {err}");
            Vec::new()
        }
    }
}

fn save(path: &PathBuf, fields: &[(String, Json)]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| format!("cannot create state dir: {err}"))?;
    }
    // shortcut: whole-file rewrite without locking, upgrade when multiple hosts write concurrently.
    let text = Json::Obj(fields.to_vec()).to_text();
    fs::write(path, format!("{text}\n")).map_err(|err| format!("cannot write state: {err}"))
}

fn invoke(capability: &str, params: &Json) -> Result<Json, String> {
    if !matches!(capability, "storage.put" | "storage.get") {
        return Err(format!("unknown capability: {capability}"));
    }
    // shortcut: an absent key means the default key, upgrade when keys become mandatory.
    let key = params
        .get("key")
        .and_then(Json::as_str)
        .unwrap_or(DEFAULT_KEY);
    let path = state_path()?;
    let mut fields = load(&path);
    match capability {
        "storage.put" => {
            let value = params.get("value").cloned().unwrap_or(Json::Null);
            if let Some((_, existing)) = fields.iter_mut().find(|(name, _)| name.as_str() == key) {
                *existing = value.clone();
            } else {
                fields.push((key.to_owned(), value.clone()));
            }
            save(&path, &fields)?;
            Ok(Json::object(vec![
                ("stored", Json::Bool(true)),
                ("key", Json::string(key)),
                ("value", value),
            ]))
        }
        _ => match fields.iter().find(|(name, _)| name.as_str() == key) {
            Some((_, value)) => Ok(Json::object(vec![
                ("found", Json::Bool(true)),
                ("key", Json::string(key)),
                ("value", value.clone()),
            ])),
            None => Ok(Json::object(vec![
                ("found", Json::Bool(false)),
                ("key", Json::string(key)),
                ("value", Json::Null),
            ])),
        },
    }
}
