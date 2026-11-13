#[path = "../../../rust/protocol.rs"]
mod protocol;

use protocol::Json;

const NAME: &str = "share";
const VERSION: &str = "0.1.0";
const CAPABILITIES: &[&str] = &["share.send"];

fn main() {
    protocol::run(NAME, VERSION, CAPABILITIES, invoke);
}

fn invoke(capability: &str, params: &Json) -> Result<Json, String> {
    match capability {
        "share.send" => {
            let title = params.get("title").and_then(Json::as_str).unwrap_or("");
            let text = params.get("text").and_then(Json::as_str).unwrap_or("");
            Ok(Json::object(vec![
                ("shared", Json::Bool(true)),
                ("target", Json::string("mock-share-sheet")),
                ("title", Json::string(title)),
                ("text", Json::string(text)),
                ("mock", Json::Bool(true)),
            ]))
        }
        other => Err(format!("unknown capability: {other}")),
    }
}
