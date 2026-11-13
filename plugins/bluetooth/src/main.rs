#[path = "../../../rust/protocol.rs"]
mod protocol;

use protocol::Json;

const NAME: &str = "bluetooth";
const VERSION: &str = "0.1.0";
const CAPABILITIES: &[&str] = &["bluetooth.scan"];

fn main() {
    protocol::run(NAME, VERSION, CAPABILITIES, invoke);
}

fn invoke(capability: &str, _params: &Json) -> Result<Json, String> {
    match capability {
        "bluetooth.scan" => Ok(Json::object(vec![
            (
                "devices",
                Json::Arr(vec![Json::object(vec![
                    ("id", Json::string("mock-beacon-1")),
                    ("rssi", Json::number("-42")),
                ])]),
            ),
            ("mock", Json::Bool(true)),
        ])),
        other => Err(format!("unknown capability: {other}")),
    }
}
