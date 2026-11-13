#[path = "../../../rust/protocol.rs"]
mod protocol;

use protocol::Json;

const NAME: &str = "geolocation";
const VERSION: &str = "0.1.0";
const CAPABILITIES: &[&str] = &["geolocation.getCurrentPosition"];

fn main() {
    protocol::run(NAME, VERSION, CAPABILITIES, invoke);
}

fn invoke(capability: &str, _params: &Json) -> Result<Json, String> {
    match capability {
        "geolocation.getCurrentPosition" => Ok(Json::object(vec![
            ("latitude", Json::number("37.7749")),
            ("longitude", Json::number("-122.4194")),
            ("accuracy", Json::number("5")),
            ("mock", Json::Bool(true)),
        ])),
        other => Err(format!("unknown capability: {other}")),
    }
}
